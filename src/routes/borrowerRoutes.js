import express from 'express';
import bcrypt from 'bcryptjs';
import Customer from '../models/Customer.js';
import Loan from '../models/Loan.js';
import Installment from '../models/Installment.js';
import Transaction from '../models/Transaction.js';
import User from '../models/User.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { generateUPIPaymentOrder } from '../utils/paymentGatewayHelper.js';

const router = express.Router();

/**
 * Helper to compute loan calculations from its installments
 */
async function computeLoanCalculations(loanId, principalAmount, dueCharges = 0, dueChargesPaid = 0, lateCharges = 0, lateChargesPaid = 0, excessAdvanceBalance = 0) {
  const installments = await Installment.find({ loanId });
  
  let totalInterestAccrued = 0;
  let totalInterestPaid = 0;
  let totalPrincipalPaid = 0;
  let totalLateFeePaid = 0;
  let oldestOverdueInst = null;
  const today = new Date();

  installments.forEach(inst => {
    totalInterestAccrued += inst.interestComponent;
    totalInterestPaid += inst.interestPaid || 0;
    totalPrincipalPaid += inst.principalPaid || 0;
    totalLateFeePaid += inst.lateFeePaid || 0;
    
    if (inst.status !== 'paid' && new Date(inst.dueDate) < today) {
      if (!oldestOverdueInst || new Date(inst.dueDate) < new Date(oldestOverdueInst.dueDate)) {
        oldestOverdueInst = inst;
      }
    }
  });

  let overdueDays = 0;
  if (oldestOverdueInst) {
    const diffTime = today.getTime() - new Date(oldestOverdueInst.dueDate).getTime();
    overdueDays = Math.max(0, Math.floor(diffTime / (1000 * 60 * 60 * 24)));
  }

  const outstandingPrincipal = Math.max(0, principalAmount - totalPrincipalPaid);
  const outstandingInterest = Math.max(0, totalInterestAccrued - totalInterestPaid);
  const outstandingDueCharges = Math.max(0, dueCharges - dueChargesPaid);
  const outstandingLateCharges = Math.max(0, lateCharges - lateChargesPaid);
  
  const totalOutstanding = outstandingPrincipal + outstandingInterest + outstandingDueCharges + outstandingLateCharges - excessAdvanceBalance;

  return {
    originalPrincipal: principalAmount,
    currentPrincipal: Math.round(outstandingPrincipal * 100) / 100,
    totalInterestAccrued: Math.round(totalInterestAccrued * 100) / 100,
    totalInterestPaid: Math.round(totalInterestPaid * 100) / 100,
    totalPrincipalPaid: Math.round(totalPrincipalPaid * 100) / 100,
    totalLateFeePaid: Math.round(totalLateFeePaid * 100) / 100,
    outstandingInterest: Math.round(outstandingInterest * 100) / 100,
    outstandingPrincipal: Math.round(outstandingPrincipal * 100) / 100,
    outstandingDueCharges: Math.round(outstandingDueCharges * 100) / 100,
    outstandingLateCharges: Math.round(outstandingLateCharges * 100) / 100,
    excessAdvanceBalance: Math.round(excessAdvanceBalance * 100) / 100,
    totalOutstanding: Math.round(Math.max(0, totalOutstanding) * 100) / 100,
    overdueDays
  };
}

// Apply auth protection
router.use(authMiddleware);

// Ensure the caller is indeed a borrower
router.use((req, res, next) => {
  if (req.admin?.role !== 'borrower') {
    return res.status(403).json({ message: 'Access denied. Client portal resources only.' });
  }
  next();
});

// GET /api/borrower/dashboard - Get profile, active loans, upcoming installments, and payment ledger
router.get('/dashboard', async (req, res) => {
  const customerId = req.admin.id;
  const tenantId = req.admin.tenantId;

  try {
    const borrower = await Customer.findById(customerId).select('-password');
    if (!borrower) {
      return res.status(404).json({ message: 'Borrower profile not found.' });
    }

    const lender = await User.findById(tenantId).select('name businessName phone');
    const loans = await Loan.find({ customerId, tenantId }).sort({ createdAt: -1 });

    const computedLoans = await Promise.all(
      loans.map(async (loan) => {
        const calculations = await computeLoanCalculations(
          loan._id, 
          loan.principalAmount,
          loan.dueCharges,
          loan.dueChargesPaid,
          loan.lateCharges,
          loan.lateChargesPaid,
          loan.excessAdvanceBalance
        );
        return {
          ...loan.toObject(),
          calculations,
        };
      })
    );

    const loanIds = loans.map(l => l._id);
    const installments = await Installment.find({ loanId: { $in: loanIds } }).sort({ dueDate: 1 });
    const transactions = await Transaction.find({ customerId, tenantId }).sort({ paymentDate: -1 });

    res.json({
      borrower,
      lender,
      loans: computedLoans,
      installments,
      transactions,
    });
  } catch (error) {
    console.error('Error fetching borrower dashboard:', error);
    res.status(500).json({ message: 'Dashboard load failure: ' + error.message });
  }
});

// POST /api/borrower/generate-qr - Generate a dynamic UPI QR for an installment using Lender's keys
router.post('/generate-qr', async (req, res) => {
  const customerId = req.admin.id;
  const tenantId = req.admin.tenantId;
  const { loanId, amount, notes } = req.body;

  if (!loanId || !amount) {
    return res.status(400).json({ message: 'loanId and amount are required.' });
  }

  let borrower;
  try {
    borrower = await Customer.findById(customerId);
    if (!borrower) {
      return res.status(404).json({ message: 'Borrower profile not found.' });
    }

    const result = await generateUPIPaymentOrder(tenantId, {
      loanId,
      customerId,
      borrowerName: borrower.name,
      amount,
      paymentType: 'both',
      notes: notes || 'Repayment initiated by borrower via Client Portal',
    });

    res.json(result);
  } catch (err) {
    console.error('Error generating borrower payment QR:', err);
    if (err.message === 'GATEWAY_NOT_CONFIGURED') {
      if (process.env.NODE_ENV !== 'production') {
        return res.json({
          qrCodeId: 'mock_qr_' + Math.random().toString(36).substring(2, 10).toUpperCase(),
          amount: amount,
          qrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(`upi://pay?pa=rahulsharma@razorpay&pn=RinSetu%20CRM&am=${amount}&cu=INR`)}`,
          keyId: 'mock_key',
          currency: 'INR',
          borrowerName: borrower?.name || 'Valued Customer',
        });
      }
      return res.status(422).json({
        message: 'Online payments are currently unavailable. The lender has not configured their payment settings.',
        code: 'GATEWAY_NOT_CONFIGURED',
      });
    }
    const gatewayMessage = err?.error?.description || err?.description || err?.message;
    const isQrUnavailable = /url not found|qr.?code.*(not|unavailable|enabled)|feature/i.test(gatewayMessage || '');
    const isUpiDisabled = /upi transactions are not enabled|upi.*not enabled/i.test(gatewayMessage || '');
    
    if (isUpiDisabled || isQrUnavailable) {
      const User = (await import('../models/User.js')).default;
      const adminUser = await User.findById(tenantId).select('+gatewayKeyId');
      const keyId = adminUser?.gatewayKeyId || process.env.RAZORPAY_KEY_ID || '';
      if (keyId.startsWith('rzp_test') || process.env.NODE_ENV !== 'production') {
        return res.json({
          qrCodeId: 'mock_qr_' + Math.random().toString(36).substring(2, 10).toUpperCase(),
          amount: amount,
          qrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(`upi://pay?pa=rahulsharma@razorpay&pn=RinSetu%20CRM&am=${amount}&cu=INR`)}`,
          keyId: keyId,
          currency: 'INR',
          borrowerName: borrower?.name || 'Valued Customer',
        });
      }
    }

    res.status(500).json({
      message: gatewayMessage || 'Failed to generate payment QR.',
      code: 'QR_GENERATION_FAILED',
    });
  }
});

// GET /api/borrower/check-status/:orderId - Check if a dynamic QR payment was captured
router.get('/check-status/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const tenantId = req.admin.tenantId;

  try {
    const recorded = await Transaction.findOne({
      tenantId,
      $or: [{ razorpayOrderId: orderId }, { razorpayQrCodeId: orderId }],
    });

    if (recorded) {
      return res.json({ status: 'captured', transaction: recorded });
    }
    return res.json({ status: 'pending' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to verify transaction status.' });
  }
});

// PUT /api/borrower/profile - Update credentials (email / password)
router.put('/profile', async (req, res) => {
  const customerId = req.admin.id;
  const { email, password } = req.body;

  try {
    const borrower = await Customer.findById(customerId);
    if (!borrower) {
      return res.status(404).json({ message: 'Borrower profile not found.' });
    }

    if (email && email.trim() !== '') {
      const emailLower = email.trim().toLowerCase();
      // Verify email isn't taken by another borrower
      const duplicate = await Customer.findOne({ email: emailLower, _id: { $ne: customerId } });
      if (duplicate) {
        return res.status(400).json({ message: 'Email address already registered by another borrower.' });
      }
      borrower.email = emailLower;
    }

    if (password && password.trim() !== '') {
      if (password.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
      }
      const salt = await bcrypt.genSalt(10);
      borrower.password = await bcrypt.hash(password.trim(), salt);
    }

    await borrower.save();
    res.json({ message: 'Profile details updated successfully! ✅' });
  } catch (error) {
    console.error('Error updating borrower profile:', error);
    res.status(500).json({ message: 'Profile update failure: ' + error.message });
  }
});

export default router;
