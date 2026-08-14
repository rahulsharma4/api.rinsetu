import express from 'express';
import Installment from '../models/Installment.js';
import Loan from '../models/Loan.js';
import Customer from '../models/Customer.js';

const router = express.Router();

// GET /api/collection/today - Aaj ki due installments
router.get('/today', async (req, res) => {
  try {
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    const tenantLoans = await Loan.find({ tenantId: req.admin.tenantId }).select('_id');
    const loanIds = tenantLoans.map(l => l._id);

    const todayInstallments = await Installment.find({
      loanId: { $in: loanIds },
      dueDate: { $gte: startOfDay, $lt: endOfDay },
      status: { $in: ['unpaid', 'partially_paid', 'overdue'] }
    }).populate({ path: 'loanId', populate: { path: 'customerId' } });

    const result = todayInstallments.map(inst => ({
      installmentId: inst._id,
      installmentNumber: inst.installmentNumber,
      dueDate: inst.dueDate,
      totalAmount: inst.totalAmount,
      amountPaid: inst.amountPaid,
      remaining: inst.totalAmount - inst.amountPaid,
      status: inst.status,
      loan: {
        _id: inst.loanId?._id,
        principalAmount: inst.loanId?.principalAmount,
        interestRate: inst.loanId?.interestRate,
        rateType: inst.loanId?.rateType,
      },
      customer: {
        _id: inst.loanId?.customerId?._id,
        name: inst.loanId?.customerId?.name,
        phone: inst.loanId?.customerId?.phone,
      }
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/collection/upcoming - Agle 7 din ki dues
router.get('/upcoming', async (req, res) => {
  try {
    const today = new Date();
    const sevenDaysLater = new Date();
    sevenDaysLater.setDate(today.getDate() + 7);

    const startOfTomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    const tenantLoans = await Loan.find({ tenantId: req.admin.tenantId }).select('_id');
    const loanIds = tenantLoans.map(l => l._id);

    const upcomingInstallments = await Installment.find({
      loanId: { $in: loanIds },
      dueDate: { $gte: startOfTomorrow, $lte: sevenDaysLater },
      status: { $in: ['unpaid', 'partially_paid'] }
    }).populate({ path: 'loanId', populate: { path: 'customerId' } })
      .sort({ dueDate: 1 });

    const result = upcomingInstallments.map(inst => ({
      installmentId: inst._id,
      installmentNumber: inst.installmentNumber,
      dueDate: inst.dueDate,
      totalAmount: inst.totalAmount,
      amountPaid: inst.amountPaid,
      remaining: inst.totalAmount - inst.amountPaid,
      status: inst.status,
      daysLeft: Math.ceil((new Date(inst.dueDate) - today) / (1000 * 60 * 60 * 24)),
      loan: { _id: inst.loanId?._id },
      customer: {
        _id: inst.loanId?.customerId?._id,
        name: inst.loanId?.customerId?.name,
        phone: inst.loanId?.customerId?.phone,
      }
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/collection/overdue - Saare overdue installments
router.get('/overdue', async (req, res) => {
  try {
    const tenantLoans = await Loan.find({ tenantId: req.admin.tenantId }).select('_id');
    const loanIds = tenantLoans.map(l => l._id);

    const overdueInstallments = await Installment.find({
      loanId: { $in: loanIds },
      status: 'overdue'
    }).populate({ path: 'loanId', populate: { path: 'customerId' } })
      .sort({ dueDate: 1 });

    const today = new Date();
    const result = overdueInstallments.map(inst => ({
      installmentId: inst._id,
      installmentNumber: inst.installmentNumber,
      dueDate: inst.dueDate,
      totalAmount: inst.totalAmount,
      amountPaid: inst.amountPaid,
      remaining: inst.totalAmount - inst.amountPaid,
      status: inst.status,
      overdueDays: Math.floor((today - new Date(inst.dueDate)) / (1000 * 60 * 60 * 24)),
      loan: { _id: inst.loanId?._id, principalAmount: inst.loanId?.principalAmount },
      customer: {
        _id: inst.loanId?.customerId?._id,
        name: inst.loanId?.customerId?.name,
        phone: inst.loanId?.customerId?.phone,
        address: inst.loanId?.customerId?.address,
      }
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
