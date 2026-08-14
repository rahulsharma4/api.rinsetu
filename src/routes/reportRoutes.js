import express from 'express';
import Loan from '../models/Loan.js';
import Installment from '../models/Installment.js';
import Transaction from '../models/Transaction.js';
import Customer from '../models/Customer.js';
import CashBook from '../models/CashBook.js';
import { getDailyDashboardSummary, getEndOfDayCollectionSummary } from '../utils/summaryHelper.js';
import { detectSystemAnomalies } from '../utils/anomalyDetector.js';

const router = express.Router();

// GET /api/reports/summary - Complete business summary
router.get('/summary', async (req, res) => {
  try {
    const tenantId = req.admin.tenantId;
    const loans = await Loan.find({ tenantId }).populate('customerId');
    const transactions = await Transaction.find({ tenantId }).sort({ paymentDate: 1 });
    const customers = await Customer.find({ tenantId });
    const loanIds = loans.map(l => l._id);
    const installments = await Installment.find({ loanId: { $in: loanIds } });

    const totalLoans = loans.length;
    const activeLoans = loans.filter(l => l.status === 'active').length;
    const overdueLoans = loans.filter(l => l.status === 'overdue').length;
    const paidLoans = loans.filter(l => l.status === 'paid').length;

    const totalDisbursed = loans.reduce((acc, l) => acc + l.principalAmount, 0);
    const totalCollected = transactions.reduce((acc, t) => acc + t.amount, 0);

    const overdueInstallments = installments.filter(i => i.status === 'overdue');
    const totalOverdueAmount = overdueInstallments.reduce((acc, i) => acc + (i.totalAmount - i.amountPaid), 0);

    const monthlyData = {};
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleString('en-IN', { month: 'short', year: '2-digit' });
      monthlyData[key] = { label, collected: 0, interest: 0, principal: 0 };
    }

    transactions.forEach(tx => {
      const d = new Date(tx.paymentDate);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (monthlyData[key] !== undefined) {
        monthlyData[key].collected += tx.amount;
        if (tx.paymentType === 'interest') monthlyData[key].interest += tx.amount;
        else if (tx.paymentType === 'principal') monthlyData[key].principal += tx.amount;
        else {
          monthlyData[key].interest += tx.amount * 0.5;
          monthlyData[key].principal += tx.amount * 0.5;
        }
      }
    });

    const loanCalcs = await Promise.all(loans.map(async (loan) => {
      const insts = await Installment.find({ loanId: loan._id });
      let outstanding = 0;
      insts.forEach(i => { outstanding += (i.totalAmount - i.amountPaid); });
      return {
        customerId: loan.customerId?._id,
        customerName: loan.customerId?.name,
        customerPhone: loan.customerId?.phone,
        loanId: loan._id,
        principal: loan.principalAmount,
        outstanding: Math.max(0, outstanding),
        status: loan.status
      };
    }));

    const topBorrowers = loanCalcs
      .filter(l => l.outstanding > 0)
      .sort((a, b) => b.outstanding - a.outstanding)
      .slice(0, 5);

    res.json({
      overview: {
        totalCustomers: customers.length,
        totalLoans,
        activeLoans,
        overdueLoans,
        paidLoans,
        totalDisbursed,
        totalCollected,
        totalOverdueAmount,
        collectionRate: totalDisbursed > 0 ? Math.round((totalCollected / totalDisbursed) * 100) : 0
      },
      monthlyChart: Object.values(monthlyData),
      topBorrowers
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/reports/daily-summary - Morning summary
router.get('/daily-summary', async (req, res) => {
  try {
    const summary = await getDailyDashboardSummary(req.admin.tenantId);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/reports/eod-summary - Evening collection stats
router.get('/eod-summary', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const eod = await getEndOfDayCollectionSummary(req.admin.tenantId, startDate, endDate);
    res.json(eod);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/reports/anomalies - Audit checklist flags
router.get('/anomalies', async (req, res) => {
  try {
    const anomalies = await detectSystemAnomalies(req.admin.tenantId);
    res.json(anomalies);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/reports/cashbook - Cash book drawer balance ledger
router.get('/cashbook', async (req, res) => {
  try {
    const entries = await CashBook.find({ tenantId: req.admin.tenantId }).populate('customerId').sort({ paymentDate: -1 });
    
    // Calculate total sums for Opening, collections, and disbursements
    let openingBalance = 0;
    let collectionsCash = 0;
    let collectionsUPI = 0;
    let collectionsBank = 0;
    let collectionsCheque = 0;
    
    let disbursementsCash = 0;
    let disbursementsUPI = 0;
    let disbursementsBank = 0;
    
    let expenses = 0;

    entries.forEach(entry => {
      if (entry.type === 'opening_balance') {
        openingBalance += entry.amount;
      } 
      else if (entry.type === 'collection') {
        if (entry.paymentMode === 'cash') collectionsCash += entry.amount;
        else if (entry.paymentMode === 'online') collectionsUPI += entry.amount;
        else if (entry.paymentMode === 'bank_transfer') collectionsBank += entry.amount;
        else collectionsCheque += entry.amount;
      } 
      else if (entry.type === 'disbursement') {
        if (entry.paymentMode === 'cash') disbursementsCash += entry.amount;
        else if (entry.paymentMode === 'online') disbursementsUPI += entry.amount;
        else disbursementsBank += entry.amount;
      } 
      else if (entry.type === 'expense') {
        expenses += entry.amount;
      }
    });

    const totalCollected = collectionsCash + collectionsUPI + collectionsBank + collectionsCheque;
    const totalDisbursed = disbursementsCash + disbursementsUPI + disbursementsBank;
    const closingBalance = openingBalance + totalCollected - totalDisbursed - expenses;

    res.json({
      entries,
      summary: {
        openingBalance,
        closingBalance,
        totalCollected,
        totalDisbursed,
        expenses,
        collectionsSplit: {
          cash: collectionsCash,
          upi: collectionsUPI,
          bank: collectionsBank,
          cheque: collectionsCheque
        },
        disbursementsSplit: {
          cash: disbursementsCash,
          upi: disbursementsUPI,
          bank: disbursementsBank
        }
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// POST /api/reports/cashbook - Create manual cash book ledger items
router.post('/cashbook', async (req, res) => {
  const { paymentDate, type, amount, paymentMode, notes } = req.body;
  const entry = new CashBook({
    paymentDate: paymentDate || new Date(),
    type,
    amount: parseFloat(amount),
    paymentMode: paymentMode || 'cash',
    notes,
    tenantId: req.admin.tenantId,
  });

  try {
    const saved = await entry.save();
    res.status(201).json(saved);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// DELETE /api/reports/cashbook/:id - Revert manual cash book item
router.delete('/cashbook/:id', async (req, res) => {
  try {
    const entry = await CashBook.findOne({ _id: req.params.id, tenantId: req.admin.tenantId });
    if (!entry) return res.status(404).json({ message: 'Entry not found' });
    
    if (entry.transactionId || entry.loanId) {
      return res.status(400).json({ message: 'Cannot delete automated entries. Revert from loan/payment timeline instead.' });
    }

    await CashBook.deleteOne({ _id: entry._id });
    res.json({ message: 'Entry deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
