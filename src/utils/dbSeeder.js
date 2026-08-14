import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Loan from '../models/Loan.js';
import Transaction from '../models/Transaction.js';
import CashBook from '../models/CashBook.js';
import Settings from '../models/Settings.js';
import Notification from '../models/Notification.js';
import AuditLog from '../models/AuditLog.js';
import AutomationLog from '../models/AutomationLog.js';
import AutomationRule from '../models/AutomationRule.js';

export async function seedAdminUser() {
  try {
    const superadminExists = await User.findOne({ role: 'super-admin' });
    
    if (!superadminExists) {
      console.log('🧹 Clearing legacy database collections for fresh RinSetu launch...');
      
      await User.deleteMany({});
      await Customer.deleteMany({});
      await Loan.deleteMany({});
      await Transaction.deleteMany({});
      await CashBook.deleteMany({});
      await Settings.deleteMany({});
      await Notification.deleteMany({});
      await AuditLog.deleteMany({});
      await AutomationLog.deleteMany({});
      await AutomationRule.deleteMany({});
      
      console.log('🌱 Database cleared! Seeding RinSetu Super Admin and default Tenant Admin...');
      
      const salt = await bcrypt.genSalt(10);
      const superPassword = await bcrypt.hash('RinSetu@Super2026', salt);
      const adminPassword = await bcrypt.hash('RinSetu@Admin2026', salt);
      
      // 1. Create Super Admin
      const superAdmin = new User({
        username: 'superadmin',
        password: superPassword,
        name: 'RinSetu Owner',
        role: 'super-admin'
      });
      await superAdmin.save();
      
      // 2. Create Default Admin
      const defaultAdmin = new User({
        username: 'admin',
        password: adminPassword,
        name: 'Main Lender',
        role: 'admin',
        businessName: 'RinSetu Default'
      });
      defaultAdmin.tenantId = defaultAdmin._id;
      const savedAdmin = await defaultAdmin.save();
      
      // 3. Create Default Settings for the Admin
      const defaultSettings = new Settings({
        tenantId: savedAdmin._id,
        waterfallPriority: ['dueCharges', 'lateCharges', 'interest', 'principal'],
        whatsappAutomation: true
      });
      await defaultSettings.save();
      
      console.log('✅ Super Admin ("superadmin" / "RinSetu@Super2026") and Default Admin ("admin" / "RinSetu@Admin2026") seeded successfully!');
    } else {
      console.log('🔑 RinSetu users already exist in database. Skipping admin seeding.');
    }
  } catch (error) {
    console.error('❌ Failed to seed default RinSetu users:', error.message);
  }
}
