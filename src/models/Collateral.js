import mongoose from 'mongoose';

const collateralSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },
    loanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Loan',
      default: null,
    },
    assetName: {
      type: String,
      required: true,
      trim: true,
    },
    assetType: {
      type: String,
      enum: ['gold', 'silver', 'vehicle', 'property', 'documents', 'other'],
      default: 'other',
    },
    weight: {
      type: Number, // In grams/units (optional, e.g. for gold/silver)
      default: 0,
    },
    quantity: {
      type: Number,
      default: 1,
    },
    estimatedValue: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: ['pledged', 'released', 'liquidated'],
      default: 'pledged',
    },
    remarks: {
      type: String,
      trim: true,
      default: '',
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

const Collateral = mongoose.model('Collateral', collateralSchema);
export default Collateral;
