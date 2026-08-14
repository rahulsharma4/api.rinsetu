import mongoose from 'mongoose';
import dotenv from 'dotenv';
import dns from 'dns';

// Force DNS to resolve IPv4 first & use Google DNS (fixes MongoDB querySrv ECONNREFUSED)
dns.setServers(['8.8.8.8', '8.8.4.4']);
dns.setDefaultResultOrder('ipv4first');

import Customer from '../models/Customer.js';
import Loan from '../models/Loan.js';
import Installment from '../models/Installment.js';
import Transaction from '../models/Transaction.js';
import { generateRepaymentSchedule } from '../utils/scheduleGenerator.js';
import { rebuildInstallmentPayments } from '../utils/waterfallEngine.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

async function seedDatabase() {
  try {
    console.log('Connecting to MongoDB database to seed...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected! Clearing existing collections...');
    
    await Customer.deleteMany({});
    await Loan.deleteMany({});
    await Installment.deleteMany({});
    await Transaction.deleteMany({});

    console.log('Seeding Customers (Borrowers)...');
    const customers = await Customer.create([
      {
        name: 'Ramesh Kumar',
        phone: '9876543210',
        address: '123 Main Street, Sector 4, Jaipur',
        occupation: 'Shopkeeper',
        guarantorName: 'Suresh Kumar',
        guarantorPhone: '9876543211',
        collateralType: 'Gold',
        collateralDescription: 'Gold Chain (24 grams, 22 Carat)',
        collateralValue: 120000,
        status: 'Active'
      },
      {
        name: 'Sunita Sharma',
        phone: '9123456789',
        address: '45 Near Temple, Malviya Nagar, Jaipur',
        occupation: 'Teacher',
        guarantorName: 'Mahesh Sharma',
        guarantorPhone: '9123456780',
        collateralType: 'Documents',
        collateralDescription: 'Property Deed for Plot 45-B',
        collateralValue: 800000,
        status: 'Active'
      },
      {
        name: 'Amit Patel',
        phone: '8765432109',
        address: 'Plot 10, Vaishali Nagar, Jaipur',
        occupation: 'Contractor',
        guarantorName: 'Rajesh Patel',
        guarantorPhone: '8765432100',
        collateralType: 'Vehicle',
        collateralDescription: 'Honda Activa (Registration: RJ-14-SG-9988)',
        collateralValue: 45000,
        status: 'Active'
      }
    ]);

    console.log('Seeding Loans...');
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const fifteenDaysAgo = new Date();
    fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);

    const loansData = [
      {
        customerId: customers[0]._id,
        principalAmount: 100000,
        processingFee: 1000,
        interestRate: 2, // 2% per month
        rateType: 'monthly',
        interestType: 'flat',
        paymentFrequency: 'monthly',
        startDate: thirtyDaysAgo,
        tenure: 12,
        status: 'active',
        remarks: 'Gold chain submitted, loan approved.'
      },
      {
        customerId: customers[1]._id,
        principalAmount: 50000,
        processingFee: 500,
        interestRate: 3, // 3% per month
        rateType: 'monthly',
        interestType: 'reducing',
        paymentFrequency: 'monthly',
        startDate: fifteenDaysAgo,
        tenure: 6,
        status: 'active',
        remarks: 'Reducing balance loan, plot papers submitted.'
      },
      {
        customerId: customers[2]._id,
        principalAmount: 30000,
        processingFee: 300,
        interestRate: 2, // 2% per month
        rateType: 'monthly',
        interestType: 'simple',
        paymentFrequency: 'monthly',
        startDate: thirtyDaysAgo,
        tenure: 3,
        status: 'active',
        remarks: 'Simple interest only repayment agreement.'
      }
    ];

    const loans = [];
    for (const data of loansData) {
      const loan = await Loan.create(data);
      
      // Auto-generate installments repayment schedule
      const schedule = generateRepaymentSchedule(loan);
      const installmentDocs = schedule.map(item => ({
        loanId: loan._id,
        ...item
      }));
      await Installment.insertMany(installmentDocs);
      
      loans.push(loan);
    }

    console.log('Seeding Repayment Transactions...');
    // Seed some repayments
    const payments = [
      {
        loanId: loans[0]._id,
        customerId: customers[0]._id,
        amount: 10000, // Pays off first flat EMI
        paymentType: 'both',
        paymentMode: 'cash',
        paymentDate: fifteenDaysAgo,
        notes: 'First installment cash received.'
      },
      {
        loanId: loans[2]._id,
        customerId: customers[2]._id,
        amount: 600, // Pays off first simple interest only EMI
        paymentType: 'interest',
        paymentMode: 'online',
        paymentDate: fifteenDaysAgo,
        notes: 'Interest collected via UPI.'
      }
    ];

    for (const p of payments) {
      await Transaction.create(p);
    }

    console.log('Re-applying waterfall allocations for all seeded loans...');
    for (const loan of loans) {
      await rebuildInstallmentPayments(loan._id);
    }

    console.log('Database seeding completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Seeding failed:', error.message);
    process.exit(1);
  }
}

seedDatabase();
