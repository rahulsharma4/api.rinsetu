import Installment from '../models/Installment.js';
import Loan from '../models/Loan.js';

/**
 * Scans all active/overdue loans and their installments.
 * Marks installments past their due date as 'overdue', and updates parent loan statuses.
 */
export async function updateOverdueStatuses() {
  try {
    const today = new Date();

    // 1. Find all unpaid or partially paid installments that are past due date
    const pastDueInstallments = await Installment.find({
      dueDate: { $lt: today },
      status: { $in: ['unpaid', 'partially_paid'] }
    });

    for (const inst of pastDueInstallments) {
      inst.status = 'overdue';
      await inst.save();
    }

    // 2. Find all installments that are marked overdue but somehow paid off or not past due (e.g. payment logged)
    // (Note: waterfall engine already sets them to paid/partially_paid, but we can verify)
    
    // 3. Update status of active loans that have overdue installments
    const activeLoans = await Loan.find({ status: 'active' });
    for (const loan of activeLoans) {
      const overdueCount = await Installment.countDocuments({
        loanId: loan._id,
        status: 'overdue'
      });
      if (overdueCount > 0) {
        loan.status = 'overdue';
        await loan.save();
      }
    }

    // 4. Update status of overdue loans that no longer have overdue installments
    const overdueLoans = await Loan.find({ status: 'overdue' });
    for (const loan of overdueLoans) {
      const overdueCount = await Installment.countDocuments({
        loanId: loan._id,
        status: 'overdue'
      });
      if (overdueCount === 0) {
        loan.status = 'active';
        await loan.save();
      }
    }
  } catch (error) {
    console.error('Error updating overdue statuses:', error.message);
  }
}
