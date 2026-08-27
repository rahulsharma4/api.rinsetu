import express from 'express';
import Loan from '../models/Loan.js';
import User from '../models/User.js';
import Transaction from '../models/Transaction.js';

const router = express.Router();

// Helper to obfuscate name (e.g. "Rahul Sharma" -> "Rahul S.")
function obfuscateName(name) {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

// GET /api/public/pay-details/:loanId
router.get('/pay-details/:loanId', async (req, res) => {
  try {
    const loan = await Loan.findById(req.params.loanId)
      .populate('customerId')
      .populate('tenantId');

    if (!loan) {
      return res.status(404).json({ message: 'Lending agreement file not found.' });
    }

    const lender = loan.tenantId;
    if (!lender) {
      return res.status(404).json({ message: 'Lender profile details missing.' });
    }

    // Verify if lender has direct VPA set up
    if (!lender.upiId) {
      return res.status(422).json({
        message: 'Direct P2P UPI payments are not configured by the lender yet.',
        code: 'UPI_NOT_CONFIGURED'
      });
    }

    // Calculate live dues
    const Installment = (await import('../models/Installment.js')).default;
    const installments = await Installment.find({ loanId: loan._id });
    
    let totalOutstanding = 0;
    let nextDueAmount = 0;
    let nextDueDate = null;

    const unpaid = installments.filter(inst => inst.status !== 'paid');
    unpaid.sort((a, b) => a.installmentNumber - b.installmentNumber);

    unpaid.forEach(inst => {
      totalOutstanding += (inst.totalAmount - inst.amountPaid);
    });

    if (unpaid.length > 0) {
      nextDueAmount = unpaid[0].totalAmount - unpaid[0].amountPaid;
      nextDueDate = unpaid[0].dueDate;
    }

    res.json({
      borrowerName: obfuscateName(loan.customerId?.name || 'Borrower'),
      lenderBusinessName: lender.businessName || 'RinSetu Lender',
      loanNumber: loan.loanNumber || 'Active File',
      upiId: lender.upiId,
      upiName: lender.upiName || lender.businessName || 'RinSetu Repayment',
      loanId: loan._id,
      totalOutstanding: Math.round(totalOutstanding * 100) / 100,
      nextDueAmount: Math.round(nextDueAmount * 100) / 100,
      nextDueDate: nextDueDate ? nextDueDate.toISOString() : null
    });
  } catch (err) {
    console.error('Error fetching public payment details:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// POST /api/public/submit-p2p-reference
router.post('/submit-p2p-reference', async (req, res) => {
  const { loanId, amount, referenceNumber, notes } = req.body;

  if (!loanId || !amount || !referenceNumber) {
    return res.status(400).json({ message: 'loanId, amount, and referenceNumber are required.' });
  }

  try {
    const loan = await Loan.findById(loanId);
    if (!loan) {
      return res.status(404).json({ message: 'Loan file not found.' });
    }

    const tenantId = loan.tenantId;
    const customerId = loan.customerId;
    const refNum = referenceNumber.trim();

    // Check for duplicate UTR submissions
    const existing = await Transaction.findOne({
      tenantId,
      razorpayPaymentId: refNum
    });
    if (existing) {
      return res.status(400).json({ message: 'This Transaction Reference Number (UTR) has already been submitted or approved.' });
    }

    const transaction = new Transaction({
      loanId,
      customerId,
      amount: parseFloat(amount),
      paymentType: 'both',
      paymentMode: 'upi',
      paymentDate: new Date(),
      notes: notes || `Public P2P UPI Payment submitted by borrower.`,
      razorpayPaymentId: refNum,
      status: 'pending',
      tenantId,
    });

    await transaction.save();

    res.json({ message: 'Repayment reference UTR submitted successfully! Verification pending approval by lender. ✅' });
  } catch (error) {
    console.error('Error submitting public P2P reference:', error);
    res.status(500).json({ message: 'Failed to submit payment reference: ' + error.message });
  }
});

export default router;
