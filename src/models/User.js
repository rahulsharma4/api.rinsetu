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
  },
  {
    timestamps: true,
  }
);

const User = mongoose.model('User', userSchema);
export default User;
