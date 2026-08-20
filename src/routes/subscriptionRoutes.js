import express from 'express';
import Razorpay from 'razorpay';
import User from '../models/User.js';
import Plan from '../models/Plan.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = express.Router();

// GET /api/subscriptions/status - Get subscription status of logged-in tenant
router.get('/status', authMiddleware, async (req, res) => {
  const tenantId = req.admin?.tenantId;
  try {
    const tenant = await User.findById(tenantId).populate('subscriptionPlan');
    if (!tenant) return res.status(404).json({ message: 'Tenant not found.' });

    const now = new Date();
    const trialDaysLeft = Math.max(0, Math.ceil((new Date(tenant.trialEndDate) - now) / (1000 * 60 * 60 * 24)));
    const renewalDaysLeft = Math.max(0, Math.ceil((new Date(tenant.renewalDate) - now) / (1000 * 60 * 60 * 24)));

    res.json({
      subscriptionStatus: tenant.subscriptionStatus,
      isFreeAccess: tenant.isFreeAccess,
      renewalDate: tenant.renewalDate,
      trialEndDate: tenant.trialEndDate,
      trialDaysLeft,
      renewalDaysLeft,
      customPrice: tenant.customPrice,
      plan: tenant.subscriptionPlan || {
        name: 'Trial / Free Plan',
        price: 0,
        maxBorrowers: -1,
        features: ['Core CRM Ledger', 'Waterfall Engine'],
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/subscriptions/plans - View all active subscription plans
router.get('/plans', authMiddleware, async (req, res) => {
  try {
    const plans = await Plan.find({ isActive: true }).sort({ price: 1 });
    res.json(plans);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// POST /api/subscriptions/renew - Initiate Razorpay order for subscription renewal
router.post('/renew', authMiddleware, async (req, res) => {
  const tenantId = req.admin?.tenantId;
  const { planId } = req.body;

  if (!planId) return res.status(400).json({ message: 'Plan ID batana zaroori hai.' });

  try {
    const tenant = await User.findById(tenantId);
    if (!tenant) return res.status(404).json({ message: 'Tenant not found.' });

    const plan = await Plan.findById(planId);
    if (!plan) return res.status(404).json({ message: 'Plan not found.' });

    // Use custom price if overridden by Superadmin, otherwise use plan price
    const finalPrice = tenant.customPrice !== undefined ? tenant.customPrice : plan.price;
    const finalPricePaise = Math.round(finalPrice * 100);

    // If plan is free (e.g. ₹0), activate immediately without Razorpay
    if (finalPricePaise === 0) {
      const now = new Date();
      const currentRenewal = new Date(tenant.renewalDate);
      const baseDate = currentRenewal > now ? currentRenewal : now;
      tenant.renewalDate = new Date(baseDate.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
      tenant.subscriptionStatus = 'active';
      tenant.subscriptionPlan = plan._id;
      await tenant.save();
      return res.json({ message: 'Trial/Free plan successfully activated!', success: true });
    }

    // Load Superadmin Razorpay credentials from .env
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      // In development bypass if keys are not set, auto-renew
      console.log('⚠️ Superadmin Razorpay keys missing in .env. Simulating auto-renewal...');
      const now = new Date();
      const currentRenewal = new Date(tenant.renewalDate);
      const baseDate = currentRenewal > now ? currentRenewal : now;
      tenant.renewalDate = new Date(baseDate.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
      tenant.subscriptionStatus = 'active';
      tenant.subscriptionPlan = plan._id;
      await tenant.save();
      return res.json({ message: 'Razorpay keys not configured. Simulating successful renewal!', success: true });
    }

    const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const order = await rzp.orders.create({
      amount: finalPricePaise,
      currency: 'INR',
      receipt: `sub_${tenantId}_${Date.now()}`,
      notes: {
        tenantId,
        planId: plan._id.toString(),
        type: 'subscription_renewal',
      },
    });

    res.json({
      orderId: order.id,
      amount: finalPrice,
      keyId,
      currency: 'INR',
      businessName: tenant.businessName,
      userEmail: tenant.username + '@rinsetu.com',
      userName: tenant.name,
      planName: plan.name,
    });

  } catch (error) {
    res.status(500).json({ message: 'Order generation failed: ' + error.message });
  }
});

// ── SUPERADMIN WEBHOOK ROUTE FOR SUBSCRIPTIONS ─────────────────────────────
// Public route to receive callbacks when an admin pays their subscription fee.
export async function subscriptionWebhookHandler(req, res) {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body;

  try {
    // Verify signature if webhook secret is configured
    const webhookSecret = process.env.SUPERADMIN_WEBHOOK_SECRET;
    if (webhookSecret && signature) {
      const { createHmac } = await import('crypto');
      const expectedSig = createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');
      if (expectedSig !== signature) {
        console.error('❌ Superadmin webhook signature mismatch.');
        return res.status(400).json({ message: 'Invalid webhook signature.' });
      }
    }

    const payload = JSON.parse(rawBody.toString());
    const event = payload.event;

    if (event !== 'payment.captured' && event !== 'order.paid') {
      return res.status(200).json({ message: 'Acknowledged.' });
    }

    const paymentData = payload.payload?.payment?.entity || payload.payload?.order?.entity;
    if (!paymentData) return res.status(400).json({ message: 'No payment entity.' });

    const notes = paymentData.notes || {};
    const { tenantId, planId, type } = notes;

    if (type !== 'subscription_renewal' || !tenantId || !planId) {
      return res.status(200).json({ message: 'Non-subscription event ignored.' });
    }

    const tenant = await User.findById(tenantId);
    if (!tenant) return res.status(404).json({ message: 'Tenant not found.' });

    const plan = await Plan.findById(planId);
    if (!plan) return res.status(404).json({ message: 'Plan not found.' });

    // Extend subscription renewalDate
    const now = new Date();
    const currentRenewal = new Date(tenant.renewalDate);
    const baseDate = currentRenewal > now ? currentRenewal : now;

    tenant.renewalDate = new Date(baseDate.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
    tenant.subscriptionStatus = 'active';
    tenant.subscriptionPlan = plan._id;
    await tenant.save();

    console.log(`✅ Subscription renewed successfully: Tenant "${tenant.businessName}" extended to ${tenant.renewalDate.toLocaleDateString()}`);
    res.status(200).json({ message: 'Subscription successfully extended.' });

  } catch (error) {
    console.error('❌ Subscription Webhook error:', error.message);
    res.status(200).json({ message: 'Processed with internal error logged.' });
  }
// POST /api/subscriptions/verify-payment - Verify Razorpay signature and extend subscription
router.post('/verify-payment', authMiddleware, async (req, res) => {
  const tenantId = req.admin?.tenantId;
  const { razorpayPaymentId, razorpayOrderId, razorpaySignature, planId } = req.body;

  if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature || !planId) {
    return res.status(400).json({ message: 'Sabhi signature verification details zaroori hain.' });
  }

  try {
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return res.status(500).json({ message: 'Razorpay keys not configured on server.' });
    }

    const { createHmac } = await import('crypto');
    const expectedSig = createHmac('sha256', keySecret)
      .update(razorpayOrderId + '|' + razorpayPaymentId)
      .digest('hex');

    if (expectedSig !== razorpaySignature) {
      return res.status(400).json({ message: 'Invalid payment signature verification failed.' });
    }

    const tenant = await User.findById(tenantId);
    if (!tenant) return res.status(404).json({ message: 'Tenant not found.' });

    const plan = await Plan.findById(planId);
    if (!plan) return res.status(404).json({ message: 'Plan not found.' });

    // Extend subscription
    const now = new Date();
    const currentRenewal = new Date(tenant.renewalDate);
    const baseDate = currentRenewal > now ? currentRenewal : now;

    tenant.renewalDate = new Date(baseDate.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
    tenant.subscriptionStatus = 'active';
    tenant.subscriptionPlan = plan._id;
    await tenant.save();

    res.json({
      message: 'Subscription successfully extended! ✅',
      success: true,
      renewalDate: tenant.renewalDate,
    });

  } catch (error) {
    res.status(500).json({ message: 'Verification failed: ' + error.message });
  }
});

export default router;
