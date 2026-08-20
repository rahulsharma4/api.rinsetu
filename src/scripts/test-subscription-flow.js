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

  // 1. Create or Find Pricing Plans
  console.log('\n--- 1. CONFIGURING PRICING PLANS ---');
  let basicPlan = await Plan.findOne({ name: 'Starter Basic Plan' });
  if (!basicPlan) {
    basicPlan = new Plan({
      name: 'Starter Basic Plan',
      price: 499,
      durationDays: 30,
      maxBorrowers: 50,
      features: ['Up to 50 active borrowers', 'Waterfall interest logic', 'Basic reports'],
      isActive: true,
    });
    await basicPlan.save();
    console.log('Created Starter Basic Plan: ₹499/mo');
  } else {
    console.log('Starter Basic Plan already exists.');
  }

  let premiumPlan = await Plan.findOne({ name: 'Premium Unlimited Plan' });
  if (!premiumPlan) {
    premiumPlan = new Plan({
      name: 'Premium Unlimited Plan',
      price: 999,
      durationDays: 30,
      maxBorrowers: -1,
      features: ['Unlimited borrowers', 'WhatsApp auto-repayment alerts', 'Waterfall principal/interest', 'Premium SaaS support'],
      isActive: true,
    });
    await premiumPlan.save();
    console.log('Created Premium Unlimited Plan: ₹999/mo');
  } else {
    console.log('Premium Unlimited Plan already exists.');
  }

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
  tenant.subscriptionPlan = basicPlan._id;
  tenant.isFreeAccess = false;
  tenant.customPrice = undefined; // reset custom price

  await tenant.save();
  console.log(`✅ Tenant "${tenant.businessName}" (${tenant.username}) subscription status set to EXPIRED.`);
  console.log(`📅 Renewal Date set to: ${tenant.renewalDate.toISOString()}`);
  console.log('\n🎉 TEST SETUP READY!');
  console.log('💡 Now, open your browser dashboard (http://localhost:3000) and log in as "admin12".');
  console.log('💡 You will immediately see the Expired Subscription page blocking the dashboard!');
  console.log('💡 Click "Buy / Switch Plan" on any plan to test the auto-renewal simulation.');

  await mongoose.disconnect();
}

run();
