import Razorpay from 'razorpay';
import User from '../models/User.js';

/**
 * Fetches the Razorpay credentials for a given tenantId from the database.
 * Falls back to .env RAZORPAY_KEY_ID / KEY_SECRET if the admin hasn't
 * configured their own keys yet (useful for testing).
 */
async function getTenantRazorpayClient(tenantId) {
  const adminUser = await User.findById(tenantId).select('+gatewayKeyId +gatewayKeySecret');

  const keyId     = adminUser?.gatewayKeyId   || process.env.RAZORPAY_KEY_ID;
  const keySecret = adminUser?.gatewayKeySecret || process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error('GATEWAY_NOT_CONFIGURED');
  }

  return {
    client: new Razorpay({ key_id: keyId, key_secret: keySecret }),
    keyId,
    webhookSecret: adminUser?.gatewayWebhookSecret || '',
  };
}

/**
 * Generates a Razorpay UPI Payment Order with embedded metadata.
 * The metadata links the order to the exact loan/borrower so webhook can
 * auto-reconcile — even if multiple borrowers pay the same amount simultaneously.
 *
 * @param {string} tenantId - Admin's MongoDB ID (used to load their API keys)
 * @param {object} meta - { loanId, customerId, paymentType, amount, notes }
 * @returns {{ orderId, qrDataUrl, upiIntent, keyId, amount }}
 */
export async function generateUPIPaymentOrder(tenantId, meta) {
  const { client, keyId } = await getTenantRazorpayClient(tenantId);

  const amountPaise = Math.round(parseFloat(meta.amount) * 100); // Razorpay expects paise
  if (amountPaise < 100) throw new Error('Minimum payment amount is ₹1.');

  // Create Razorpay Order with metadata embedded for webhook reconciliation
  const order = await client.orders.create({
    amount: amountPaise,
    currency: 'INR',
    payment_capture: 1, // Auto-capture on payment
    notes: {
      tenantId: String(tenantId),
      loanId: String(meta.loanId),
      customerId: String(meta.customerId),
      paymentType: meta.paymentType || 'both',
      notes: meta.notes || '',
      borrowerName: meta.borrowerName || '',
    },
  });

  // Build UPI QR deep link for the order
  // This URL is rendered into a QR code on the frontend
  const upiIntent = `upi://pay?pa=&tr=${order.id}&am=${meta.amount}&cu=INR&tn=LoanRepayment`;

  return {
    orderId: order.id,
    amount: meta.amount,
    amountPaise,
    upiIntent,
    keyId,
    currency: 'INR',
    // Notes echoed back so frontend can display borrower name
    borrowerName: meta.borrowerName,
  };
}

/**
 * Verifies Razorpay webhook HMAC signature.
 * Uses the tenant's webhookSecret to confirm the request is genuine.
 */
export async function verifyWebhookSignature(tenantId, rawBody, signature) {
  const { webhookSecret } = await getTenantRazorpayClient(tenantId);
  if (!webhookSecret) return true; // If not configured, skip check (dev mode)

  const { createHmac } = await import('crypto');
  const expectedSig = createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  return expectedSig === signature;
}
