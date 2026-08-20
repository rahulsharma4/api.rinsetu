import mongoose from 'mongoose';
import dotenv from 'dotenv';
import axios from 'axios';
import dns from 'dns';
import Loan from '../models/Loan.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';

// Force DNS to resolve IPv4 first (fixes MongoDB querySrv ECONNREFUSED in local ISPs)
try {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
  if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch (err) {
  console.warn('⚠️ DNS custom configuration failed (ignoring):', err.message);
}

dotenv.config();

async function run() {
  console.log('🔄 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB.');

  // Find an active loan
  const loan = await Loan.findOne({ status: 'active' }).populate('customerId');
  if (!loan) {
    console.error('❌ No active loan found to simulate a payment for.');
    process.exit(1);
  }
  const tenantId = loan.tenantId.toString();

  const amountToPay = 5000; // Simulated payment amount in Rupees (Rs. 5000)
  const amountPaise = amountToPay * 100; // Razorpay expects paise

  const paymentId = 'pay_MOCK' + Math.random().toString(36).substring(2, 10).toUpperCase();
  const orderId = 'order_MOCK' + Math.random().toString(36).substring(2, 10).toUpperCase();

  // Generate Razorpay webhook mock payload
  const mockWebhookPayload = {
    entity: 'event',
    account_id: 'acc_MOCK12345',
    event: 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          entity: 'payment',
          amount: amountPaise,
          currency: 'INR',
          status: 'captured',
          order_id: orderId,
          invoice_id: null,
          international: false,
          method: 'upi',
          amount_refunded: 0,
          refund_status: null,
          captured: true,
          description: 'RinSetu loan repayment',
          card_id: null,
          bank: null,
          wallet: null,
          vpa: 'borrower@upi',
          email: 'borrower@example.com',
          contact: '+919999999999',
          notes: {
            tenantId: tenantId,
            loanId: loan._id.toString(),
            customerId: loan.customerId._id.toString(),
            paymentType: 'both',
            notes: 'Mock UPI Payment via Test Script',
            borrowerName: loan.customerId.name,
          },
          fee: 0,
          tax: 0,
          error_code: null,
          error_description: null,
          error_source: null,
          error_step: null,
          error_reason: null,
          acquirer_data: {
            rrn: '123456789012',
            upi_transaction_id: 'MOCK' + Math.random().toString(36).substring(2, 12).toUpperCase(),
          },
          created_at: Math.floor(Date.now() / 1000),
        },
      },
    },
  };

  const webhookUrl = `http://localhost:5001/api/webhooks/razorpay/${tenantId}`;
  
  console.log(`\n🚀 Sending Mock Webhook to: ${webhookUrl}`);
  console.log(`👤 Borrower: ${loan.customerId.name}`);
  console.log(`💰 Amount: ₹${amountToPay}`);
  console.log(`💳 Ref ID: ${paymentId}`);

  try {
    const response = await axios.post(webhookUrl, mockWebhookPayload, {
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': 'mock-dev-signature-skipped', // will bypass signature if gatewayWebhookSecret is empty
      },
    });
    console.log('\n✅ Webhook response from server:', response.data);
    console.log('🎉 Check your browser dashboard and borrower ledger, the payment should be added!');
  } catch (error) {
    console.error('\n❌ Webhook delivery failed:', error.response?.data || error.message);
    console.log('💡 Ensure your server is running on http://localhost:5001 before running this script.');
  } finally {
    await mongoose.disconnect();
  }
}

run();
