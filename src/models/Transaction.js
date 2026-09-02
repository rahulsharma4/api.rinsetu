import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema(
  {
    loanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Loan',
      required: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    paymentType: {
      type: String,
      enum: ['interest', 'principal', 'both', 'fine', 'excess_prepay', 'late_charges'],
      default: 'both',
    },
    paymentMode: {
      type: String,
      enum: ['cash', 'online', 'bank_transfer', 'cheque', 'upi'],
      default: 'cash',
    },
    paymentDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    allocatedPrincipal: {
      type: Number,
      default: 0,
    },
    allocatedInterest: {
      type: Number,
      default: 0,
    },
    allocatedLateFee: {
      type: Number,
      default: 0,
    },
    allocatedDueCharges: {
      type: Number,
      default: 0,
    },
    excessAdvanceUsed: {
      type: Number,
      default: 0,
    },
    notes: {
      type: String,
      trim: true,
    },
    isReversed: {
      type: Boolean,
      default: false,
    },
    // ── Razorpay Gateway fields (populated only for UPI auto-payments) ────
    razorpayOrderId: {
      type: String,
      default: '',
    },
    razorpayQrCodeId: {
      type: String,
      default: '',
    },
    razorpayPaymentId: {
      type: String,
      default: '',
      index: true, // For fast duplicate-check lookups
    },
    gatewayStatus: {
      type: String,
      enum: ['pending', 'captured', 'failed', ''],
      default: '',
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', ''],
      default: '',
    },
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    geo_location: {
      lat: { type: Number },
      lng: { type: Number },
      timestamp: { type: Date }
    },
  },
  {
    timestamps: true,
  }
);

const Transaction = mongoose.model('Transaction', transactionSchema);
export default Transaction;
