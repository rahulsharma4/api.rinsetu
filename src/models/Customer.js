import mongoose from 'mongoose';

const customerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    address: {
      type: String,
      trim: true,
    },
    occupation: {
      type: String,
      trim: true,
    },
    aadharNumber: {
      type: String,
      trim: true,
    },
    panNumber: {
      type: String,
      trim: true,
    },
    bankAccountNumber: {
      type: String,
      trim: true,
    },
    guarantorName: {
      type: String,
      trim: true,
    },
    guarantorPhone: {
      type: String,
      trim: true,
    },
    guarantorAddress: {
      type: String,
      trim: true,
    },
    guarantorIdDoc: {
      type: String,
      trim: true,
    },
    collateralType: {
      type: String,
      default: 'None',
    },
    collateralDescription: {
      type: String,
      trim: true,
    },
    collateralValue: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['Active', 'Blocked'],
      default: 'Active',
    },
    documents: [
      {
        label: { type: String, required: true },
        filename: { type: String, required: true },
        fileUrl: { type: String, required: true },
        uploadedAt: { type: Date, default: Date.now }
      }
    ],
    email: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
    },
    isPortalEnabled: {
      type: Boolean,
      default: false,
    },
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    }
  },
  {
    timestamps: true,
  }
);

const Customer = mongoose.model('Customer', customerSchema);
export default Customer;
