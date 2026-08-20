import mongoose from 'mongoose';
import dotenv from 'dotenv';
import dns from 'dns';
import Transaction from '../models/Transaction.js';
import AuditLog from '../models/AuditLog.js';
import User from '../models/User.js';
import Loan from '../models/Loan.js';

try {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
  if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch (_) {}

dotenv.config();

async function run() {
  console.log('🔄 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected.');

  const transactionsCount = await Transaction.countDocuments({});
  console.log(`\n📊 Total Transactions in DB: ${transactionsCount}`);

  const txs = await Transaction.find({}).sort({ createdAt: -1 }).limit(5).populate('customerId').populate('loanId');
  console.log('\n--- LAST 5 TRANSACTIONS ---');
  if (txs.length === 0) {
    console.log('No transactions found.');
  } else {
    txs.forEach((t, i) => {
      console.log(`${i+1}. Date: ${t.paymentDate || t.createdAt}`);
      console.log(`   Amount: ₹${t.amount}`);
      console.log(`   Mode: ${t.paymentMode}`);
      console.log(`   Borrower: ${t.customerId?.name || 'Unknown'}`);
      console.log(`   Ref ID: ${t.razorpayPaymentId || 'None'}`);
      console.log(`   Reversed: ${t.isReversed ? 'YES' : 'NO'}`);
      console.log('   ---');
    });
  }

  const logs = await AuditLog.find({}).sort({ timestamp: -1 }).limit(5);
  console.log('\n--- LAST 5 AUDIT LOGS ---');
  if (logs.length === 0) {
    console.log('No audit logs found.');
  } else {
    logs.forEach((l, i) => {
      console.log(`${i+1}. Action: ${l.action}`);
      console.log(`   Details: ${l.details}`);
      console.log(`   Operator: ${l.operator}`);
      console.log(`   Time: ${l.timestamp}`);
      console.log('   ---');
    });
  }

  await mongoose.disconnect();
}

run();
