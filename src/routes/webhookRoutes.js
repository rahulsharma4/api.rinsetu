import express from 'express';
import Transaction from '../models/Transaction.js';
import CashBook from '../models/CashBook.js';
import { verifyWebhookSignature } from '../utils/paymentGatewayHelper.js';
import { rebuildInstallmentPayments } from '../utils/waterfallEngine.js';
import { logAuditAction } from '../utils/auditHelper.js';

const router = express.Router({ mergeParams: true });

/**
 * POST /api/webhooks/razorpay/:tenantId
 *
 * Public endpoint (no JWT needed — Razorpay calls this directly).
 * Razorpay sends the event here when a payment is captured.
 *
 * The tenantId in the URL identifies WHICH admin's account this payment belongs to.
 * The metadata inside the payload identifies WHICH loan and borrower to credit.
 *
 * Security: We verify the HMAC signature to ensure the request is from Razorpay.
 */
router.post('/:tenantId', express.raw({ type: 'application/json' }), async (req, res) => {
  const { tenantId } = req.params;
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body; // raw Buffer needed for HMAC verification

  try {
    // ── 1. Verify signature authenticity ─────────────────────────────────
    const isValid = await verifyWebhookSignature(tenantId, rawBody, signature);
    if (!isValid) {
      console.error(`❌ Razorpay webhook signature mismatch for tenant: ${tenantId}`);
      return res.status(400).json({ message: 'Invalid webhook signature.' });
    }

    // Parse payload
    const payload = JSON.parse(rawBody.toString());
    const event = payload.event;

    // ── 2. Handle only payment.captured event ────────────────────────────
    if (event !== 'payment.captured' && event !== 'order.paid' && event !== 'qr_code.credited') {
      return res.status(200).json({ message: 'Event acknowledged, no action required.' });
    }

    // Extract payment details from Razorpay payload
    const paymentData = payload.payload?.payment?.entity || payload.payload?.order?.entity;
    const qrCodeData = payload.payload?.qr_code?.entity;
    if (!paymentData) {
      return res.status(400).json({ message: 'Invalid payload structure.' });
    }

    // QR-code webhooks include the QR entity; payment.captured may include the
    // copied notes directly on payment. Accept both payload shapes.
    const notes = paymentData.notes || qrCodeData?.notes || {};
    const { loanId, customerId, paymentType, notes: txNotes, borrowerName } = notes;
    const amount = (paymentData.amount || 0) / 100; // Convert paise → rupees
    const razorpayPaymentId = paymentData.id || paymentData.payment_id;
    const razorpayOrderId = paymentData.order_id || payload.payload?.order?.entity?.id;
    const razorpayQrCodeId = paymentData.qr_code_id || paymentData.qrCodeId || qrCodeData?.id || '';

    if (!loanId || !customerId) {
      console.error('❌ Webhook missing loanId or customerId in notes:', notes);
      return res.status(400).json({ message: 'Missing loan metadata in payment notes.' });
    }

    // ── 3. Prevent duplicate processing ─────────────────────────────────
    const duplicate = await Transaction.findOne({ razorpayPaymentId, tenantId });
    if (duplicate) {
      console.log(`⚠️ Duplicate webhook ignored for payment: ${razorpayPaymentId}`);
      return res.status(200).json({ message: 'Already processed.' });
    }

    // ── 4. Record the transaction in database ────────────────────────────
    const newTx = await Transaction.create({
      loanId,
      customerId,
      tenantId,
      amount,
      paymentType: paymentType || 'both',
      paymentMode: 'upi',
      paymentDate: new Date(),
      notes: `UPI Auto-Pay via Razorpay. Ref: ${razorpayPaymentId}${txNotes ? '. ' + txNotes : ''}`,
      razorpayOrderId,
      razorpayQrCodeId,
      razorpayPaymentId,
      gatewayStatus: 'captured',
    });

    // ── 5. Rebuild installment waterfall allocation ───────────────────────
    await rebuildInstallmentPayments(loanId);

    // ── 6. Queue WhatsApp receipt notification ────────────────────────────
    try {
      const LoanModel = (await import('../models/Loan.js')).default;
      const InstallmentModel = (await import('../models/Installment.js')).default;
      const loanDoc = await LoanModel.findById(loanId);
      const insts = await InstallmentModel.find({ loanId });
      let totalInterestAccrued = 0, totalInterestPaid = 0, totalPrincipalPaid = 0;
      insts.forEach(inst => {
        totalInterestAccrued += inst.interestComponent;
        totalInterestPaid += inst.interestPaid || 0;
        totalPrincipalPaid += inst.principalPaid || 0;
      });
      const outstanding = Math.max(0, loanDoc.principalAmount - totalPrincipalPaid)
        + Math.max(0, totalInterestAccrued - totalInterestPaid);

      const { queueNotification } = await import('../utils/notificationCompiler.js');
      await queueNotification(customerId, loanId, 'payment_received', { amount, outstanding });
    } catch (notifErr) {
      console.warn('⚠️ Notification queuing failed (non-critical):', notifErr.message);
    }

    // ── 7. Audit trail log ────────────────────────────────────────────────
    await logAuditAction(
      'razorpay-webhook',
      'UPI_PAYMENT_AUTO_CAPTURED',
      `Auto-recorded UPI repayment of ₹${amount} for borrower "${borrowerName || customerId}" via Razorpay. Ref: ${razorpayPaymentId}`,
      null,
      newTx.toObject(),
      req
    );

    console.log(`✅ UPI Auto-Payment logged: ₹${amount} for loan ${loanId}`);
    res.status(200).json({ message: 'Payment recorded successfully.' });

  } catch (err) {
    console.error('❌ Webhook processing error:', err.message);
    // Return 200 to Razorpay so it doesn't retry endlessly on our app errors
    res.status(200).json({ message: 'Webhook received. Internal processing error logged.' });
  }
});

export default router;
