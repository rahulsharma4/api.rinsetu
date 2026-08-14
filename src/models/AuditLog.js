import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      default: 'admin',
    },
    action: {
      type: String,
      required: true, // e.g. 'LOAN_CREATED', 'PAYMENT_REVERSED', 'CUSTOMER_UPDATED'
    },
    details: {
      type: String,
      required: true,
    },
    oldValue: {
      type: mongoose.Schema.Types.Mixed,
    },
    newValue: {
      type: mongoose.Schema.Types.Mixed,
    },
    ipAddress: {
      type: String,
    },
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false }
  }
);

const AuditLog = mongoose.model('AuditLog', auditLogSchema);
export default AuditLog;
