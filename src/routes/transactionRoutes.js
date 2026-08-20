import express from 'express';
import Transaction from '../models/Transaction.js';
import CashBook from '../models/CashBook.js';
import { rebuildInstallmentPayments } from '../utils/waterfallEngine.js';
import { logAuditAction } from '../utils/auditHelper.js';
import { generateUPIPaymentOrder } from '../utils/paymentGatewayHelper.js';
import Razorpay from 'razorpay';
import User from '../models/User.js';

const router = express.Router();

// ─── POST /api/transactions/generate-qr ─────────────────────────────────────
// Creates a Razorpay UPI payment order for a specific loan repayment.
// Returns orderId + UPI intent URL which the frontend renders as a QR code.
router.post('/generate-qr', async (req, res) => {
  const { loanId, customerId, borrowerName, amount, paymentType, notes } = req.body;

  if (!loanId || !customerId || !amount) {
    return res.status(400).json({ message: 'loanId, customerId, and amount are required.' });
  }

  try {
    const result = await generateUPIPaymentOrder(req.admin.tenantId, {
      loanId,
      customerId,
      borrowerName,
      amount,
      paymentType: paymentType || 'both',
      notes,
    });
    res.json(result);
  } catch (err) {
    if (err.message === 'GATEWAY_NOT_CONFIGURED') {
      if (process.env.NODE_ENV !== 'production') {
        return res.json({
          qrCodeId: 'mock_qr_' + Math.random().toString(36).substring(2, 10).toUpperCase(),
          amount: amount,
          qrImageUrl: 'simulated_qr_url',
          keyId: 'mock_key',
          currency: 'INR',
          borrowerName,
        });
      }
      return res.status(422).json({
        message: 'Payment gateway not configured. Please add your Razorpay API keys in Settings → Payment Settings.',
        code: 'GATEWAY_NOT_CONFIGURED',
      });
    }
    const gatewayMessage = err?.error?.description || err?.description || err?.message;
    const isQrUnavailable = /url not found|qr.?code.*(not|unavailable|enabled)|feature/i.test(gatewayMessage || '');
    const isUpiDisabled = /upi transactions are not enabled|upi.*not enabled/i.test(gatewayMessage || '');
    res.status(isQrUnavailable || isUpiDisabled ? 503 : 500).json({
      message: isUpiDisabled
        ? 'UPI payments are not enabled for this Razorpay merchant account. Activate UPI in Razorpay Dashboard or contact Razorpay Support, then try again.'
        : isQrUnavailable
        ? 'Razorpay QR Codes API is not enabled for this account. Please ask Razorpay Support to activate Dynamic UPI QR Codes, then try again.'
        : (gatewayMessage || 'Failed to generate payment QR.'),
      code: isUpiDisabled ? 'UPI_NOT_ENABLED' : (isQrUnavailable ? 'QR_API_NOT_ENABLED' : 'QR_GENERATION_FAILED'),
    });
  }
});

// ─── GET /api/transactions/check-status/:orderId ─────────────────────────────
// Frontend polls this every few seconds to check if the UPI payment was completed.
// Once the webhook auto-records it, this will return status: 'captured'.
router.get('/check-status/:orderId', async (req, res) => {
  const { orderId } = req.params;
  try {
    // Check if webhook has already recorded this payment
    const recorded = await Transaction.findOne({
      $or: [{ razorpayOrderId: orderId }, { razorpayQrCodeId: orderId }],
      tenantId: req.admin.tenantId,
    });

    if (recorded) {
      return res.json({ status: 'captured', transactionId: recorded._id, amount: recorded.amount });
    }

    // Poll the Razorpay QR itself while the webhook is in flight.
    try {
      const adminUser = await User.findById(req.admin.tenantId).select('+gatewayKeyId +gatewayKeySecret');
      if (adminUser?.gatewayKeyId && adminUser?.gatewayKeySecret) {
        const rzp = new Razorpay({ key_id: adminUser.gatewayKeyId, key_secret: adminUser.gatewayKeySecret });
        const qrCode = await rzp.qrCode.fetch(orderId);
        if (Number(qrCode.payments_count_received) > 0 || Number(qrCode.payments_amount_received) > 0) {
          return res.json({ status: 'captured', razorpayStatus: qrCode.status });
        }
        return res.json({ status: 'pending', razorpayStatus: qrCode.status });
      }
    } catch (_) {
      // Gracefully fall through if Razorpay fetch fails
    }

    res.json({ status: 'pending' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});



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
