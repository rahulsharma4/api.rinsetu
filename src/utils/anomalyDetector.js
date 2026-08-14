import Customer from '../models/Customer.js';
import Loan from '../models/Loan.js';
import Transaction from '../models/Transaction.js';

export async function detectSystemAnomalies(tenantId) {
  const anomalies = [];

  // 1. Same mobile number shared by multiple customers
  const customers = await Customer.find({ tenantId });
  const phoneMap = {};
  customers.forEach(c => {
    if (c.phone) {
      if (!phoneMap[c.phone]) phoneMap[c.phone] = [];
      phoneMap[c.phone].push(c);
    }
  });

  Object.keys(phoneMap).forEach(phone => {
    if (phoneMap[phone].length > 1) {
      const names = phoneMap[phone].map(c => c.name).join(', ');
      anomalies.push({
        type: 'Duplicate Customer Contacts',
        description: `Multiple borrowers share the same phone number (${phone}): ${names}`,
        severity: 'medium',
        createdAt: new Date()
      });
    }
  });

  // 2. Same collateral details used in multiple active loans
  const activeLoans = await Loan.find({ tenantId, status: 'active' }).populate('customerId');
  const collateralMap = {};
  activeLoans.forEach(loan => {
    const cust = loan.customerId;
    if (cust && cust.collateralType && cust.collateralType !== 'None') {
      const key = `${cust.collateralType}-${(cust.collateralDescription || '').trim().toLowerCase()}`;
      if (!collateralMap[key]) collateralMap[key] = [];
      collateralMap[key].push({ loan, customer: cust });
    }
  });

  Object.keys(collateralMap).forEach(key => {
    if (collateralMap[key].length > 1) {
      const owners = collateralMap[key].map(item => item.customer.name).join(' & ');
      anomalies.push({
        type: 'Shared Collateral Asset',
        description: `Suspicious: Same collateral asset details (${key.split('-')[0]}) registered under active loans for multiple borrowers: ${owners}`,
        severity: 'high',
        createdAt: new Date()
      });
    }
  });

  // 3. Unusual backdated payment entry
  const transactions = await Transaction.find({ tenantId }).populate('customerId');
  transactions.forEach(tx => {
    const payDate = new Date(tx.paymentDate);
    const createdDate = new Date(tx.createdAt);
    const diffTime = Math.abs(createdDate - payDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays > 7) {
      anomalies.push({
        type: 'Backdated Ledger Entry',
        description: `Payment of ₹${tx.amount} for ${tx.customerId?.name || 'Borrower'} was logged with a backdate of ${diffDays} days.`,
        severity: 'info',
        createdAt: new Date()
      });
    }
  });

  // 4. Loan terms unusually changed / High interest warning
  const loans = await Loan.find({ tenantId, status: 'active' }).populate('customerId');
  loans.forEach(loan => {
    if (loan.rateType === 'monthly' && loan.interestRate > 10) {
      anomalies.push({
        type: 'High Interest Rate Flag',
        description: `Loan of ₹${loan.principalAmount} for ${loan.customerId?.name || 'Borrower'} carries a monthly interest rate of ${loan.interestRate}%, which is unusually high.`,
        severity: 'medium',
        createdAt: new Date()
      });
    }
  });

  return anomalies;
}
