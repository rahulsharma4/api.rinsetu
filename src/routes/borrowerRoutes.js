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

    const loanIds = loans.map(l => l._id);
    const installments = await Installment.find({ loanId: { $in: loanIds } }).sort({ dueDate: 1 });
    const transactions = await Transaction.find({ customerId, tenantId }).sort({ paymentDate: -1 });

    res.json({
      borrower,
      lender,
      loans,
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

  try {
    const borrower = await Customer.findById(customerId);
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
      return res.status(422).json({
        message: 'Online payments are currently unavailable. The lender has not configured their payment settings.',
        code: 'GATEWAY_NOT_CONFIGURED',
      });
    }
    const gatewayMessage = err?.error?.description || err?.description || err?.message;
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
