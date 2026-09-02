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

      // 🚨 NPA Check: If oldest unpaid installment is >= 90 days overdue, mark loan as NPA and freeze fees
      if (overdueInstallments.length > 0) {
        const sortedInstallments = [...overdueInstallments].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
        const oldestDueDate = new Date(sortedInstallments[0].dueDate);
        oldestDueDate.setHours(0, 0, 0, 0);
        
        const daysOverdue = Math.floor((today.getTime() - oldestDueDate.getTime()) / (1000 * 60 * 60 * 24));
        if (daysOverdue >= 90) {
          console.log(`🚨 Marking Loan ID ${loan._id} as NPA. Oldest installment is ${daysOverdue} days overdue.`);
          loan.status = 'npa';
          await loan.save();
          continue; // Skip fee calculations
        }
      }

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

        // Check if there is a pending transaction awaiting admin approval for this loan
        const Transaction = (await import('../models/Transaction.js')).default;
        const pendingTx = await Transaction.findOne({
          loanId: loan._id,
          status: 'pending'
        });

        let endDate = today;

        if (pendingTx) {
          const txDate = new Date(pendingTx.paymentDate || pendingTx.createdAt);
          txDate.setHours(0, 0, 0, 0);

          // If pending payment was submitted on or before graceExpiryDate, hold off charging late fees completely
          if (txDate <= graceExpiryDate) {
            console.log(`⏸️ Skipping late fee for Loan ID ${loan._id.toString().slice(-6)} (Pending payment submitted on time on ${txDate.toLocaleDateString('en-IN')} awaiting admin approval).`);
            continue;
          } else {
            // Customer paid late, so freeze penalty calculation at the exact date customer submitted payment!
            endDate = txDate;
          }
        }

        // Determine start date for late fee calculation
        const lastApplied = inst.lateFeeLastAppliedDate;
        const startDate = lastApplied ? new Date(lastApplied) : graceExpiryDate;
        startDate.setHours(0, 0, 0, 0);

        // Difference in days (calculated up to payment submission date)
        const diffTime = endDate.getTime() - startDate.getTime();
        const diffDays = Math.max(0, Math.floor(diffTime / (1000 * 60 * 60 * 24)));

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
