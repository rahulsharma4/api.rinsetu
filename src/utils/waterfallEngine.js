import Installment from '../models/Installment.js';
import Transaction from '../models/Transaction.js';
import Loan from '../models/Loan.js';
import Settings from '../models/Settings.js';
import CashBook from '../models/CashBook.js';

function updateInstallmentStatus(inst) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  if (inst.amountPaid >= (inst.totalAmount - 0.01)) {
    inst.status = 'paid';
  } else if (inst.amountPaid > 0) {
    inst.status = 'partially_paid';
  } else {
    if (new Date(inst.dueDate) < startOfDay) {
      inst.status = 'overdue';
    } else {
      inst.status = 'unpaid';
    }
  }
}

/**
 * Re-applies a single transaction to the installment schedule of a loan.
 * 
 * @param {ObjectId} loanId - The ID of the loan
 * @param {Number} amount - The transaction amount
 * @param {String} paymentType - 'both', 'interest', 'principal', 'excess_prepay', 'late_charges'
 * @param {Date} paymentDate - The payment timestamp
 * @param {ObjectId} transactionId - Optional reference transaction ID
 */
export async function allocatePaymentWaterfall(loanId, amount, paymentType = 'both', paymentDate = new Date(), transactionId = null) {
  let remaining = amount;
  
  const loan = await Loan.findById(loanId);
  if (!loan) throw new Error('Loan not found');

  const settings = await Settings.findOne();
  const priority = settings?.waterfallPriority || ['dueCharges', 'lateCharges', 'interest', 'principal'];

  let allocatedPrincipal = 0;
  let allocatedInterest = 0;
  let allocatedLateFee = 0;
  let allocatedDueCharges = 0;

  // 1. Specific component overrides
  if (paymentType === 'interest') {
    const installments = await Installment.find({ loanId, status: { $ne: 'paid' } }).sort({ installmentNumber: 1 });
    for (const inst of installments) {
      if (remaining <= 0) break;
      const interestDue = inst.interestComponent - inst.interestPaid;
      if (interestDue > 0) {
        const alloc = Math.min(remaining, interestDue);
        inst.interestPaid += alloc;
        inst.amountPaid += alloc;
        allocatedInterest += alloc;
        remaining -= alloc;
        inst.lastPaymentDate = paymentDate;
        updateInstallmentStatus(inst);
        await inst.save();
      }
    }
  } 
  else if (paymentType === 'principal') {
    const installments = await Installment.find({ loanId, status: { $ne: 'paid' } }).sort({ installmentNumber: 1 });
    for (const inst of installments) {
      if (remaining <= 0) break;
      const principalDue = inst.principalComponent - inst.principalPaid;
      if (principalDue > 0) {
        const alloc = Math.min(remaining, principalDue);
        inst.principalPaid += alloc;
        inst.amountPaid += alloc;
        allocatedPrincipal += alloc;
        remaining -= alloc;
        inst.lastPaymentDate = paymentDate;
        updateInstallmentStatus(inst);
        await inst.save();
      }
    }
  } 
  else if (paymentType === 'late_charges') {
    const lateChargesOutstanding = loan.lateCharges - loan.lateChargesPaid;
    if (lateChargesOutstanding > 0 && remaining > 0) {
      const alloc = Math.min(remaining, lateChargesOutstanding);
      loan.lateChargesPaid += alloc;
      allocatedLateFee += alloc;
      remaining -= alloc;
    }
  }
  // 2. Default Configured Waterfall Allocation (Chronological EMI Order: Pay Interest + Principal of EMI #1 before moving to EMI #2)
  else {
    // 2a. Pay loan-level due charges and late charges first
    const dueChargesOutstanding = loan.dueCharges - loan.dueChargesPaid;
    if (dueChargesOutstanding > 0 && remaining > 0) {
      const alloc = Math.min(remaining, dueChargesOutstanding);
      loan.dueChargesPaid += alloc;
      allocatedDueCharges += alloc;
      remaining -= alloc;
    }

    const lateChargesOutstanding = loan.lateCharges - loan.lateChargesPaid;
    if (lateChargesOutstanding > 0 && remaining > 0) {
      const alloc = Math.min(remaining, lateChargesOutstanding);
      loan.lateChargesPaid += alloc;
      allocatedLateFee += alloc;
      remaining -= alloc;
    }

    // 2b. Pay installments in chronological order (EMI #1 interest & principal, then EMI #2, etc.)
    if (remaining > 0) {
      const installments = await Installment.find({ loanId, status: { $ne: 'paid' } }).sort({ installmentNumber: 1 });
      for (const inst of installments) {
        if (remaining <= 0) break;

        // First pay interest component of THIS installment
        const interestDue = inst.interestComponent - inst.interestPaid;
        if (interestDue > 0 && remaining > 0) {
          const alloc = Math.min(remaining, interestDue);
          inst.interestPaid += alloc;
          inst.amountPaid += alloc;
          allocatedInterest += alloc;
          remaining -= alloc;
        }

        // Second pay principal component of THIS installment
        const principalDue = inst.principalComponent - inst.principalPaid;
        if (principalDue > 0 && remaining > 0) {
          const alloc = Math.min(remaining, principalDue);
          inst.principalPaid += alloc;
          inst.amountPaid += alloc;
          allocatedPrincipal += alloc;
          remaining -= alloc;
        }

        inst.lastPaymentDate = paymentDate;
        updateInstallmentStatus(inst);
        await inst.save();
      }
    }
  }

  // 3. Excess Advance Payment Handling
  if (remaining > 0) {
    loan.excessAdvanceBalance += remaining;
    remaining = 0;
  }

  await loan.save();

  // Simple Interest Dynamic Recalculation (केवल ब्याज - घटते मूलधन पर)
  if (loan.interestType === 'simple' && allocatedPrincipal > 0) {
    const { getPeriodicRate } = await import('./scheduleGenerator.js');
    const r = getPeriodicRate(loan.interestRate, loan.rateType, loan.paymentFrequency, loan.dayCountBasis);
    
    const allInsts = await Installment.find({ loanId }).sort({ installmentNumber: 1 });
    let totalPPaid = 0;
    allInsts.forEach(inst => {
      totalPPaid += inst.principalPaid;
    });
    
    const remainingPrincipal = Math.max(0, loan.principalAmount - totalPPaid);
    
    for (const inst of allInsts) {
      if (inst.status !== 'paid') {
        const newInterest = Math.round((remainingPrincipal * r) * 100) / 100;
        inst.interestComponent = newInterest;
        
        // If it is the last installment, update its principal component to match the remaining principal
        if (inst.installmentNumber === allInsts.length) {
          inst.principalComponent = Math.round(remainingPrincipal * 100) / 100;
        }
        
        inst.totalAmount = Math.round((inst.principalComponent + inst.interestComponent) * 100) / 100;
        updateInstallmentStatus(inst);
        await inst.save();
      }
    }
  }

  // 4. Update transaction allocation details in DB
  if (transactionId) {
    await Transaction.findByIdAndUpdate(transactionId, {
      allocatedPrincipal,
      allocatedInterest,
      allocatedLateFee,
      allocatedDueCharges
    });

    // Write to Cash Book double-entry system
    await CashBook.findOneAndUpdate(
      { transactionId },
      {
        paymentDate,
        type: 'collection',
        amount: amount,
        paymentMode: (await Transaction.findById(transactionId))?.paymentMode || 'cash',
        customerId: loan.customerId,
        loanId: loan._id,
        notes: `Collection waterfall splits: Principal=${allocatedPrincipal}, Interest=${allocatedInterest}`
      },
      { upsert: true }
    );
  }
}

/**
 * Resets all installments for a loan and re-runs the waterfall allocation
 * chronologically for all valid transactions.
 */
export async function rebuildInstallmentPayments(loanId) {
  const loan = await Loan.findById(loanId);
  if (!loan) return;

  // 1. Reset loan fields
  loan.dueChargesPaid = 0;
  loan.lateChargesPaid = 0;
  loan.excessAdvanceBalance = 0;
  loan.status = 'active';
  loan.closureDate = null;
  await loan.save();

  // 2. Reset all installments
  await Installment.updateMany(
    { loanId },
    {
      $set: {
        amountPaid: 0,
        principalPaid: 0,
        interestPaid: 0,
        lateFeePaid: 0,
        status: 'unpaid',
        lastPaymentDate: null
      }
    }
  );

  // 3. Fetch all transactions sorted by date ascending (excluding reversed and pending verification ones)
  const transactions = await Transaction.find({ loanId, isReversed: { $ne: true }, status: { $ne: 'pending' } }).sort({ paymentDate: 1 });

  // 4. Re-apply each transaction waterfall
  for (const tx of transactions) {
    await allocatePaymentWaterfall(loanId, tx.amount, tx.paymentType, tx.paymentDate, tx._id);
  }

  // 5. Update overdue flags based on current date (compared against start of today)
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const unpaidInstallments = await Installment.find({
    loanId,
    status: { $in: ['unpaid', 'partially_paid'] }
  });

  for (const inst of unpaidInstallments) {
    if (new Date(inst.dueDate) < startOfDay) {
      inst.status = 'overdue';
    } else {
      inst.status = 'upcoming';
    }
    await inst.save();
  }

  // 6. Check for automatic closure
  const totalInstallmentsCount = await Installment.countDocuments({ loanId });
  const paidInstallmentsCount = await Installment.countDocuments({ loanId, status: 'paid' });
  const overdueInstallmentsCount = await Installment.countDocuments({ loanId, status: 'overdue' });

  const freshLoan = await Loan.findById(loanId);
  if (freshLoan) {
    const allChargesCleared = 
      (freshLoan.dueCharges - freshLoan.dueChargesPaid === 0) && 
      (freshLoan.lateCharges - freshLoan.lateChargesPaid === 0);

    if (paidInstallmentsCount === totalInstallmentsCount && totalInstallmentsCount > 0 && allChargesCleared) {
      freshLoan.status = 'closed';
      freshLoan.closureDate = new Date();
    } else if (overdueInstallmentsCount > 0) {
      freshLoan.status = 'overdue';
    } else {
      freshLoan.status = 'active';
    }
    await freshLoan.save();
  }
}
