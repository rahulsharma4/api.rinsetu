import mongoose from 'mongoose';

const loanSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },
    principalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    processingFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    interestRate: {
      type: Number,
      required: true,
      min: 0,
    },
    rateType: {
      type: String,
      enum: ['daily', 'weekly', 'monthly', 'yearly'],
      default: 'monthly',
    },
    interestType: {
      type: String,
      enum: ['flat', 'reducing', 'simple'],
      default: 'simple',
    },
    compoundingPeriod: {
      type: String,
      enum: ['none', 'monthly', 'quarterly', 'yearly'],
      default: 'none',
    },
    paymentFrequency: {
      type: String,
      enum: ['daily', 'weekly', 'monthly', 'yearly'],
      default: 'monthly',
    },
    startDate: {
      type: Date,
      required: true,
    },
    tenure: {
      type: Number,
      required: true,
      min: 1,
    },
    status: {
      type: String,
      enum: ['active', 'paid', 'overdue', 'closed'],
      default: 'active',
    },
    closureDate: {
      type: Date,
    },
    isRestructured: {
      type: Boolean,
      default: false,
    },
    restructuredFromLoanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Loan',
    },
    dueCharges: {
      type: Number,
      default: 0,
      min: 0,
    },
    dueChargesPaid: {
      type: Number,
      default: 0,
      min: 0,
    },
    lateCharges: {
      type: Number,
      default: 0,
      min: 0,
    },
    lateChargesPaid: {
      type: Number,
      default: 0,
      min: 0,
    },
    excessAdvanceBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    lateFeeRate: {
      type: Number,
      default: 50,
      min: 0,
    },
    lateFeeType: {
      type: String,
      enum: ['daily', 'flat'],
      default: 'daily',
    },
    remarks: {
      type: String,
      trim: true,
    },
    isExistingLoan: {
      type: Boolean,
      default: false,
    },
    alreadyPaidInstallments: {
      type: Number,
      default: 0,
      min: 0,
    },
    skipCashBookOutflow: {
      type: Boolean,
      default: false,
    },
    dayCountBasis: {
      type: String,
      enum: ['30_360', 'act_365'],
      default: '30_360',
    },
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

const Loan = mongoose.model('Loan', loanSchema);
export default Loan;
