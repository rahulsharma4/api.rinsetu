import Installment from '../models/Installment.js';
import Loan from '../models/Loan.js';
import Transaction from '../models/Transaction.js';
import Customer from '../models/Customer.js';

export async function getDailyDashboardSummary(tenantId) {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

  const sevenDaysLater = new Date();
  sevenDaysLater.setDate(today.getDate() + 7);

  const tenantLoans = await Loan.find({ tenantId }).select('_id');
  const loanIds = tenantLoans.map(l => l._id);

  // 1. Today's due sum
  const todayInstallments = await Installment.find({
    loanId: { $in: loanIds },
    dueDate: { $gte: startOfDay, $lt: endOfDay },
    status: { $in: ['unpaid', 'partially_paid', 'overdue'] }
  });
  const todayDueSum = todayInstallments.reduce((acc, i) => acc + (i.totalAmount - i.amountPaid), 0);

  // 2. Upcoming 7 days due sum
  const upcomingInstallments = await Installment.find({
    loanId: { $in: loanIds },
    dueDate: { $gte: endOfDay, $lte: sevenDaysLater },
    status: { $in: ['unpaid', 'partially_paid'] }
  });
  const upcoming7DaysSum = upcomingInstallments.reduce((acc, i) => acc + (i.totalAmount - i.amountPaid), 0);

  // 3. Overdue sum
  const overdueInstallments = await Installment.find({
    loanId: { $in: loanIds },
    status: 'overdue'
  });
  const overdueSum = overdueInstallments.reduce((acc, i) => acc + (i.totalAmount - i.amountPaid), 0);

  // 4. Overdue accounts count
  const overdueLoansCount = await Loan.countDocuments({ tenantId, status: 'overdue' });

  // 5. Active loans that are fully paid and ready to close
  const activeLoans = await Loan.find({ tenantId, status: 'active' });
  let closureReadyCount = 0;
  for (const loan of activeLoans) {
    const totalInsts = await Installment.countDocuments({ loanId: loan._id });
    const paidInsts = await Installment.countDocuments({ loanId: loan._id, status: 'paid' });
    const chargesCleared = (loan.dueCharges - loan.dueChargesPaid === 0) && (loan.lateCharges - loan.lateChargesPaid === 0);
    if (paidInsts === totalInsts && totalInsts > 0 && chargesCleared) {
      closureReadyCount++;
    }
  }

  return {
    todayDue: Math.round(todayDueSum),
    upcoming7Days: Math.round(upcoming7DaysSum),
    overdue: Math.round(overdueSum),
    todayPaymentsDueCount: todayInstallments.length,
    overdueAccountsCount: overdueLoansCount,
    loansReadyToCloseCount: closureReadyCount
  };
}

export async function getEndOfDayCollectionSummary(tenantId, startDate, endDate) {
  let start, end;
  if (startDate && endDate) {
    start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
  } else {
    const today = new Date();
    start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  }

  const tenantLoans = await Loan.find({ tenantId }).select('_id');
  const loanIds = tenantLoans.map(l => l._id);

  // 1. Expected collection (Installments due in range)
  const rangeInstallments = await Installment.find({
    loanId: { $in: loanIds },
    dueDate: { $gte: start, $lte: end }
  });
  const expectedCollection = rangeInstallments.reduce((acc, i) => acc + i.totalAmount, 0);

  // 2. Collected collection (Transactions logged in range)
  const rangeTransactions = await Transaction.find({
    tenantId,
    paymentDate: { $gte: start, $lte: end },
    isReversed: { $ne: true }
  });
  const collectedCollection = rangeTransactions.reduce((acc, t) => acc + t.amount, 0);

  const pendingAmount = Math.max(0, expectedCollection - collectedCollection);
  const collectionRate = expectedCollection > 0 
    ? Math.round((collectedCollection / expectedCollection) * 1000) / 10 
    : 100;

  // AI Shortfall Explanation
  let aiExplanation = "Collection Summary is looking stable.";
  if (pendingAmount > 0) {
    const unpaidCount = rangeInstallments.filter(i => i.status !== 'paid').length;
    aiExplanation = `Collection shortfall of ₹${Math.round(pendingAmount).toLocaleString('en-IN')} is mainly due to ${unpaidCount} installment payments remaining unpaid or partially paid in this period. Please check the Collection panel to draft WhatsApp reminders.`;
  }

  return {
    expected: Math.round(expectedCollection),
    collected: Math.round(collectedCollection),
    pending: Math.round(pendingAmount),
    collectionRate,
    aiExplanation
  };
}
