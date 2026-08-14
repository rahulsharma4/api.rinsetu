import mongoose from 'mongoose';

const automationLogSchema = new mongoose.Schema(
  {
    ruleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AutomationRule',
    },
    loanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Loan',
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
    },
    eventTrigger: {
      type: String,
      required: true,
    },
    messageSent: {
      type: String,
    },
    status: {
      type: String,
      enum: ['pending', 'success', 'failed'],
      default: 'success',
    },
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  }
);

const AutomationLog = mongoose.model('AutomationLog', automationLogSchema);
export default AutomationLog;
