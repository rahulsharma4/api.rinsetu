import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Loan from '../models/Loan.js';
import { generateUPIPaymentOrder } from '../utils/paymentGatewayHelper.js';

dotenv.config();

async function runTest() {
  console.log('🔌 Connecting to database for testing...');
  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/byaj';
  await mongoose.connect(mongoUri);

  try {
    // 1. Find a test admin user
    const testAdmin = await User.findOne({ role: 'admin' });
    if (!testAdmin) {
      console.log('❌ No admin user found in database to run tests!');
      return;
    }

    console.log(`👤 Found test admin: ${testAdmin.name} (${testAdmin.username})`);
    
    // Save original settings to restore later
    const originalPreference = testAdmin.paymentModePreference;
    const originalLinkedAccount = testAdmin.payoutLinkedAccountId;
    const originalPayoutEnabled = testAdmin.payoutEnabled;

    // 2. Temporarily set up central split mode in DB for testing
    testAdmin.paymentModePreference = 'central_split';
    testAdmin.payoutLinkedAccountId = 'acc_testLinkedAccount123';
    testAdmin.payoutEnabled = true;
    await testAdmin.save();
    console.log('✅ Temporarily configured test admin for central split payout mode.');

    // 3. Find or create a dummy customer and loan for testing
    let testCustomer = await Customer.findOne({ tenantId: testAdmin._id });
    if (!testCustomer) {
      testCustomer = new Customer({
        name: 'Test Customer',
        phone: '9999999999',
        tenantId: testAdmin._id
      });
      await testCustomer.save();
    }

    let testLoan = await Loan.findOne({ tenantId: testAdmin._id });
    if (!testLoan) {
      testLoan = new Loan({
        customerId: testCustomer._id,
        principalAmount: 10000,
        interestRate: 2,
        rateType: 'monthly',
        interestType: 'simple',
        paymentFrequency: 'monthly',
        tenure: 12,
        startDate: new Date(),
        tenantId: testAdmin._id
      });
      await testLoan.save();
    }

    // 4. Test generateUPIPaymentOrder
    console.log('🔄 Triggering generateUPIPaymentOrder for central split payout...');
    const result = await generateUPIPaymentOrder(testAdmin._id, {
      loanId: testLoan._id,
      customerId: testCustomer._id,
      borrowerName: testCustomer.name,
      amount: 500,
      paymentType: 'both',
      notes: 'Split payout integration test'
    });

    console.log('📊 Test Results:');
    console.log(`- Amount: ₹${result.amount}`);
    console.log(`- QR Code Image URL: ${result.qrImageUrl}`);
    console.log(`- Direct UPI link / Checkout: ${result.imageContent}`);
    console.log(`- Using Master Key ID: ${result.keyId}`);

    if (result.qrCodeId && result.qrImageUrl && result.imageContent.startsWith('https://')) {
      console.log('🎉 SUCCESS! Central split payout QR / Payment Link generation verified successfully!');
    } else {
      console.log('⚠️ Warning: Some parameters did not match expectations.');
    }

    // 5. Restore original settings
    testAdmin.paymentModePreference = originalPreference;
    testAdmin.payoutLinkedAccountId = originalLinkedAccount;
    testAdmin.payoutEnabled = originalPayoutEnabled;
    await testAdmin.save();
    console.log('♻️ Restored original admin database settings.');

  } catch (err) {
    console.error('❌ Test failed with error:', err.message);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from database.');
  }
}

runTest();
