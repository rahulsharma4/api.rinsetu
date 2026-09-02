import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import XLSX from 'xlsx';
import bcrypt from 'bcryptjs';
import Customer from '../models/Customer.js';
import Loan from '../models/Loan.js';
import Installment from '../models/Installment.js';
import { updateOverdueStatuses } from '../utils/overdueTracker.js';
import { generateRepaymentSchedule } from '../utils/scheduleGenerator.js';
import { logAuditAction } from '../utils/auditHelper.js';

const router = express.Router();

// Multer Upload Configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, './uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// Get all customers
router.get('/', async (req, res) => {
  try {
    await updateOverdueStatuses();
    const customers = await Customer.find({ tenantId: req.admin.tenantId }).sort({ createdAt: -1 });
    
    const customerList = await Promise.all(
      customers.map(async (customer) => {
        const activeLoans = await Loan.find({
          customerId: customer._id,
          status: { $in: ['active', 'overdue', 'npa'] },
        });

        // Calculate Internal Risk Score
        let lateCount = 0;
        let isNPA = false;
        for (const loan of activeLoans) {
            if (loan.status === 'npa') isNPA = true;
            const overdues = await Installment.countDocuments({ loanId: loan._id, status: 'overdue' });
            lateCount += overdues;
        }
        
        let riskScore = 'Green';
        if (isNPA || lateCount > 2) riskScore = 'Red';
        else if (lateCount > 0) riskScore = 'Yellow';

        return {
          ...customer.toObject(),
          activeLoansCount: activeLoans.length,
          riskScore
        };
      })
    );

    res.json(customerList);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get a single customer with loans
router.get('/:id', async (req, res) => {
  try {
    try {
      await updateOverdueStatuses();
    } catch (oErr) {
      console.error('updateOverdueStatuses warning:', oErr.message);
    }

    const customer = await Customer.findOne({ _id: req.params.id, tenantId: req.admin.tenantId });
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    
    const loans = await Loan.find({ customerId: customer._id, tenantId: req.admin.tenantId }).sort({ startDate: -1 });

    // Auto-heal historical installment allocations for active loans
    try {
      const { rebuildInstallmentPayments } = await import('../utils/waterfallEngine.js');
      for (const loan of loans) {
        await rebuildInstallmentPayments(loan._id);
      }
    } catch (rErr) {
      console.error('rebuildInstallmentPayments warning:', rErr.message);
    }

    const freshLoans = await Loan.find({ customerId: customer._id, tenantId: req.admin.tenantId }).sort({ startDate: -1 });

    // Calculate Internal Risk Score
    let lateCount = 0;
    let isNPA = false;
    for (const loan of freshLoans) {
        if (loan.status === 'npa') isNPA = true;
        const overdues = await Installment.countDocuments({ loanId: loan._id, status: 'overdue' });
        lateCount += overdues;
    }
    let riskScore = 'Green';
    if (isNPA || lateCount > 2) riskScore = 'Red';
    else if (lateCount > 0) riskScore = 'Yellow';

    res.json({ customer: { ...customer.toObject(), riskScore }, loans: freshLoans });
  } catch (error) {
    console.error('Error fetching customer details:', error);
    res.status(500).json({ message: error.message });
  }
});

// Create a customer
router.post('/', async (req, res) => {
  const {
    name,
    phone,
    address,
    occupation,
    aadharNumber,
    panNumber,
    bankAccountNumber,
    guarantorName,
    guarantorPhone,
    guarantorAddress,
    guarantorIdDoc,
    collateralType,
    collateralDescription,
    collateralValue,
    email,
    password,
    isPortalEnabled,
    enableWhatsappAutomation,
  } = req.body;

  try {
    let hashedPassword = undefined;
    if (password && password.trim() !== '') {
      const salt = await bcrypt.genSalt(10);
      hashedPassword = await bcrypt.hash(password.trim(), salt);
    }

    const customer = new Customer({
      name,
      phone,
      address,
      occupation,
      aadharNumber,
      panNumber,
      bankAccountNumber,
      guarantorName,
      guarantorPhone,
      guarantorAddress,
      guarantorIdDoc,
      collateralType,
      collateralDescription,
      collateralValue: collateralValue ? parseFloat(collateralValue) : 0,
      tenantId: req.admin.tenantId,
      email: email ? email.trim().toLowerCase() : undefined,
      password: hashedPassword,
      isPortalEnabled: !!isPortalEnabled,
      enableWhatsappAutomation: enableWhatsappAutomation !== undefined ? !!enableWhatsappAutomation : true,
    });

    const newCustomer = await customer.save();
    
    // Audit Log
    await logAuditAction(
      req.admin?.username || 'admin',
      'CUSTOMER_CREATED',
      `Registered new borrower: ${newCustomer.name} (${newCustomer.phone})`,
      null,
      newCustomer.toObject(),
      req
    );

    res.status(201).json(newCustomer);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Toggle customer WhatsApp automation setting
router.put('/:id/toggle-whatsapp', async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, tenantId: req.admin.tenantId });
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const newStatus = customer.enableWhatsappAutomation === false ? true : false;
    customer.enableWhatsappAutomation = newStatus;
    await customer.save();

    await logAuditAction(
      req.admin?.username || 'admin',
      'CUSTOMER_WHATSAPP_TOGGLED',
      `WhatsApp auto-reminders ${newStatus ? 'ENABLED' : 'DISABLED'} for borrower: ${customer.name}`,
      null,
      { enableWhatsappAutomation: newStatus },
      req
    );

    res.json({
      message: `WhatsApp automation ${newStatus ? 'enabled' : 'disabled'} for ${customer.name}.`,
      enableWhatsappAutomation: newStatus,
      customer
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update a customer
router.put('/:id', async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, tenantId: req.admin.tenantId });
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const oldValue = customer.toObject();
    const updates = { ...req.body };

    // Hashing password if updated, or discarding if blank
    if (updates.password !== undefined) {
      if (updates.password.trim() !== '') {
        const salt = await bcrypt.genSalt(10);
        updates.password = await bcrypt.hash(updates.password.trim(), salt);
      } else {
        delete updates.password; // Do not overwrite with empty string
      }
    }

    if (updates.email !== undefined) {
      updates.email = updates.email.trim().toLowerCase() || undefined;
    }

    Object.keys(updates).forEach((key) => {
      customer[key] = updates[key];
    });

    const updatedCustomer = await customer.save();

    // Audit Log
    await logAuditAction(
      req.admin?.username || 'admin',
      'CUSTOMER_UPDATED',
      `Updated profile for borrower: ${updatedCustomer.name}`,
      oldValue,
      updatedCustomer.toObject(),
      req
    );

    res.json(updatedCustomer);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Upload customer documents
router.post('/:id/documents', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'File is required' });
  }

  try {
    const customer = await Customer.findOne({ _id: req.params.id, tenantId: req.admin.tenantId });
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const { label } = req.body;
    const documentData = {
      label: label || req.file.originalname,
      filename: req.file.filename,
      fileUrl: `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`
    };

    customer.documents.push(documentData);
    await customer.save();

    // Audit Log
    await logAuditAction(
      req.admin?.username || 'admin',
      'CUSTOMER_DOC_UPLOADED',
      `Uploaded file "${documentData.label}" for borrower: ${customer.name}`,
      null,
      documentData,
      req
    );

    res.status(201).json({ message: 'Document uploaded successfully', document: documentData });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete a customer document
router.delete('/:id/documents/:docId', async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, tenantId: req.admin.tenantId });
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const targetDoc = customer.documents.find(d => d._id.toString() === req.params.docId);
    customer.documents = customer.documents.filter(doc => doc._id.toString() !== req.params.docId);
    await customer.save();

    // Audit Log
    await logAuditAction(
      req.admin?.username || 'admin',
      'CUSTOMER_DOC_DELETED',
      `Deleted document file "${targetDoc?.label || 'Unknown'}" for borrower: ${customer.name}`,
      targetDoc ? targetDoc.toObject() : null,
      null,
      req
    );

    res.json({ message: 'Document removed successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete a customer
router.delete('/:id', async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, tenantId: req.admin.tenantId });
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const activeLoans = await Loan.findOne({ 
      customerId: customer._id, 
      status: { $in: ['active', 'overdue'] } 
    });
    
    if (activeLoans) {
      return res.status(400).json({
        message: 'Cannot delete customer with active loans. Settle all agreements first.',
      });
    }

    const oldValue = customer.toObject();
    await Customer.deleteOne({ _id: customer._id });

    // Audit Log
    await logAuditAction(
      req.admin?.username || 'admin',
      'CUSTOMER_DELETED',
      `Permanently deleted customer ledger file for: ${customer.name}`,
      oldValue,
      null,
      req
    );

    res.json({ message: 'Customer deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/customers/import-template - Generate dynamic sample Excel sheet
router.get('/import-template', (req, res) => {
  try {
    const headers = [
      'Customer Name', 'Phone', 'Address', 'Occupation', 
      'Collateral Type', 'Collateral Description', 'Collateral Value',
      'Guarantor Name', 'Guarantor Phone', 
      'Loan Principal', 'Interest Rate', 'Interest Rate Type', 
      'Interest Type', 'Payment Frequency', 'Tenure', 'Start Date',
      'Late Fee Rate', 'Late Fee Type'
    ];
    const sampleRow = [
      'Ramesh Lal', '9876543212', 'Sector 5, Mansarovar, Jaipur', 'Business',
      'Gold', 'Gold Ring 10g', '50000',
      'Suresh Lal', '9876543213',
      '100000', '2', 'monthly',
      'simple', 'monthly', '12', '2026-08-01',
      '50', 'daily'
    ];
    
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, sampleRow]);
    XLSX.utils.book_append_sheet(wb, ws, 'Import Template');
    
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=byaj-bulk-import-template.xlsx');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// POST /api/customers/bulk-import - Import Excel data
router.post('/bulk-import', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'Excel file upload zaroori hai.' });
  }

  const filePath = req.file.path;
  
  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet);

    let importedCustomersCount = 0;
    let importedLoansCount = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const name = row['Customer Name'];
      const phone = row['Phone'] ? row['Phone'].toString().trim() : '';

      if (!name || !phone) {
        errors.push(`Row ${i + 2}: Name aur Phone mandatory hain.`);
        continue;
      }

      try {
        // 1. Check/Create Customer
        let customer = await Customer.findOne({ phone, tenantId: req.admin.tenantId });
        if (!customer) {
          customer = new Customer({
            name,
            phone,
            address: row['Address'] || '',
            occupation: row['Occupation'] || '',
            collateralType: row['Collateral Type'] || 'None',
            collateralDescription: row['Collateral Description'] || '',
            collateralValue: row['Collateral Value'] ? parseFloat(row['Collateral Value']) : 0,
            guarantorName: row['Guarantor Name'] || '',
            guarantorPhone: row['Guarantor Phone'] ? row['Guarantor Phone'].toString().trim() : '',
            tenantId: req.admin.tenantId,
          });
          await customer.save();
          importedCustomersCount++;
        }

        // 2. Check/Create Loan if principal is present
        const principal = row['Loan Principal'] ? parseFloat(row['Loan Principal']) : 0;
        if (principal > 0) {
          const interestRate = row['Interest Rate'] ? parseFloat(row['Interest Rate']) : 0;
          const tenure = row['Tenure'] ? parseInt(row['Tenure']) : 0;
          
          if (interestRate <= 0 || tenure <= 0) {
            errors.push(`Row ${i + 2}: Borrower "${name}" ke liye loan insert fail - Interest Rate aur Tenure valid parameters hone chahiye.`);
            continue;
          }

          const loan = new Loan({
            customerId: customer._id,
            principalAmount: principal,
            interestRate,
            rateType: row['Interest Rate Type'] || 'monthly',
            interestType: row['Interest Type'] || 'simple',
            paymentFrequency: row['Payment Frequency'] || 'monthly',
            startDate: row['Start Date'] ? new Date(row['Start Date']) : new Date(),
            tenure,
            lateFeeRate: row['Late Fee Rate'] ? parseFloat(row['Late Fee Rate']) : 50,
            lateFeeType: row['Late Fee Type'] || 'daily',
            remarks: 'Bulk imported loan agreement.',
            tenantId: req.admin.tenantId,
          });

          const newLoan = await loan.save();

          // Generate installments
          const schedule = generateRepaymentSchedule(newLoan);
          const installmentDocs = schedule.map(item => ({
            loanId: newLoan._id,
            ...item
          }));
          await Installment.insertMany(installmentDocs);
          importedLoansCount++;
        }

      } catch (err) {
        errors.push(`Row ${i + 2}: Borrower "${name}" ka record process karne me error: ${err.message}`);
      }
    }

    // Cleanup uploaded file
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      console.error('File deletion error:', e);
    }

    // Audit Log for Bulk Import
    await logAuditAction(
      req.admin?.username || 'admin',
      'CUSTOMER_BULK_IMPORTED',
      `Imported ${importedCustomersCount} customers and ${importedLoansCount} loans via Excel bulk upload.`,
      null,
      { importedCustomersCount, importedLoansCount, errorsCount: errors.length },
      req
    );

    res.json({
      message: 'Bulk import complete.',
      importedCustomers: importedCustomersCount,
      importedLoans: importedLoansCount,
      errors
    });

  } catch (error) {
    res.status(500).json({ message: 'Excel parsing failure: ' + error.message });
  }
});

export default router;
