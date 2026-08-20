import mongoose from 'mongoose';
import dotenv from 'dotenv';
import dns from 'dns';
import User from '../models/User.js';
import Plan from '../models/Plan.js';

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

  // Clear existing pricing plans to start fresh with duration plans
  console.log('🧹 Clearing legacy pricing plans...');
  await Plan.deleteMany({});

  // 1. Create Duration Pricing Plans with identical full functionality
  console.log('\n--- 1. CONFIGURING DURATION-BASED PRICING PLANS ---');
  
  const p1 = new Plan({
    name: '1 Month Subscription',
    price: 499,
    durationDays: 30,
    maxBorrowers: -1, // unlimited
    features: [
      'Full CRM Ledger Access',
      'Automatic Razorpay UPI QR',
      'Waterfall Installment Engine',
      'Automated WhatsApp Alerts',
      'Audit Trail logs',
    ],
    isActive: true,
  });
  await p1.save();
  console.log('Created 1 Month Plan: ₹499');

  const p6 = new Plan({
    name: '6 Months Saver Plan',
    price: 2499,
    durationDays: 180,
    maxBorrowers: -1, // unlimited
    features: [
      'Full CRM Ledger Access',
      'Automatic Razorpay UPI QR',
      'Waterfall Installment Engine',
      'Automated WhatsApp Alerts',
      'Audit Trail logs',
      'Save ₹500 over monthly plan!',
    ],
    isActive: true,
  });
  await p6.save();
  console.log('Created 6 Months Plan: ₹2,499 (Save ₹500)');

  const p12 = new Plan({
    name: '12 Months Annual Plan',
    price: 4499,
    durationDays: 360,
    maxBorrowers: -1, // unlimited
    features: [
      'Full CRM Ledger Access',
      'Automatic Razorpay UPI QR',
      'Waterfall Installment Engine',
      'Automated WhatsApp Alerts',
      'Audit Trail logs',
      'Save ₹1,500 over monthly plan!',
    ],
    isActive: true,
  });
  await p12.save();
  console.log('Created 12 Months Plan: ₹4,499 (Save ₹1,500)');

  // 2. Find admin12 and expire their subscription for testing
  console.log('\n--- 2. UPDATING TENANT SUBSCRIPTION STATUS FOR TESTING ---');
  const tenant = await User.findOne({ username: 'admin12' });
  if (!tenant) {
    console.error('❌ Tenant "admin12" not found. Please log in first or seed the database.');
    await mongoose.disconnect();
    return;
  }

  const pastDate = new Date();
  pastDate.setDate(pastDate.getDate() - 1); // Set to yesterday (expired)

  tenant.subscriptionStatus = 'expired';
  tenant.renewalDate = pastDate;
  tenant.subscriptionPlan = p1._id;
  tenant.isFreeAccess = false;
  tenant.customPrice = undefined; // reset custom price

  await tenant.save();
  console.log(`✅ Tenant "${tenant.businessName}" (${tenant.username}) subscription status set to EXPIRED.`);
  console.log(`📅 Renewal Date set to: ${tenant.renewalDate.toISOString()}`);
  console.log('\n🎉 TEST SETUP READY!');
  console.log('💡 Now, open your browser dashboard (http://localhost:3000) and log in as "admin12".');
  console.log('💡 You will see the updated 1 Month, 6 Months, and 12 Months plans displayed with identical features!');
  console.log('💡 You will also find a "Billing & Subscription" tab in the side menu.');

  await mongoose.disconnect();
}

run();
