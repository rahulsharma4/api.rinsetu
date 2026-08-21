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
    processedSubscriptionOrders: {
      type: [String],
      default: [],
      select: false,
    },
    whatsappAccessToken: {
      type: String,
      default: '',
      select: false,
    },
    whatsappPhoneNumberId: {
      type: String,
      default: '',
      select: false,
    },
    whatsappEnabled: {
      type: Boolean,
      default: false,
    },
    whatsappTemplates: {
      type: Map,
      of: String,
      default: {
        upcomingDue: 'upcoming_due',
        dueToday: 'due_today',
        paymentReceived: 'payment_received',
        overdueWarning: 'overdue_warning'
      }
    },
    payoutBankAccountNumber: {
      type: String,
      default: ''
    },
    payoutBankIfsc: {
      type: String,
      default: ''
    },
    payoutBankBeneficiaryName: {
      type: String,
      default: ''
    },
    payoutLinkedAccountId: {
      type: String,
      default: ''
    },
    payoutEnabled: {
      type: Boolean,
      default: false
    },
    paymentModePreference: {
      type: String,
      enum: ['byok', 'central_split'],
      default: 'byok'
    }
  },
  {
    timestamps: true,
  }
);

const User = mongoose.model('User', userSchema);
export default User;
