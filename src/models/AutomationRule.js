import mongoose from 'mongoose';

const automationRuleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    eventTrigger: {
      type: String,
      enum: ['overdue', 'repayment_received', 'loan_closed', 'loan_approved'],
      required: true,
    },
    conditions: {
      daysOverdue: { type: Number, default: 0 },
      minPaidAmount: { type: Number, default: 0 },
    },
    actions: {
      type: [String], // e.g. ['send_whatsapp_reminder', 'notify_admin', 'generate_certificate']
      default: ['send_whatsapp_reminder'],
    },
    isActive: {
      type: Boolean,
      default: true,
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

const AutomationRule = mongoose.model('AutomationRule', automationRuleSchema);
export default AutomationRule;
