import express from 'express';
import fs from 'fs';
import path from 'path';
import Settings from '../models/Settings.js';
import AutomationRule from '../models/AutomationRule.js';
import AutomationLog from '../models/AutomationLog.js';
import Customer from '../models/Customer.js';
import Loan from '../models/Loan.js';
import Transaction from '../models/Transaction.js';
import Installment from '../models/Installment.js';
import AuditLog from '../models/AuditLog.js';

const router = express.Router();

// Helper to construct CSV contents
function convertToCSV(data, headers) {
  const headerRow = headers.join(',') + '\n';
  const rows = data.map(item => {
    return headers.map(header => {
      let value = item[header];
      if (value === undefined || value === null) value = '';
      if (typeof value === 'object') value = JSON.stringify(value);
      
      // Escape commas, quotes, and line breaks
      value = value.toString().replace(/"/g, '""');
      if (value.includes(',') || value.includes('\n') || value.includes('"')) {
        value = `"${value}"`;
      }
      return value;
    }).join(',');
  }).join('\n');
  return headerRow + rows;
}

// GET /api/settings - Fetch global config
router.get('/', async (req, res) => {
  try {
    let settings = await Settings.findOne({ tenantId: req.admin.tenantId });
    if (!settings) {
      settings = new Settings({ tenantId: req.admin.tenantId });
      await settings.save();
    }
    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// PUT /api/settings - Update global settings
router.put('/', async (req, res) => {
  try {
    let settings = await Settings.findOne({ tenantId: req.admin.tenantId });
    if (!settings) {
      settings = new Settings({ tenantId: req.admin.tenantId });
    }

    const { waterfallPriority, whatsappAutomation, whatsappTemplates } = req.body;
    if (waterfallPriority) settings.waterfallPriority = waterfallPriority;
    if (whatsappAutomation !== undefined) settings.whatsappAutomation = whatsappAutomation;
    if (whatsappTemplates) settings.whatsappTemplates = whatsappTemplates;

    const updated = await settings.save();
    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// GET /api/settings/automation-rules
router.get('/automation-rules', async (req, res) => {
  try {
    const rules = await AutomationRule.find({ tenantId: req.admin.tenantId });
    res.json(rules);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// POST /api/settings/automation-rules
router.post('/automation-rules', async (req, res) => {
  const { name, eventTrigger, conditions, actions, isActive } = req.body;
  const rule = new AutomationRule({
    name,
    eventTrigger,
    conditions,
    actions,
    isActive,
    tenantId: req.admin.tenantId,
  });

  try {
    const newRule = await rule.save();
    res.status(201).json(newRule);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// GET /api/settings/audit-logs - Read admin audit log history
router.get('/audit-logs', async (req, res) => {
  try {
    const logs = await AuditLog.find({ tenantId: req.admin.tenantId }).sort({ createdAt: -1 }).limit(100);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/settings/notifications - Fetch counts for bell notification dropdown
router.get('/notifications', async (req, res) => {
  try {
    const overdueCount = await Loan.countDocuments({ tenantId: req.admin.tenantId, status: 'overdue' });
    
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    const tenantLoans = await Loan.find({ tenantId: req.admin.tenantId }).select('_id');
    const loanIds = tenantLoans.map(l => l._id);

    const dueTodayCount = await Installment.countDocuments({
      loanId: { $in: loanIds },
      dueDate: { $gte: startOfDay, $lt: endOfDay },
      status: { $in: ['unpaid', 'partially_paid', 'overdue'] }
    });

    const paymentsReceivedToday = await Transaction.countDocuments({
      tenantId: req.admin.tenantId,
      paymentDate: { $gte: startOfDay, $lt: endOfDay },
      isReversed: { $ne: true }
    });

    // Check loans ready to close
    const loans = await Loan.find({ tenantId: req.admin.tenantId, status: 'active' });
    let readyToClose = 0;
    for (const loan of loans) {
      const totalInst = await Installment.countDocuments({ loanId: loan._id });
      const paidInst = await Installment.countDocuments({ loanId: loan._id, status: 'paid' });
      const chargesCleared = (loan.dueCharges - loan.dueChargesPaid === 0) && (loan.lateCharges - loan.lateChargesPaid === 0);
      if (paidInst === totalInst && totalInst > 0 && chargesCleared) {
        readyToClose++;
      }
    }

    res.json({
      overdue: overdueCount,
      dueToday: dueTodayCount,
      paymentsReceived: paymentsReceivedToday,
      readyToClose: readyToClose,
      expiringDocs: 1 // Simulated warning
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/settings/global-search - Global navigation search queries
router.get('/global-search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ customers: [], loans: [], transactions: [] });

  const regex = new RegExp(q, 'i');

  try {
    const customers = await Customer.find({
      tenantId: req.admin.tenantId,
      $or: [
        { name: regex },
        { phone: regex },
        { aadharNumber: regex },
        { panNumber: regex }
      ]
    }).limit(6);

    const loans = await Loan.find({
      tenantId: req.admin.tenantId,
      $or: [
        { remarks: regex },
        { status: regex }
      ]
    }).populate('customerId').limit(6);

    const transactions = await Transaction.find({
      tenantId: req.admin.tenantId,
      $or: [
        { notes: regex },
        { paymentMode: regex }
      ]
    }).populate('customerId').limit(6);

    res.json({ customers, loans, transactions });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/settings/backup - JSON Database Backup Downloader
router.get('/backup', async (req, res) => {
  try {
    const tenantId = req.admin.tenantId;
    const customers = await Customer.find({ tenantId });
    const loans = await Loan.find({ tenantId });
    const transactions = await Transaction.find({ tenantId });
    
    const loanIds = loans.map(l => l._id);
    const installments = await Installment.find({ loanId: { $in: loanIds } });
    
    const settings = await Settings.findOne({ tenantId });
    const auditLogs = await AuditLog.find({ tenantId });

    const dbDump = {
      customers,
      loans,
      transactions,
      installments,
      settings: settings || {},
      auditLogs,
      backupTimestamp: new Date()
    };

    const backupsDir = './backups';
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir);
    }

    const fileName = `backup-${Date.now()}.json`;
    const filePath = path.join(backupsDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(dbDump, null, 2));

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    res.send(JSON.stringify(dbDump));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/settings/export/customers - CSV Exports
router.get('/export/customers', async (req, res) => {
  try {
    const customers = await Customer.find({ tenantId: req.admin.tenantId }).lean();
    const csv = convertToCSV(customers, ['_id', 'name', 'phone', 'address', 'occupation', 'aadharNumber', 'panNumber', 'bankAccountNumber', 'status']);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=customers-export.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/settings/export/loans
router.get('/export/loans', async (req, res) => {
  try {
    const loans = await Loan.find({ tenantId: req.admin.tenantId }).populate('customerId').lean();
    const flattened = loans.map(l => ({
      ...l,
      borrowerName: l.customerId?.name || 'Deleted'
    }));
    const csv = convertToCSV(flattened, ['_id', 'borrowerName', 'principalAmount', 'interestRate', 'rateType', 'interestType', 'paymentFrequency', 'tenure', 'status', 'startDate']);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=loans-export.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/settings/export/payments
router.get('/export/payments', async (req, res) => {
  try {
    const tx = await Transaction.find({ tenantId: req.admin.tenantId }).populate('customerId').lean();
    const flattened = tx.map(t => ({
      ...t,
      borrowerName: t.customerId?.name || 'Deleted'
    }));
    const csv = convertToCSV(flattened, ['_id', 'borrowerName', 'amount', 'paymentMode', 'paymentType', 'paymentDate', 'isReversed', 'notes']);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=payments-export.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// POST /api/settings/trigger-cron - Manually trigger daily background checks
import { runDailyAccrualJob } from '../utils/cronJob.js';
router.post('/trigger-cron', async (req, res) => {
  try {
    const resObj = await runDailyAccrualJob();
    if (resObj.success) {
      res.json({ message: 'Auto check & late fee calculations processed successfully.', ...resObj });
    } else {
      res.status(500).json({ message: 'Cron trigger failed.', error: resObj.error });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
