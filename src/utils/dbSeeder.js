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
import Installment from '../models/Installment.js';

export async function seedAdminUser() {
  try {
    const rahulExists = await User.findOne({ username: 'rahul' });
    
    if (!rahulExists) {
      console.log('🧹 Clearing legacy database collections for fresh RinSetu launch with Rahul...');
      
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
      
      console.log('🌱 Database cleared! Seeding RinSetu Super Admin (Rahul)...');
      
      const salt = await bcrypt.genSalt(10);
      const superPassword = await bcrypt.hash('Rahul@0406', salt);
      
      // 1. Create Super Admin
      const superAdmin = new User({
        username: 'rahul',
        password: superPassword,
        name: 'Rahul Bhardwaj',
        role: 'super-admin'
      });
      await superAdmin.save();
      
      console.log('✅ Super Admin ("rahul" / "Rahul@0406") seeded successfully!');
    } else {
      console.log('🔑 RinSetu users already exist in database. Skipping admin seeding.');
    }
  } catch (error) {
    console.error('❌ Failed to seed default RinSetu users:', error.message);
  }
}

export async function cleanupDefaultAdmin() {
  try {
    const defaultAdmin = await User.findOne({ username: 'admin' });
    if (defaultAdmin) {
      console.log('🧹 Found legacy default admin ("admin"). Wiping its data and deleting...');
      const tenantId = defaultAdmin._id;

      // Cascade wipe all collections matching tenantId
      await Customer.deleteMany({ tenantId });
      await Loan.deleteMany({ tenantId });
      
      const loans = await Loan.find({ tenantId }).select('_id');
      const loanIds = loans.map(l => l._id);
      await Installment.deleteMany({ loanId: { $in: loanIds } });

      await Transaction.deleteMany({ tenantId });
      await CashBook.deleteMany({ tenantId });
      await Notification.deleteMany({ tenantId });
      await Settings.deleteMany({ tenantId });
      await AuditLog.deleteMany({ tenantId });
      await AutomationRule.deleteMany({ tenantId });
      await AutomationLog.deleteMany({ tenantId });
      
      // Also delete any staff members (manager/collector) created by this tenant admin
      await User.deleteMany({ tenantId });

      // Finally delete the tenant admin user itself
      await User.deleteOne({ _id: tenantId });
      console.log('✅ Legacy default admin and its data successfully deleted.');
    }
  } catch (error) {
    console.error('❌ Failed to clean up legacy default admin:', error.message);
  }
}
