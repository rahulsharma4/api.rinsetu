/**
 * Helper to calculate periodic interest rate as a decimal fraction.
 * Converts any combination of interest rate types and payment frequencies to a normalized periodic rate.
 */
export function getPeriodicRate(interestRate, rateType, paymentFrequency) {
  // Convert interestRate to an annual rate fraction first
  let annualRateFraction = 0;
  if (rateType === 'daily') annualRateFraction = (interestRate * 365) / 100;
  else if (rateType === 'weekly') annualRateFraction = (interestRate * 52) / 100;
  else if (rateType === 'monthly') annualRateFraction = (interestRate * 12) / 100;
  else if (rateType === 'yearly') annualRateFraction = interestRate / 100;
  
  // Convert annual rate fraction to periodic rate fraction based on paymentFrequency
  if (paymentFrequency === 'daily') return annualRateFraction / 365;
  if (paymentFrequency === 'weekly') return annualRateFraction / 52;
  if (paymentFrequency === 'monthly') return annualRateFraction / 12;
  if (paymentFrequency === 'yearly') return annualRateFraction;
  return annualRateFraction / 12;
}

/**
 * Increments a date based on the payment frequency and index.
 */
export function getNextDueDate(startDate, paymentFrequency, index) {
  const nextDate = new Date(startDate);
  if (paymentFrequency === 'daily') {
    nextDate.setDate(nextDate.getDate() + index);
  } else if (paymentFrequency === 'weekly') {
    nextDate.setDate(nextDate.getDate() + index * 7);
  } else if (paymentFrequency === 'monthly') {
    nextDate.setMonth(nextDate.getMonth() + index);
  } else if (paymentFrequency === 'yearly') {
    nextDate.setFullYear(nextDate.getFullYear() + index);
  }
  return nextDate;
}

/**
 * Generates an array of installment schedules for a given loan.
 * 
 * @param {Object} loan - The loan details
 * @returns {Array} List of generated installments
 */
export function generateRepaymentSchedule(loan) {
  const P = loan.principalAmount;
  const R = loan.interestRate;
  const N = loan.tenure;
  const startDate = new Date(loan.startDate);
  const interestType = loan.interestType; // 'flat', 'reducing', 'simple'
  const rateType = loan.rateType;
  const paymentFrequency = loan.paymentFrequency;

  const installments = [];
  const r = getPeriodicRate(R, rateType, paymentFrequency);

  if (interestType === 'flat') {
    // Flat rate: Total interest is calculated on full principal for entire tenure, split equally
    const totalInterest = P * r * N;
    const interestPerInstallment = Math.round((totalInterest / N) * 100) / 100;
    const principalPerInstallment = Math.round((P / N) * 100) / 100;
    
    let principalRemaining = P;
    let interestRemaining = totalInterest;

    for (let i = 1; i <= N; i++) {
      const isLast = i === N;
      const pComp = isLast ? principalRemaining : principalPerInstallment;
      const iComp = isLast ? interestRemaining : interestPerInstallment;
      
      installments.push({
        installmentNumber: i,
        dueDate: getNextDueDate(startDate, paymentFrequency, i),
        principalComponent: Math.round(pComp * 100) / 100,
        interestComponent: Math.round(iComp * 100) / 100,
        totalAmount: Math.round((pComp + iComp) * 100) / 100,
        amountPaid: 0,
        status: 'unpaid'
      });
      
      principalRemaining -= pComp;
      interestRemaining -= iComp;
    }
  } 
  else if (interestType === 'reducing') {
    // Reducing balance: EMI formula
    // EMI = P * r * (1+r)^N / ((1+r)^N - 1)
    let emi = 0;
    if (r === 0) {
      emi = P / N;
    } else {
      emi = P * (r * Math.pow(1 + r, N)) / (Math.pow(1 + r, N) - 1);
    }
    
    let activePrincipal = P;

    for (let i = 1; i <= N; i++) {
      const isLast = i === N;
      const iComp = activePrincipal * r;
      let pComp = emi - iComp;

      if (isLast || activePrincipal < pComp) {
        pComp = activePrincipal;
      }

      installments.push({
        installmentNumber: i,
        dueDate: getNextDueDate(startDate, paymentFrequency, i),
        principalComponent: Math.round(pComp * 100) / 100,
        interestComponent: Math.round(iComp * 100) / 100,
        totalAmount: Math.round((pComp + iComp) * 100) / 100,
        amountPaid: 0,
        status: 'unpaid'
      });

      activePrincipal -= pComp;
    }
  } 
  else {
    // Simple Interest (Interest-only, Principal paid in full at end)
    const interestPerInstallment = P * r;

    for (let i = 1; i <= N; i++) {
      const isLast = i === N;
      const pComp = isLast ? P : 0;
      const iComp = interestPerInstallment;

      installments.push({
        installmentNumber: i,
        dueDate: getNextDueDate(startDate, paymentFrequency, i),
        principalComponent: Math.round(pComp * 100) / 100,
        interestComponent: Math.round(iComp * 100) / 100,
        totalAmount: Math.round((pComp + iComp) * 100) / 100,
        amountPaid: 0,
        status: 'unpaid'
      });
    }
  }

  return installments;
}
