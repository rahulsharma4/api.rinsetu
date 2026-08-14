import express from 'express';
import Transaction from '../models/Transaction.js';
import CashBook from '../models/CashBook.js';
import { rebuildInstallmentPayments } from '../utils/waterfallEngine.js';
import { logAuditAction } from '../utils/auditHelper.js';

const router = express.Router();

// Get all transactions
router.get('/', async (req, res) => {
  const showReversed = req.query.showReversed === 'true';
  const query = showReversed ? { tenantId: req.admin.tenantId } : { isReversed: { $ne: true }, tenantId: req.admin.tenantId };

  try {
    const transactions = await Transaction.find(query)
      .populate('customerId')
      .populate('loanId')
      .sort({ paymentDate: -1 });
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Record a payment (applies waterfall allocation)
router.post('/', async (req, res) => {
  const { loanId, customerId, amount, paymentType, paymentMode, paymentDate, notes } = req.body;

  const transaction = new Transaction({
    loanId,
    customerId,
    amount: parseFloat(amount),
    paymentType: paymentType || 'both',
    paymentMode: paymentMode || 'cash',
    paymentDate: paymentDate || new Date(),
    notes,
    tenantId: req.admin.tenantId,
  });

  try {
    const newTx = await transaction.save();

    // Re-apply waterfall payments logic
    await rebuildInstallmentPayments(loanId);

    const freshTx = await Transaction.findById(newTx._id).populate('customerId');

    // Calculate fresh outstanding principal + interest to send in notification
    const LoanModel = (await import('../models/Loan.js')).default;
    const InstallmentModel = (await import('../models/Installment.js')).default;
    const loanDoc = await LoanModel.findById(loanId);
    const insts = await InstallmentModel.find({ loanId });
    let totalInterestAccrued = 0;
    let totalInterestPaid = 0;
    let totalPrincipalPaid = 0;
    insts.forEach(inst => {
      totalInterestAccrued += inst.interestComponent;
      totalInterestPaid += inst.interestPaid || 0;
      totalPrincipalPaid += inst.principalPaid || 0;
    });
    const outstanding = Math.max(0, loanDoc.principalAmount - totalPrincipalPaid) + Math.max(0, totalInterestAccrued - totalInterestPaid);

    // Queue automated notification receipt
    const { queueNotification } = await import('../utils/notificationCompiler.js');
    await queueNotification(customerId, loanId, 'payment_received', {
      amount: newTx.amount,
      outstanding
    });

    // Audit Log
    await logAuditAction(
      req.admin?.username || 'admin',
      'PAYMENT_RECORDED',
      `Logged repayment receipt of ₹${newTx.amount} for borrower ${freshTx.customerId?.name || 'Borrower'}`,
      null,
      newTx.toObject(),
      req
    );

    res.status(201).json(newTx);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete a transaction (SOFT-DELETES/REVERTS payment allocation)
router.delete('/:id', async (req, res) => {
  try {
    const transaction = await Transaction.findOne({ _id: req.params.id, tenantId: req.admin.tenantId }).populate('customerId');
    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    if (transaction.isReversed) {
      return res.status(400).json({ message: 'This transaction is already reversed.' });
    }

    const loanId = transaction.loanId;
    const oldValue = transaction.toObject();

    // Soft-delete: Mark as reversed
    transaction.isReversed = true;
    transaction.notes = (transaction.notes || '') + ` [REVERSED by admin on ${new Date().toLocaleDateString('en-IN')}]`;
    await transaction.save();

    // Revert Cash Book log
    await CashBook.deleteOne({ transactionId: transaction._id });

    // Recalculate all installment payments from scratch
    await rebuildInstallmentPayments(loanId);

    // Audit Log
    await logAuditAction(
      req.admin?.username || 'admin',
      'PAYMENT_REVERSED',
      `Reversed repayment receipt of ₹${transaction.amount} for borrower: ${transaction.customerId?.name || 'Borrower'}`,
      oldValue,
      transaction.toObject(),
      req
    );

    res.json({ message: 'Transaction reversed and loan schedule updated.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
