import mongoose from 'mongoose';

const installmentSchema = new mongoose.Schema(
  {
    loanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Loan',
      required: true,
    },
    installmentNumber: {
      type: Number,
      required: true,
    },
    dueDate: {
      type: Date,
      required: true,
    },
    principalComponent: {
      type: Number,
      required: true,
      min: 0,
    },
    interestComponent: {
      type: Number,
      required: true,
      min: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    amountPaid: {
      type: Number,
      default: 0,
      min: 0,
    },
    principalPaid: {
      type: Number,
      default: 0,
      min: 0,
    },
    interestPaid: {
      type: Number,
      default: 0,
      min: 0,
    },
    lateFeePaid: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ['unpaid', 'partially_paid', 'paid', 'overdue', 'upcoming'],
      default: 'unpaid',
    },
    isRestructured: {
      type: Boolean,
      default: false,
    },
    lastPaymentDate: {
      type: Date,
    },
    lateFeeLastAppliedDate: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index to ensure installment uniqueness per loan
installmentSchema.index({ loanId: 1, installmentNumber: 1 }, { unique: true });

const Installment = mongoose.model('Installment', installmentSchema);
export default Installment;
