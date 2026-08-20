import mongoose from 'mongoose';
import dotenv from 'dotenv';
import dns from 'dns';
import fs from 'fs';
import path from 'path';
import Transaction from '../models/Transaction.js';
import User from '../models/User.js';
import Loan from '../models/Loan.js';
import Customer from '../models/Customer.js';

try {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
  if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch (_) {}

dotenv.config();

async function run() {
  let output = '';
  const log = (msg) => {
    console.log(msg);
    output += msg + '\n';
  };

  try {
    log('=== BYAJ CRM WEBHOOK DIAGNOSTIC REPORT ===');
    log(`Date: ${new Date().toISOString()}`);

    log('\n🔄 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    log('✅ Connected.');

    // 1. Users list
    log('\n--- 1. REGISTERED USERS (TENANTS) ---');
    const users = await User.find({});
    log(`Total users: ${users.length}`);
    users.forEach(u => {
      log(`- ID: ${u._id} | Username: ${u.username} | Email: ${u.email}`);
    });

    // 2. Active Loans
    log('\n--- 2. ACTIVE LOANS ---');
    const activeLoans = await Loan.find({ status: 'active' }).populate('customerId');
    log(`Total active loans: ${activeLoans.length}`);
    activeLoans.forEach(l => {
      log(`- Loan ID: ${l._id} | Tenant ID: ${l.tenantId} | Borrower: ${l.customerId?.name} (ID: ${l.customerId?._id})`);
    });

    // 3. Last 10 Transactions
    log('\n--- 3. RECENT TRANSACTIONS ---');
    const txs = await Transaction.find({}).sort({ createdAt: -1 }).limit(10).populate('customerId');
    log(`Total transactions in database: ${await Transaction.countDocuments({})}`);
    if (txs.length === 0) {
      log('No transactions found in the database.');
    } else {
      txs.forEach((t, i) => {
        log(`${i + 1}. Tx ID: ${t._id}`);
        log(`   Date: ${t.paymentDate || t.createdAt}`);
        log(`   Amount: ₹${t.amount}`);
        log(`   Mode: ${t.paymentMode}`);
        log(`   Borrower: ${t.customerId?.name || 'Unknown'} (ID: ${t.customerId?._id})`);
        log(`   Tenant ID (Owner): ${t.tenantId}`);
        log(`   Ref ID (Razorpay ID): ${t.razorpayPaymentId || 'None'}`);
        log(`   Reversed: ${t.isReversed ? 'YES' : 'NO'}`);
        log('   ---');
      });
    }

    // Write file
    const outputPath = path.join(process.cwd(), 'debug_output.txt');
    fs.writeFileSync(outputPath, output);
    console.log(`\n💾 Saved diagnostic report to: ${outputPath}`);

  } catch (err) {
    console.error('❌ Error during diagnostic:', err);
  } finally {
    await mongoose.disconnect();
  }
}

run();
