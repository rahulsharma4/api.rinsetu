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
    // ── Direct VPA P2P UPI Settings ───────────────────────────────────────
    upiId: {
      type: String,
      default: '',
    },
    upiName: {
      type: String,
      default: '',
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
        upcomingDue: 'Namaste {{customerName}} ji, aapka installment ₹{{amount}} date {{dueDate}} ko due hone wala hai. Kripya samay par bhugtan karein: {{paymentLink}} - RinSetu',
        dueToday: 'Namaste {{customerName}} ji, aapka installment ₹{{amount}} aaj due hai. Kripya is link se pay karein: {{paymentLink}} ya Cash se clear karein. Dhanyawad. - RinSetu',
        paymentReceived: 'Namaste {{customerName}} ji, aapka payment ₹{{amount}} prapt hua. Aapka outstanding balance ab ₹{{outstanding}} hai. - RinSetu',
        overdueWarning: 'Aadarniya {{customerName}} ji, aapka loan account par ₹{{amount}} abhi tak overdue hai. Penalty se bachne ke liye click karein: {{paymentLink}} - RinSetu'
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
