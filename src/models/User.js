import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      default: 'Administrator',
    },
    role: {
      type: String,
      enum: ['super-admin', 'admin', 'manager', 'collector'],
      default: 'admin',
    },
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    businessName: {
      type: String,
      default: 'RinSetu',
    },
    status: {
      type: String,
      enum: ['Active', 'Suspended'],
      default: 'Active',
    },
    // ── Razorpay Payment Gateway (per-tenant, optional) ──────────────────
    gatewayKeyId: {
      type: String,
      default: '',
      select: false, // Not included by default for security
    },
    gatewayKeySecret: {
      type: String,
      default: '',
      select: false, // Never expose in API responses
    },
    gatewayWebhookSecret: {
      type: String,
      default: '',
      select: false,
    },
    // ── SaaS Subscription & Billing ──────────────────────────────────────
    subscriptionStatus: {
      type: String,
      enum: ['trial', 'active', 'expired', 'suspended'],
      default: 'trial',
    },
    subscriptionPlan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Plan',
    },
    trialStartDate: {
      type: Date,
      default: Date.now,
    },
    trialEndDate: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Default 30 days trial
    },
    renewalDate: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
    isFreeAccess: {
      type: Boolean,
      default: false,
    },
    customPrice: {
      type: Number,
    },
  },
  {
    timestamps: true,
  }
);

const User = mongoose.model('User', userSchema);
export default User;
