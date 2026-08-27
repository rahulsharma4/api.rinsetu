import express from 'express';
import Loan from '../models/Loan.js';
import Installment from '../models/Installment.js';
import Transaction from '../models/Transaction.js';
import { updateOverdueStatuses } from '../utils/overdueTracker.js';
import { generateRepaymentSchedule } from '../utils/scheduleGenerator.js';
import { restructureLoan } from '../utils/restructuringHelper.js';
import { logAuditAction } from '../utils/auditHelper.js';

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

// Get all loans (with calculated balances)
router.get('/', async (req, res) => {
  try {
    await updateOverdueStatuses();
    const loans = await Loan.find({ tenantId: req.admin.tenantId }).populate('customerId').sort({ createdAt: -1 });
    
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
    
    res.json(computedLoans);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get a single loan (with calculations)
router.get('/:id', async (req, res) => {
  try {
    const loan = await Loan.findOne({ _id: req.params.id, tenantId: req.admin.tenantId }).populate('customerId');
    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const transactions = await Transaction.find({ loanId: loan._id, tenantId: req.admin.tenantId }).sort({ paymentDate: -1 });
    const calculations = await computeLoanCalculations(
      loan._id, 
      loan.principalAmount,
      loan.dueCharges,
      loan.dueChargesPaid,
      loan.lateCharges,
      loan.lateChargesPaid,
      loan.excessAdvanceBalance
    );

    res.json({
      ...loan.toObject(),
      transactions,
      calculations,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get installments schedule for a specific loan
router.get('/:id/installments', async (req, res) => {
  try {
    const loan = await Loan.findOne({ _id: req.params.id, tenantId: req.admin.tenantId });
    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }
    const installments = await Installment.find({ loanId: req.params.id }).sort({ installmentNumber: 1 });
    res.json(installments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create a new loan & auto-generate repayment installments
router.post('/', async (req, res) => {
  const {
    customerId,
    principalAmount,
    processingFee,
    interestRate,
    rateType,
    interestType,
    compoundingPeriod,
    paymentFrequency,
    startDate,
    tenure,
    dueCharges,
    lateCharges,
    lateFeeRate,
    lateFeeType,
    remarks,
    isExistingLoan,
    alreadyPaidInstallments,
    skipCashBookOutflow,
    dayCountBasis,
    gracePeriodDays,
    holidayRule,
    upfrontDeduction,
    deductionType,
    deductionAmount,
    doubleCollectionOnMonday,
  } = req.body;

  const numPaidInst = isExistingLoan ? Math.max(0, parseInt(alreadyPaidInstallments || 0)) : 0;

  const loan = new Loan({
    customerId,
    principalAmount: parseFloat(principalAmount),
    processingFee: processingFee ? parseFloat(processingFee) : 0,
    interestRate: parseFloat(interestRate),
    rateType,
    interestType,
    compoundingPeriod: compoundingPeriod || 'none',
    paymentFrequency,
    startDate,
    tenure: parseInt(tenure),
    dueCharges: dueCharges ? parseFloat(dueCharges) : 0,
    lateCharges: lateCharges ? parseFloat(lateCharges) : 0,
    lateFeeRate: lateFeeRate !== undefined ? parseFloat(lateFeeRate) : 50,
    lateFeeType: lateFeeType || 'daily',
    remarks,
    isExistingLoan: !!isExistingLoan,
    alreadyPaidInstallments: numPaidInst,
    skipCashBookOutflow: isExistingLoan ? (skipCashBookOutflow !== false) : false,
    dayCountBasis: dayCountBasis || '30_360',
    gracePeriodDays: gracePeriodDays !== undefined ? parseInt(gracePeriodDays) : 0,
    holidayRule: holidayRule || 'none',
    upfrontDeduction: !!upfrontDeduction,
    deductionType: deductionType || 'flat',
    deductionAmount: deductionAmount ? parseFloat(deductionAmount) : 0,
    doubleCollectionOnMonday: !!doubleCollectionOnMonday,
    tenantId: req.admin.tenantId,
  });

  try {
    const newLoan = await loan.save();
    const schedule = generateRepaymentSchedule(newLoan);
    const today = new Date();

    const installmentDocs = schedule.map((item, index) => {
      const isPaidHistorical = isExistingLoan && (index < numPaidInst);
      return {
        loanId: newLoan._id,
        ...item,
        amountPaid: isPaidHistorical ? item.totalAmount : 0,
        principalPaid: isPaidHistorical ? item.principalComponent : 0,
        interestPaid: isPaidHistorical ? item.interestComponent : 0,
        status: isPaidHistorical ? 'paid' : (new Date(item.dueDate) < today ? 'overdue' : 'unpaid'),
        lastPaymentDate: isPaidHistorical ? item.dueDate : null,
      };
    });
    await Installment.insertMany(installmentDocs);

    // If all installments are already paid, set loan status to 'closed'
    if (numPaidInst >= schedule.length && schedule.length > 0) {
      newLoan.status = 'closed';
      newLoan.closureDate = new Date();
      await newLoan.save();
    }

    // Write to Cash Book double-entry system (outflow) unless skipped for existing loans
    if (!newLoan.skipCashBookOutflow) {
      const CashBook = (await import('../models/CashBook.js')).default;
      let disbursementAmount = newLoan.principalAmount;
      let note = `Auto-recorded loan disbursement for Agreement #${newLoan._id.toString().slice(-6)}`;

      if (newLoan.upfrontDeduction) {
        let deduction = 0;
        if (newLoan.deductionType === 'percent') {
          deduction = Math.round((newLoan.principalAmount * (newLoan.deductionAmount / 100)) * 100) / 100;
        } else {
          deduction = newLoan.deductionAmount;
        }
        disbursementAmount = Math.max(0, newLoan.principalAmount - deduction);
        note += ` (Upfront deduction of ₹${deduction.toLocaleString('en-IN')} applied)`;
      }

      await CashBook.create({
        paymentDate: newLoan.startDate || new Date(),
        type: 'disbursement',
        amount: disbursementAmount,
        paymentMode: 'cash', // Default to cash disbursement
        customerId: newLoan.customerId,
        loanId: newLoan._id,
        notes: note,
        tenantId: req.admin.tenantId,
      });
    }

    // Audit Log
    await logAuditAction(
      req.admin?.username || 'admin',
      'LOAN_CREATED',
      `Disbursed ${isExistingLoan ? 'existing running' : 'new'} loan of ₹${newLoan.principalAmount} (${numPaidInst} past EMIs pre-paid) for customer ID: ${customerId}`,
      null,
      newLoan.toObject(),
      req
    );

    res.status(201).json(newLoan);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Restructure an active loan disburse
router.post('/:id/restructure', async (req, res) => {
  const {
    interestRate,
    rateType,
    paymentFrequency,
    tenure,
    remarks
  } = req.body;

  try {
    const originalLoan = await Loan.findOne({ _id: req.params.id, tenantId: req.admin.tenantId });
    if (!originalLoan) {
      return res.status(404).json({ message: 'Loan not found' });
    }
    const restructuredLoan = await restructureLoan(
      req.params.id,
      parseFloat(interestRate),
      rateType,
      paymentFrequency,
      parseInt(tenure),
      remarks
    );

    // Audit Log
    await logAuditAction(
      req.admin?.username || 'admin',
      'LOAN_RESTRUCTURED',
      `Restructured Loan Account #${originalLoan._id.toString().slice(-6)} into new Restructured Loan Account #${restructuredLoan._id.toString().slice(-6)}`,
      originalLoan.toObject(),
      restructuredLoan.toObject(),
      req
    );

    res.status(201).json(restructuredLoan);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update a loan (status or remarks)
router.put('/:id', async (req, res) => {
  try {
    const loan = await Loan.findOne({ _id: req.params.id, tenantId: req.admin.tenantId });
    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const oldValue = loan.toObject();
    const { status, remarks, dueCharges, lateCharges, lateFeeRate, lateFeeType } = req.body;
    if (status) loan.status = status;
    if (remarks !== undefined) loan.remarks = remarks;
    if (dueCharges !== undefined) loan.dueCharges = parseFloat(dueCharges);
    if (lateCharges !== undefined) loan.lateCharges = parseFloat(lateCharges);
    if (lateFeeRate !== undefined) loan.lateFeeRate = parseFloat(lateFeeRate);
    if (lateFeeType !== undefined) loan.lateFeeType = lateFeeType;

    const updatedLoan = await loan.save();

    // Audit Log
    await logAuditAction(
      req.admin?.username || 'admin',
      'LOAN_UPDATED',
      `Updated loan details for Loan ID: ${updatedLoan._id}`,
      oldValue,
      updatedLoan.toObject(),
      req
    );

    res.json(updatedLoan);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete a loan (Cascade deletes installments and transactions)
router.delete('/:id', async (req, res) => {
  try {
    const loan = await Loan.findOne({ _id: req.params.id, tenantId: req.admin.tenantId });
    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const oldValue = loan.toObject();
    await Installment.deleteMany({ loanId: loan._id });
    await Transaction.deleteMany({ loanId: loan._id });

    // Also delete CashBook logs for this loan (both disbursements and collections)
    const CashBook = (await import('../models/CashBook.js')).default;
    await CashBook.deleteMany({ loanId: loan._id });

    await Loan.deleteOne({ _id: loan._id });

    // Audit Log
    await logAuditAction(
      req.admin?.username || 'admin',
      'LOAN_DELETED',
      `Permanently deleted loan file of ₹${loan.principalAmount} (and all EMIs/payments cascaded)`,
      oldValue,
      null,
      req
    );

    res.json({ message: 'Loan, installments, and payment ledger entries deleted.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
