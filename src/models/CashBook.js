import mongoose from 'mongoose';

const cashBookSchema = new mongoose.Schema(
  {
    paymentDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    type: {
      type: String,
      enum: ['disbursement', 'collection', 'penalty_charge', 'opening_balance', 'expense'],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    paymentMode: {
      type: String,
      enum: ['cash', 'online', 'bank_transfer', 'cheque'],
      required: true,
      default: 'cash',
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
    },
    loanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Loan',
    },
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
    },
    notes: {
      type: String,
      trim: true,
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

const CashBook = mongoose.model('CashBook', cashBookSchema);
export default CashBook;
