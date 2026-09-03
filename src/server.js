import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import dns from 'dns';
import helmet from 'helmet';
import mongoSanitize from 'express-mongo-sanitize';
import { rateLimit } from 'express-rate-limit';

// Force DNS to resolve IPv4 first (fixes MongoDB querySrv ECONNREFUSED in local ISPs)
if (process.env.NODE_ENV !== 'production') {
  try {
    dns.setServers(['8.8.8.8', '8.8.4.4']);
    if (dns.setDefaultResultOrder) {
      dns.setDefaultResultOrder('ipv4first');
    }
  } catch (err) {
    console.warn('⚠️ DNS custom configuration failed (ignoring):', err.message);
  }
}

dotenv.config();

// Import routes
import authRoutes from './routes/authRoutes.js';
import customerRoutes from './routes/customerRoutes.js';
import loanRoutes from './routes/loanRoutes.js';
import transactionRoutes from './routes/transactionRoutes.js';
import aiRoutes from './routes/aiRoutes.js';
import collectionRoutes from './routes/collectionRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import settingsRoutes from './routes/settingsRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import superAdminRoutes from './routes/superAdminRoutes.js';
import webhookRoutes from './routes/webhookRoutes.js';
import subscriptionRoutes, { subscriptionWebhookHandler } from './routes/subscriptionRoutes.js';
import borrowerRoutes from './routes/borrowerRoutes.js';
import publicRoutes from './routes/publicRoutes.js';
import collateralRoutes from './routes/collateralRoutes.js';
import whatsappRoutes from './routes/whatsappRoutes.js';
import { initWhatsApp } from './utils/whatsappService.js';
import { subscriptionMiddleware } from './middleware/subscriptionMiddleware.js';

import { startCronEngine } from './utils/cronJob.js';
import { seedAdminUser, cleanupDefaultAdmin } from './utils/dbSeeder.js';

// Import auth middleware
import { authMiddleware } from './middleware/authMiddleware.js';

const app = express();
const PORT = process.env.PORT || 5001;

// SECURITY REINFORCEMENTS MIDDLEWARE
app.use(helmet({
  crossOriginResourcePolicy: false // Allows loading uploaded static doc files in frontend
}));
app.use(mongoSanitize()); // Prevent NoSQL injection attacks

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Max 100 requests per IP per 15 mins
  message: { message: 'Too many authentication attempts from this IP, please try again after 15 minutes.' }
});

// Middlewares
app.use(cors());

// Razorpay must receive the untouched request bytes so its HMAC signature can
// be verified. Register this route before the JSON parser below.
app.use('/api/webhooks/razorpay', webhookRoutes);
app.post('/api/subscriptions/webhooks/renewals', express.raw({ type: 'application/json' }), subscriptionWebhookHandler);

app.use(express.json());

app.use('/api/subscriptions', subscriptionRoutes);

// Serves customer KYC document files
app.use('/uploads', express.static('./uploads'));

// ============================================
// PUBLIC ROUTES
// ============================================
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/public', publicRoutes);

// Health check
app.get('/', (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  res.json({ status: 'online', database: dbStatus, timestamp: new Date() });
});

// ============================================
// PROTECTED ROUTES (JWT + MongoDB zaroori)
// ============================================
app.use('/api/customers', authMiddleware, subscriptionMiddleware, customerRoutes);
app.use('/api/loans', authMiddleware, subscriptionMiddleware, loanRoutes);
app.use('/api/transactions', authMiddleware, subscriptionMiddleware, transactionRoutes);
app.use('/api/ai', authMiddleware, subscriptionMiddleware, aiRoutes);
app.use('/api/collection', authMiddleware, subscriptionMiddleware, collectionRoutes);
app.use('/api/reports', authMiddleware, subscriptionMiddleware, reportRoutes);
app.use('/api/settings', authMiddleware, subscriptionMiddleware, settingsRoutes);
app.use('/api/notifications', authMiddleware, subscriptionMiddleware, notificationRoutes);
app.use('/api/superadmin', authMiddleware, superAdminRoutes);
app.use('/api/borrower', authMiddleware, subscriptionMiddleware, borrowerRoutes);
app.use('/api/collateral', authMiddleware, subscriptionMiddleware, collateralRoutes);
app.use('/api/whatsapp', authMiddleware, subscriptionMiddleware, whatsappRoutes);

// ============================================
// EXPRESS SERVER PEHLE START KARO
// ============================================
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`🔑 Auth endpoint ready: POST /api/auth/login`);
  console.log(`⏳ Connecting to MongoDB Atlas...`);

  connectDatabase();
  initWhatsApp();
});

// ============================================
// DATABASE CONNECTION (Retry with backoff)
// ============================================
const MONGODB_URI = process.env.MONGODB_URI;

async function connectDatabase(attempt = 1) {
  if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI is not defined in .env file.');
    return;
  }

  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Successfully connected to MongoDB Atlas!');
    
    // Seed default admin user if not present
    await seedAdminUser();
    await cleanupDefaultAdmin();
    
    // --- TEMPORARY MIGRATION: Update existing settings to new professional templates ---
    try {
      const Settings = (await import('./models/Settings.js')).default;
      const settingsList = await Settings.find({});
      for (const s of settingsList) {
        let updated = false;
        if (s.whatsappTemplates?.upcomingDue?.includes('Namaste')) {
          s.whatsappTemplates.upcomingDue = '🙏 नमस्ते {{customerName}} जी,\n━━━━━━━━━━━━━━━━━━━━\nआपका ऋण खाता (Loan ID: {{loanId}}) की अगली किश्त {{dueDate}} को देय है।\n💰 राशि: *₹{{amount}}*\n\nकृपया समय पर भुगतान करें।\n💳 ऑनलाइन पेमेंट लिंक:\n👉 {{paymentLink}}\n\n_RinSetu - आपका डिजिटल ऋण सहायक_ 🏦';
          s.whatsappTemplates.dueToday = '🙏 नमस्ते {{customerName}} जी,\n━━━━━━━━━━━━━━━━━━━━\nआपका ऋण खाता (Loan ID: {{loanId}}) की किश्त *आज* देय है।\n💰 राशि: *₹{{amount}}*\n\nकृपया आज ही भुगतान करें ताकि लेट फीस से बचा जा सके।\n💳 ऑनलाइन पेमेंट लिंक:\n👉 {{paymentLink}}\n\n_RinSetu - आपका डिजिटल ऋण सहायक_ 🏦';
          s.whatsappTemplates.paymentReceived = '✅ भुगतान प्राप्त हुआ\n━━━━━━━━━━━━━━━━━━━━\nनमस्ते {{customerName}} जी,\nहमें आपका ₹{{amount}} का भुगतान प्राप्त हो गया है।\n\n📌 आपका शेष मूलधन (Outstanding Principal) अब ₹{{outstanding}} है।\n\nधन्यवाद!\n_RinSetu - आपका डिजिटल ऋण सहायक_ 🏦';
          s.whatsappTemplates.overdueReminder = '⚠️ ओवरड्यू रिमाइंडर\n━━━━━━━━━━━━━━━━━━━━\nआदरणीय {{customerName}} जी,\nआपका ऋण खाता (Loan ID: {{loanId}}) पर ₹{{amount}} अभी तक ओवरड्यू (बकाया) है।\n\nकृपया तुरंत भुगतान करें ताकि आपके खाते पर और जुर्माना न लगे।\n💳 ऑनलाइन पेमेंट लिंक:\n👉 {{paymentLink}}\n\n_RinSetu - आपका डिजिटल ऋण सहायक_ 🏦';
          s.whatsappTemplates.loanClosed = '🎉 बधाई हो {{customerName}} जी!\n━━━━━━━━━━━━━━━━━━━━\nआपका ऋण खाता (Loan ID: {{loanId}}) अब पूरी तरह से बंद (Close) हो गया है।\n\nआप अपना क्लोज़र स्टेटमेंट पोर्टल से प्राप्त कर सकते हैं। हमारे साथ जुड़ने के लिए धन्यवाद!\n\n_RinSetu - आपका डिजिटल ऋण सहायक_ 🏦';
          s.whatsappTemplates.guarantorWarning = '⚠️ गारंटर चेतावनी\n━━━━━━━━━━━━━━━━━━━━\nनमस्ते {{guarantorName}} जी,\nआपने {{customerName}} के ऋण (Loan ID: {{loanId}}) की गारंटी ली थी।\nउनका खाता अभी ओवरड्यू है और बकाया राशि ₹{{amount}} है।\n\nकृपया उनसे संपर्क करें और भुगतान सुनिश्चित करें।\n\n_RinSetu - आपका डिजिटल ऋण सहायक_ 🏦';
          updated = true;
        }
        if (updated) await s.save();
      }
      console.log('✅ Temporary templates migration completed.');
    } catch (migErr) {
      console.warn('⚠️ Migration skipped:', migErr.message);
    }
    // -----------------------------------------------------------------------------------

    // Start node-cron engine
    startCronEngine();
  } catch (err) {
    const waitSeconds = Math.min(attempt * 5, 30);
    console.error(`❌ MongoDB connection failed (attempt ${attempt}): ${err.message}`);
    console.log(`🔄 Retrying in ${waitSeconds} seconds...`);
    setTimeout(() => connectDatabase(attempt + 1), waitSeconds * 1000);
  }
}
