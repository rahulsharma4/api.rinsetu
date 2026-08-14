import Loan from '../models/Loan.js';
import Installment from '../models/Installment.js';
import { generateRepaymentSchedule } from './scheduleGenerator.js';

/**
 * Restructures an active or overdue loan.
 * Closes the original loan, transfers outstanding principal to a new loan,
 * and generates a new installment schedule.
 * 
 * @param {ObjectId} loanId - Original loan ID
 * @param {Number} newInterestRate - New interest rate
 * @param {String} newRateType - 'daily', 'weekly', 'monthly', 'yearly'
 * @param {String} newPaymentFrequency - 'daily', 'weekly', 'monthly', 'yearly'
 * @param {Number} newTenure - New tenure periods
 * @param {String} remarks - Audit remarks
 */
export async function restructureLoan(loanId, newInterestRate, newRateType, newPaymentFrequency, newTenure, remarks) {
  const originalLoan = await Loan.findById(loanId);
  if (!originalLoan) throw new Error('Original loan not found');

  if (originalLoan.status === 'closed' || originalLoan.status === 'paid') {
    throw new Error('Closed or paid loans cannot be restructured.');
  }

  // 1. Calculate outstanding principal from unpaid installments
  const unpaidInstallments = await Installment.find({
    loanId,
    status: { $ne: 'paid' }
  }).sort({ installmentNumber: 1 });

  let outstandingPrincipal = 0;
  for (const inst of unpaidInstallments) {
    outstandingPrincipal += (inst.principalComponent - inst.principalPaid);
  }

  if (outstandingPrincipal <= 0) {
    throw new Error('Outstanding principal is zero. Restructuring not needed.');
  }

  // 2. Mark original unpaid installments as restructured and closed
  await Installment.updateMany(
    { loanId, status: { $ne: 'paid' } },
    { $set: { isRestructured: true, status: 'paid' } }
  );

  // 3. Close the original loan file
  originalLoan.status = 'closed';
  originalLoan.closureDate = new Date();
  originalLoan.isRestructured = true;
  originalLoan.remarks = (originalLoan.remarks || '') + ` [Restructured on ${new Date().toLocaleDateString('en-IN')}: transferred ₹${outstandingPrincipal} principal to new restructured agreement]`;
  await originalLoan.save();

  // 4. Create the new restructured Loan document
  const restructuredLoan = new Loan({
    customerId: originalLoan.customerId,
    principalAmount: Math.round(outstandingPrincipal * 100) / 100,
    processingFee: 0,
    interestRate: newInterestRate,
    rateType: newRateType,
    interestType: originalLoan.interestType, // Keep formula type
    compoundingPeriod: originalLoan.compoundingPeriod,
    paymentFrequency: newPaymentFrequency,
    startDate: new Date(),
    tenure: newTenure,
    status: 'active',
    restructuredFromLoanId: originalLoan._id,
    remarks: remarks || `Restructured from Loan Account ID: ${originalLoan._id}`,
    tenantId: originalLoan.tenantId,
  });

  const savedLoan = await restructuredLoan.save();

  // 5. Generate new installment schedule
  await generateRepaymentSchedule(savedLoan);

  return savedLoan;
}
