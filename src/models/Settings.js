import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema(
  {
    waterfallPriority: {
      type: [String],
      default: ['dueCharges', 'lateCharges', 'interest', 'principal'],
    },
    whatsappAutomation: {
      type: Boolean,
      default: true,
    },
    whatsappTemplates: {
      upcomingDue: {
        type: String,
        default: 'Namaste {{customerName}} ji, aapka installment ₹{{amount}} date {{dueDate}} ko due hai. Kripya samay par bhugtan karein. - RinSetu',
      },
      dueToday: {
        type: String,
        default: 'Namaste {{customerName}} ji, aapka installment ₹{{amount}} aaj due hai. Kripya GPay/Cash se clear karein. Dhanyawad. - RinSetu',
      },
      paymentReceived: {
        type: String,
        default: 'Namaste {{customerName}} ji, aapka payment ₹{{amount}} prapt hua. Aapka outstanding principal ab ₹{{outstanding}} hai. - RinSetu',
      },
      overdueReminder: {
        type: String,
        default: 'Aadarniya {{customerName}} ji, aapka loan account ID {{loanId}} par ₹{{amount}} abhi tak overdue hai. Kripya turant clear karein. - RinSetu',
      },
      loanClosed: {
        type: String,
        default: 'Badhai ho {{customerName}} ji! Aapka loan ID {{loanId}} ab poori tarah close ho gaya hai. Aapka closure statement ready hai. - RinSetu',
      },
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

const Settings = mongoose.model('Settings', settingsSchema);
export default Settings;
