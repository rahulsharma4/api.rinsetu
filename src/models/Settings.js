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
        default: '🙏 नमस्ते {{customerName}} जी,\n━━━━━━━━━━━━━━━━━━━━\nआपका ऋण खाता (Loan ID: {{loanId}}) की अगली किश्त {{dueDate}} को देय है।\n💰 राशि: *₹{{amount}}*\n\nकृपया समय पर भुगतान करें।\n💳 ऑनलाइन पेमेंट लिंक:\n👉 {{paymentLink}}\n\n_RinSetu - आपका डिजिटल ऋण सहायक_ 🏦',
      },
      dueToday: {
        type: String,
        default: '🙏 नमस्ते {{customerName}} जी,\n━━━━━━━━━━━━━━━━━━━━\nआपका ऋण खाता (Loan ID: {{loanId}}) की किश्त *आज* देय है।\n💰 राशि: *₹{{amount}}*\n\nकृपया आज ही भुगतान करें ताकि लेट फीस से बचा जा सके।\n💳 ऑनलाइन पेमेंट लिंक:\n👉 {{paymentLink}}\n\n_RinSetu - आपका डिजिटल ऋण सहायक_ 🏦',
      },
      paymentReceived: {
        type: String,
        default: '✅ भुगतान प्राप्त हुआ\n━━━━━━━━━━━━━━━━━━━━\nनमस्ते {{customerName}} जी,\nहमें आपका ₹{{amount}} का भुगतान प्राप्त हो गया है।\n\n📌 आपका शेष मूलधन (Outstanding Principal) अब ₹{{outstanding}} है।\n\nधन्यवाद!\n_RinSetu - आपका डिजिटल ऋण सहायक_ 🏦',
      },
      overdueReminder: {
        type: String,
        default: '⚠️ ओवरड्यू रिमाइंडर\n━━━━━━━━━━━━━━━━━━━━\nआदरणीय {{customerName}} जी,\nआपका ऋण खाता (Loan ID: {{loanId}}) पर ₹{{amount}} अभी तक ओवरड्यू (बकाया) है।\n\nकृपया तुरंत भुगतान करें ताकि आपके खाते पर और जुर्माना न लगे।\n💳 ऑनलाइन पेमेंट लिंक:\n👉 {{paymentLink}}\n\n_RinSetu - आपका डिजिटल ऋण सहायक_ 🏦',
      },
      loanClosed: {
        type: String,
        default: '🎉 बधाई हो {{customerName}} जी!\n━━━━━━━━━━━━━━━━━━━━\nआपका ऋण खाता (Loan ID: {{loanId}}) अब पूरी तरह से बंद (Close) हो गया है।\n\nआप अपना क्लोज़र स्टेटमेंट पोर्टल से प्राप्त कर सकते हैं। हमारे साथ जुड़ने के लिए धन्यवाद!\n\n_RinSetu - आपका डिजिटल ऋण सहायक_ 🏦',
      },
      guarantorWarning: {
        type: String,
        default: '⚠️ गारंटर चेतावनी\n━━━━━━━━━━━━━━━━━━━━\nनमस्ते {{guarantorName}} जी,\nआपने {{customerName}} के ऋण (Loan ID: {{loanId}}) की गारंटी ली थी।\nउनका खाता अभी ओवरड्यू है और बकाया राशि ₹{{amount}} है।\n\nकृपया उनसे संपर्क करें और भुगतान सुनिश्चित करें।\n\n_RinSetu - आपका डिजिटल ऋण सहायक_ 🏦',
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
