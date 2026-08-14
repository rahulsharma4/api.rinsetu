import express from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import Settings from '../models/Settings.js';
import Customer from '../models/Customer.js';
import Loan from '../models/Loan.js';
import Transaction from '../models/Transaction.js';
import CashBook from '../models/CashBook.js';
import Notification from '../models/Notification.js';
import AuditLog from '../models/AuditLog.js';
import AutomationRule from '../models/AutomationRule.js';
import AutomationLog from '../models/AutomationLog.js';
import Installment from '../models/Installment.js';
import { signToken } from '../utils/jwtHelper.js';

const router = express.Router();

// Middleware to restrict access to Super Admins only
router.use((req, res, next) => {
  if (req.admin?.role !== 'super-admin') {
    return res.status(403).json({ message: 'Forbidden. Access restricted to Super Admin only.' });
  }
  next();
});

// GET /api/superadmin/tenants - List all lender tenant admins
router.get('/tenants', async (req, res) => {
  try {
    const tenants = await User.find({ role: 'admin' }).sort({ createdAt: -1 });
    
    const tenantList = await Promise.all(
      tenants.map(async (t) => {
        const customerCount = await Customer.countDocuments({ tenantId: t._id });
        const loanCount = await Loan.countDocuments({ tenantId: t._id });
        const activeLoans = await Loan.countDocuments({ tenantId: t._id, status: { $in: ['active', 'overdue'] } });
        
        return {
          _id: t._id,
          username: t.username,
          name: t.name,
          businessName: t.businessName,
          createdAt: t.createdAt,
          status: t.status || 'Active',
          customerCount,
          loanCount,
          activeLoans
        };
      })
    );

    res.json(tenantList);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// POST /api/superadmin/tenants - Onboard a new tenant admin
router.post('/tenants', async (req, res) => {
  const { username, password, name, businessName } = req.body;

  if (!username || !password || !name || !businessName) {
    return res.status(400).json({ message: 'Sabhi fields (username, password, name, businessName) zaroori hain.' });
  }

  try {
    const exists = await User.findOne({ username: username.trim().toLowerCase() });
    if (exists) {
      return res.status(400).json({ message: 'Username pehle se hi taken hai.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newTenant = new User({
      username: username.trim().toLowerCase(),
      password: hashedPassword,
      name: name.trim(),
      businessName: businessName.trim(),
      role: 'admin'
    });

    newTenant.tenantId = newTenant._id;
    const savedTenant = await newTenant.save();

    // Seed default settings for the newly onboarded tenant admin
    const defaultSettings = new Settings({
      tenantId: savedTenant._id,
      waterfallPriority: ['dueCharges', 'lateCharges', 'interest', 'principal'],
      whatsappAutomation: true
    });
    await defaultSettings.save();

    res.status(201).json({
      message: 'New money lending tenant onboarded successfully!',
      tenant: {
        _id: savedTenant._id,
        username: savedTenant.username,
        name: savedTenant.name,
        businessName: savedTenant.businessName
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// DELETE /api/superadmin/tenants/:id - Offboard / Delete a tenant admin (Cascade Wipes all tenant data)
router.delete('/tenants/:id', async (req, res) => {
  try {
    const tenant = await User.findOne({ _id: req.params.id, role: 'admin' });
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found.' });
    }

    // Cascade wipe all collections matching tenantId
    await Customer.deleteMany({ tenantId: tenant._id });
    await Loan.deleteMany({ tenantId: tenant._id });
    
    // Installments don't have tenantId directly but we can find them through loanIds
    // We don't necessarily have to, but to prevent orphaned documents:
    // Let's delete installments belonging to loans of this tenant
    const loans = await Loan.find({ tenantId: tenant._id }).select('_id');
    const loanIds = loans.map(l => l._id);
    await Installment.deleteMany({ loanId: { $in: loanIds } });

    await Transaction.deleteMany({ tenantId: tenant._id });
    await CashBook.deleteMany({ tenantId: tenant._id });
    await Notification.deleteMany({ tenantId: tenant._id });
    await Settings.deleteMany({ tenantId: tenant._id });
    await AuditLog.deleteMany({ tenantId: tenant._id });
    await AutomationRule.deleteMany({ tenantId: tenant._id });
    await AutomationLog.deleteMany({ tenantId: tenant._id });
    
    // Also delete any staff members (manager/collector) created by this tenant admin
    await User.deleteMany({ tenantId: tenant._id });

    // Finally delete the tenant admin user itself
    await User.deleteOne({ _id: tenant._id });

    res.json({ message: `Tenant "${tenant.businessName}" offboarded and all tenant data deleted successfully.` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/superadmin/stats - Global platform dashboard statistics
router.get('/stats', async (req, res) => {
  try {
    const totalTenants = await User.countDocuments({ role: 'admin' });
    const totalCustomers = await Customer.countDocuments();
    const totalLoans = await Loan.countDocuments();
    const activeLoans = await Loan.countDocuments({ status: { $in: ['active', 'overdue'] } });

    const loansList = await Loan.find();
    const totalCapitalDisbursed = loansList.reduce((acc, l) => acc + l.principalAmount, 0);

    const txList = await Transaction.find({ isReversed: { $ne: true } });
    const totalRepaymentsReceived = txList.reduce((acc, t) => acc + t.amount, 0);

    res.json({
      totalTenants,
      totalCustomers,
      totalLoans,
      activeLoans,
      totalCapitalDisbursed,
      totalRepaymentsReceived
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// PUT /api/superadmin/tenants/:id/status - Toggle tenant status (Active <-> Suspended)
router.put('/tenants/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['Active', 'Suspended'].includes(status)) {
    return res.status(400).json({ message: 'Galat status values. Status must be Active or Suspended.' });
  }

  try {
    const tenant = await User.findOne({ _id: req.params.id, role: 'admin' });
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found.' });
    }

    tenant.status = status;
    await tenant.save();

    res.json({
      message: `Tenant "${tenant.businessName}" status updated to ${status} successfully.`,
      tenant: {
        _id: tenant._id,
        businessName: tenant.businessName,
        status: tenant.status
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// POST /api/superadmin/impersonate/:tenantId - Impersonate a tenant admin
router.post('/impersonate/:tenantId', async (req, res) => {
  try {
    const tenant = await User.findOne({ _id: req.params.tenantId, role: 'admin' });
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found.' });
    }

    const secret = process.env.JWT_SECRET || 'byaj_fallback_secret';
    
    // Sign a token for the tenant, but attach impersonating flags
    const token = signToken({
      username: tenant.username,
      role: tenant.role,
      id: tenant._id,
      tenantId: tenant.tenantId,
      isImpersonating: true,
      superAdminUsername: req.admin.username
    }, secret, 86400);

    res.json({
      message: `Impersonation token generated for ${tenant.businessName}`,
      token,
      admin: {
        username: tenant.username,
        role: tenant.role,
        name: tenant.name,
        tenantId: tenant.tenantId,
        businessName: tenant.businessName,
        isImpersonating: true,
        superAdminUsername: req.admin.username
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
