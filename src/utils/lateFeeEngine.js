import Loan from '../models/Loan.js';
import Installment from '../models/Installment.js';
import { logAuditAction } from './auditHelper.js';

/**
 * Scans all active or overdue loans and calculates & applies late fee charges to the loan's outstanding lateCharges.
 */
export async function applyLateFees() {
  console.log('⏳ Running automated late fee application engine...');
  const today = new Date();
  today.setHours(0, 0, 0, 0); // Normalize today to midnight for precise day count
  
  let appliedCount = 0;
  let totalFeeAdded = 0;

  try {
    // 1. Find all active or overdue loans
    const loans = await Loan.find({ status: { $in: ['active', 'overdue'] } });

    for (const loan of loans) {
      // Get all installments that are past due date and not fully paid
      const overdueInstallments = await Installment.find({
        loanId: loan._id,
        status: { $in: ['overdue', 'unpaid', 'partially_paid'] },
        dueDate: { $lt: new Date() } // due date is in the past
      });

      let loanUpdated = false;
      let loanFeeAdded = 0;

      for (const inst of overdueInstallments) {
        const graceDays = loan.gracePeriodDays || 0;
        const graceExpiryDate = new Date(inst.dueDate);
        graceExpiryDate.setDate(graceExpiryDate.getDate() + graceDays);
        graceExpiryDate.setHours(0, 0, 0, 0);

        // If today is before graceExpiryDate, skip charging penalty
        if (today < graceExpiryDate) {
          continue;
        }

        // Determine start date for late fee calculation
        const lastApplied = inst.lateFeeLastAppliedDate;
        const startDate = lastApplied ? new Date(lastApplied) : graceExpiryDate;
        startDate.setHours(0, 0, 0, 0);

        // Difference in days
        const diffTime = today.getTime() - startDate.getTime();
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays > 0) {
          const rate = loan.lateFeeRate !== undefined ? loan.lateFeeRate : 50;
          const type = loan.lateFeeType || 'daily';

          let chargesToAdd = 0;

          if (type === 'daily') {
            chargesToAdd = diffDays * rate;
          } else if (type === 'flat') {
            // Flat fee is only applied once
            if (!lastApplied) {
              chargesToAdd = rate;
            }
          }

          if (chargesToAdd > 0) {
            loan.lateCharges = (loan.lateCharges || 0) + chargesToAdd;
            loanFeeAdded += chargesToAdd;
            loanUpdated = true;
            appliedCount++;
          }

          // Mark last applied as today
          inst.lateFeeLastAppliedDate = today;
          await inst.save();
        }
      }

      if (loanUpdated) {
        // If loan late fee was added, we should update status to overdue if it was active
        if (loan.status === 'active') {
          loan.status = 'overdue';
        }
        await loan.save();
        totalFeeAdded += loanFeeAdded;

        // Log audit trail
        await logAuditAction(
          'system',
          'LATE_FEE_APPLIED',
          `Auto-applied late fee of ₹${loanFeeAdded} to Loan Account #${loan._id.toString().slice(-6)} (${loan.lateFeeType} rate: ₹${loan.lateFeeRate})`,
          null,
          { lateCharges: loan.lateCharges },
          null
        );
      }
    }

    console.log(`✅ Late fee application engine completed. Applied to ${appliedCount} items. Total charges added: ₹${totalFeeAdded}`);
    return { appliedCount, totalFeeAdded };
  } catch (error) {
    console.error('❌ Error in applyLateFees engine:', error.message);
    throw error;
  }
}
