import express from 'express';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import { signToken, verifyToken } from '../utils/jwtHelper.js';

dotenv.config();
const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'Username aur password dono zaroori hain.' });
  }

  try {
    // Find user in User (admin/manager/collector)
    let user = await User.findOne({ username: username.trim().toLowerCase() });
    
    let isBorrower = false;
    let customer = null;

    // If not in User, look in Customer (borrower) by email
    if (!user) {
      customer = await Customer.findOne({ email: username.trim().toLowerCase() });
      if (customer) {
        if (!customer.isPortalEnabled) {
          return res.status(403).json({ message: 'Aapke account ke liye portal access abhi enabled nahi hai.' });
        }
        isBorrower = true;
      }
    }

    if (!user && !customer) {
      console.log(`🔐 Login failed: credentials "${username}" not found.`);
      return res.status(401).json({ message: 'Galat username ya password. Dobara try karein.' });
    }

    // Verify password using bcryptjs
    const targetPasswordHash = isBorrower ? customer.password : user.password;
    if (!targetPasswordHash) {
      return res.status(401).json({ message: 'Password configured nahi hai. Tenant admin se contact karein.' });
    }

    const isMatch = await bcrypt.compare(password, targetPasswordHash);
    
    // Debug log (server console)
    console.log(`🔐 Login attempt: user="${username}" | role=${isBorrower ? 'borrower' : 'user'} | pwd_match=${isMatch}`);

    if (!isMatch) {
      return res.status(401).json({ message: 'Galat username ya password. Dobara try karein.' });
    }

    // Verify status (Suspended check)
    if (isBorrower) {
      const tenantAdmin = await User.findById(customer.tenantId);
      if (!tenantAdmin || tenantAdmin.status === 'Suspended') {
        return res.status(403).json({ message: 'Aapka business tenant portal suspend ho chuka hai. Admin se contact karein.' });
      }
    } else if (user.role !== 'super-admin') {
      const tenantAdmin = await User.findById(user.tenantId);
      if (tenantAdmin && tenantAdmin.status === 'Suspended') {
        return res.status(403).json({ message: 'Aapka business tenant portal suspend kar diya gaya hai. Super Admin se contact karein.' });
      }
      if (user.status === 'Suspended') {
        return res.status(403).json({ message: 'Aapka account suspend kar diya gaya hai. Super Admin se contact karein.' });
      }
    }

    const secret = process.env.JWT_SECRET || 'byaj_fallback_secret';
    let tokenPayload = {};
    let adminPayload = {};

    if (isBorrower) {
      const tenantAdmin = await User.findById(customer.tenantId);
      tokenPayload = {
        username: customer.email,
        role: 'borrower',
        id: customer._id,
        tenantId: customer.tenantId
      };
      adminPayload = {
        username: customer.email,
        role: 'borrower',
        name: customer.name,
        tenantId: customer.tenantId,
        businessName: tenantAdmin?.businessName || 'Lender Panel',
        subscriptionStatus: tenantAdmin?.subscriptionStatus || 'active',
        renewalDate: tenantAdmin?.renewalDate || null
      };
    } else {
      let subscriptionStatus = 'active';
      let renewalDate = null;
      if (user.role !== 'super-admin') {
        const tenantAdmin = await User.findById(user.tenantId);
        if (tenantAdmin) {
          subscriptionStatus = tenantAdmin.subscriptionStatus;
          renewalDate = tenantAdmin.renewalDate;
        }
      }
      tokenPayload = {
        username: user.username,
        role: user.role,
        id: user._id,
        tenantId: user.tenantId
      };
      adminPayload = {
        username: user.username,
        role: user.role,
        name: user.name,
        tenantId: user.tenantId,
        businessName: user.businessName,
        subscriptionStatus,
        renewalDate
      };
    }

    // 30 days token validity
    const token = signToken(tokenPayload, secret, 2592000);

    console.log('✅ Login successful for:', tokenPayload.username);
    res.json({
      message: 'Login successful',
      token,
      admin: adminPayload
    });
  } catch (error) {
    console.error('❌ Error during login:', error);
    res.status(500).json({ message: 'Server check connection failed.' });
  }
});

// POST /api/auth/verify
router.post('/verify', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ valid: false, message: 'Token nahi mila.' });
  }

  try {
    const secret = process.env.JWT_SECRET || 'byaj_fallback_secret';
    const decoded = verifyToken(token, secret);
    
    let isBorrower = decoded.role === 'borrower';
    let user = null;
    let customer = null;

    if (isBorrower) {
      customer = await Customer.findById(decoded.id);
      if (!customer) {
        return res.status(401).json({ valid: false, message: 'User database mein nahi mila.' });
      }
      if (!customer.isPortalEnabled) {
        return res.status(403).json({ valid: false, message: 'Portal access disabled.' });
      }
    } else {
      user = await User.findOne({ username: decoded.username });
      if (!user) {
        return res.status(401).json({ valid: false, message: 'User database mein nahi mila.' });
      }
    }

    let subscriptionStatus = 'active';
    let renewalDate = null;

    if (isBorrower) {
      const tenantAdmin = await User.findById(customer.tenantId);
      if (tenantAdmin) {
        subscriptionStatus = tenantAdmin.subscriptionStatus;
        renewalDate = tenantAdmin.renewalDate;
      }
      if (tenantAdmin && tenantAdmin.status === 'Suspended') {
        return res.status(403).json({ valid: false, message: 'Aapka business tenant portal suspend ho chuka hai.' });
      }
    } else if (user.role !== 'super-admin') {
      const tenantAdmin = await User.findById(user.tenantId);
      if (tenantAdmin) {
        subscriptionStatus = tenantAdmin.subscriptionStatus;
        renewalDate = tenantAdmin.renewalDate;
      }
      if (tenantAdmin && tenantAdmin.status === 'Suspended') {
        return res.status(403).json({ valid: false, message: 'Aapka business tenant portal suspend ho chuka hai.' });
      }
      if (user.status === 'Suspended') {
        return res.status(403).json({ valid: false, message: 'Aapka account suspend ho chuka hai.' });
      }
    }

    const adminPayload = isBorrower ? {
      username: customer.email,
      role: 'borrower',
      name: customer.name,
      tenantId: customer.tenantId,
      businessName: (await User.findById(customer.tenantId))?.businessName || 'Lender Panel',
      isImpersonating: false,
      superAdminUsername: null,
      subscriptionStatus,
      renewalDate
    } : {
      username: user.username,
      role: user.role,
      name: user.name,
      tenantId: user.tenantId,
      businessName: user.businessName,
      isImpersonating: decoded.isImpersonating || false,
      superAdminUsername: decoded.superAdminUsername || null,
      subscriptionStatus,
      renewalDate
    };

    res.json({
      valid: true,
      admin: adminPayload
    });
  } catch (err) {
    res.status(401).json({ valid: false, message: 'Token expire ho gaya ya galat hai.' });
  }
});

// PUT /api/auth/profile (Update Admin Profile details)
router.put('/profile', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Token zaroori hai.' });
  }

  try {
    const secret = process.env.JWT_SECRET || 'byaj_fallback_secret';
    const decoded = verifyToken(token, secret);
    
    const { businessName, name, username, password } = req.body;

    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(404).json({ message: 'Admin profile nahi mili.' });
    }

    // Tenant/Admin editing profile
    if (businessName) user.businessName = businessName.trim();
    if (name) user.name = name.trim();
    
    if (username && username.trim().toLowerCase() !== user.username) {
      const existing = await User.findOne({ username: username.trim().toLowerCase() });
      if (existing) {
        return res.status(400).json({ message: 'Ye username pehle se kisi aur ka hai.' });
      }
      user.username = username.trim().toLowerCase();
    }

    if (password && password.trim()) {
      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(password.trim(), salt);
    }

    await user.save();

    // Re-sign token with updated credentials
    const newToken = signToken(
      { username: user.username, role: user.role, id: user._id, tenantId: user.tenantId },
      secret,
      2592000
    );

    res.json({
      message: 'Profile updated successfully!',
      token: newToken,
      admin: {
        username: user.username,
        role: user.role,
        name: user.name,
        tenantId: user.tenantId,
        businessName: user.businessName
      }
    });
  } catch (error) {
    console.error('❌ Error during profile update:', error);
    res.status(500).json({ message: 'Failed to update profile.' });
  }
});


// GET /api/auth/gateway-settings  (read current gateway config for settings panel)
router.get('/gateway-settings', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token zaroori hai.' });

  try {
    const secret = process.env.JWT_SECRET || 'byaj_fallback_secret';
    const decoded = verifyToken(token, secret);
    const user = await User.findById(decoded.id).select('+gatewayKeyId +gatewayKeySecret +gatewayWebhookSecret');
    if (!user) return res.status(404).json({ message: 'User not found.' });

    res.json({
      gatewayKeyId: user.gatewayKeyId || '',
      gatewayWebhookSecret: user.gatewayWebhookSecret || '',
      upiId: user.upiId || '',
      upiName: user.upiName || '',
      hasKeySecret: !!(user.gatewayKeySecret && user.gatewayKeySecret.length > 0),
      isConfigured: !!(user.gatewayKeyId && user.gatewayKeyId.length > 0 && user.gatewayKeySecret && user.gatewayKeySecret.length > 0),
      webhookUrl: `${req.protocol}://${req.get('host')}/api/webhooks/razorpay/${decoded.id}`,
    });
  } catch (err) {
    res.status(401).json({ message: 'Token expired or invalid.' });
  }
});

// PUT /api/auth/gateway-settings  (save/update Razorpay & P2P UPI credentials)
router.put('/gateway-settings', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token zaroori hai.' });

  try {
    const secret = process.env.JWT_SECRET || 'byaj_fallback_secret';
    const decoded = verifyToken(token, secret);
    const { gatewayKeyId, gatewayKeySecret, gatewayWebhookSecret, upiId, upiName } = req.body;

    const user = await User.findById(decoded.id).select('+gatewayKeyId +gatewayKeySecret +gatewayWebhookSecret');
    if (!user) return res.status(404).json({ message: 'User not found.' });

    if (gatewayKeyId !== undefined) user.gatewayKeyId = gatewayKeyId.trim();
    if (gatewayKeySecret !== undefined && gatewayKeySecret.trim()) {
      user.gatewayKeySecret = gatewayKeySecret.trim();
    }
    if (gatewayWebhookSecret !== undefined) user.gatewayWebhookSecret = gatewayWebhookSecret.trim();
    if (upiId !== undefined) user.upiId = upiId.trim();
    if (upiName !== undefined) user.upiName = upiName.trim();

    await user.save();
    res.json({ message: 'Payment gateway settings saved successfully!' });
  } catch (err) {
    console.error('❌ Gateway settings update error:', err);
    res.status(500).json({ message: 'Failed to save gateway settings.' });
  }
});

// GET /api/auth/whatsapp-settings  (read current whatsapp config for settings panel)
router.get('/whatsapp-settings', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token zaroori hai.' });

  try {
    const secret = process.env.JWT_SECRET || 'byaj_fallback_secret';
    const decoded = verifyToken(token, secret);
    const user = await User.findById(decoded.id).select('+whatsappAccessToken +whatsappPhoneNumberId +whatsappEnabled +whatsappTemplates +whatsappMode');
    if (!user) return res.status(404).json({ message: 'User not found.' });

    res.json({
      whatsappAccessToken: user.whatsappAccessToken || '',
      whatsappPhoneNumberId: user.whatsappPhoneNumberId || '',
      whatsappEnabled: !!user.whatsappEnabled,
      whatsappMode: user.whatsappMode || 'manual',
      whatsappTemplates: user.whatsappTemplates ? Object.fromEntries(user.whatsappTemplates) : {}
    });
  } catch (err) {
    res.status(401).json({ message: 'Token expired or invalid.' });
  }
});

// PUT /api/auth/whatsapp-settings  (save/update WhatsApp Meta API settings)
router.put('/whatsapp-settings', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token zaroori hai.' });

  try {
    const secret = process.env.JWT_SECRET || 'byaj_fallback_secret';
    const decoded = verifyToken(token, secret);
    const { whatsappAccessToken, whatsappPhoneNumberId, whatsappEnabled, whatsappTemplates, whatsappMode } = req.body;

    const user = await User.findById(decoded.id).select('+whatsappAccessToken +whatsappPhoneNumberId +whatsappEnabled +whatsappTemplates +whatsappMode');
    if (!user) return res.status(404).json({ message: 'User not found.' });

    if (whatsappAccessToken !== undefined) user.whatsappAccessToken = whatsappAccessToken.trim();
    if (whatsappPhoneNumberId !== undefined) user.whatsappPhoneNumberId = whatsappPhoneNumberId.trim();
    if (whatsappEnabled !== undefined) user.whatsappEnabled = !!whatsappEnabled;
    if (whatsappMode !== undefined) user.whatsappMode = whatsappMode;
    if (whatsappTemplates !== undefined) {
      user.whatsappTemplates = whatsappTemplates;
    }

    await user.save();
    res.json({ message: 'WhatsApp settings saved successfully!' });
  } catch (err) {
    console.error('❌ WhatsApp settings update error:', err);
    res.status(500).json({ message: 'Failed to save WhatsApp settings.' });
  }
});

// GET /api/auth/payout-settings
router.get('/payout-settings', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token zaroori hai.' });

  try {
    const secret = process.env.JWT_SECRET || 'byaj_fallback_secret';
    const decoded = verifyToken(token, secret);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    res.json({
      payoutBankAccountNumber: user.payoutBankAccountNumber || '',
      payoutBankIfsc: user.payoutBankIfsc || '',
      payoutBankBeneficiaryName: user.payoutBankBeneficiaryName || '',
      payoutLinkedAccountId: user.payoutLinkedAccountId || '',
      payoutEnabled: !!user.payoutEnabled,
      paymentModePreference: user.paymentModePreference || 'byok'
    });
  } catch (err) {
    res.status(401).json({ message: 'Token expired or invalid.' });
  }
});

// PUT /api/auth/payout-settings
router.put('/payout-settings', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token zaroori hai.' });

  try {
    const secret = process.env.JWT_SECRET || 'byaj_fallback_secret';
    const decoded = verifyToken(token, secret);
    const { payoutBankAccountNumber, payoutBankIfsc, payoutBankBeneficiaryName, paymentModePreference } = req.body;

    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    if (payoutBankAccountNumber !== undefined) user.payoutBankAccountNumber = payoutBankAccountNumber.trim();
    if (payoutBankIfsc !== undefined) user.payoutBankIfsc = payoutBankIfsc.trim().toUpperCase();
    if (payoutBankBeneficiaryName !== undefined) user.payoutBankBeneficiaryName = payoutBankBeneficiaryName.trim();
    if (paymentModePreference !== undefined) user.paymentModePreference = paymentModePreference;

    // Trigger automatic sub-merchant creation if central_split is chosen, bank details are provided, and no ID exists yet
    const hasDetails = user.payoutBankAccountNumber && user.payoutBankIfsc && user.payoutBankBeneficiaryName;
    if (paymentModePreference === 'central_split' && hasDetails && !user.payoutLinkedAccountId) {
      const { createRazorpayLinkedAccount } = await import('../utils/payoutService.js');
      const linkedAccountId = await createRazorpayLinkedAccount(user, {
        accountNumber: user.payoutBankAccountNumber,
        ifsc: user.payoutBankIfsc,
        beneficiaryName: user.payoutBankBeneficiaryName
      });

      if (linkedAccountId) {
        user.payoutLinkedAccountId = linkedAccountId;
        user.payoutEnabled = true;
      } else {
        user.payoutEnabled = false;
      }
    }

    await user.save();
    res.json({
      message: user.payoutEnabled
        ? 'Payout settings saved and active!'
        : 'Payout settings saved! Linkage is pending activation.',
      payoutEnabled: user.payoutEnabled,
      payoutLinkedAccountId: user.payoutLinkedAccountId
    });
  } catch (err) {
    console.error('❌ Payout settings update error:', err);
    res.status(500).json({ message: 'Failed to save payout settings.' });
  }
});

// GET /api/auth/staff - List all staff users for the admin's tenant
router.get('/staff', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token zaroori hai.' });

  try {
    const secret = process.env.JWT_SECRET || 'byaj_fallback_secret';
    const decoded = verifyToken(token, secret);
    const adminUser = await User.findById(decoded.id);
    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }

    const staffList = await User.find({
      tenantId: adminUser.tenantId,
      role: { $in: ['manager', 'collector'] }
    }).select('-password');

    res.json(staffList);
  } catch (err) {
    res.status(401).json({ message: 'Token expired or invalid.' });
  }
});

// POST /api/auth/staff - Onboard new manager/collector staff
router.post('/staff', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token zaroori hai.' });

  try {
    const secret = process.env.JWT_SECRET || 'byaj_fallback_secret';
    const decoded = verifyToken(token, secret);
    const adminUser = await User.findById(decoded.id);
    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }

    const { username, password, name, role } = req.body;
    if (!username || !password || !name || !role) {
      return res.status(400).json({ message: 'Sabhi fields (username, password, name, role) zaroori hain.' });
    }

    if (!['manager', 'collector'].includes(role)) {
      return res.status(400).json({ message: 'Role must be manager or collector.' });
    }

    const exists = await User.findOne({ username: username.trim().toLowerCase() });
    if (exists) {
      return res.status(400).json({ message: 'Username pehle se hi taken hai.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newStaff = new User({
      username: username.trim().toLowerCase(),
      password: hashedPassword,
      name: name.trim(),
      role,
      tenantId: adminUser.tenantId
    });

    await newStaff.save();
    res.status(201).json({
      message: 'Staff user created successfully!',
      staff: {
        _id: newStaff._id,
        username: newStaff.username,
        name: newStaff.name,
        role: newStaff.role
      }
    });
  } catch (err) {
    res.status(401).json({ message: 'Token expired or invalid.' });
  }
});

// DELETE /api/auth/staff/:id - Delete a staff user
router.delete('/staff/:id', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token zaroori hai.' });

  try {
    const secret = process.env.JWT_SECRET || 'byaj_fallback_secret';
    const decoded = verifyToken(token, secret);
    const adminUser = await User.findById(decoded.id);
    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }

    const staffUser = await User.findOne({
      _id: req.params.id,
      tenantId: adminUser.tenantId,
      role: { $in: ['manager', 'collector'] }
    });

    if (!staffUser) {
      return res.status(404).json({ message: 'Staff user not found.' });
    }

    await User.deleteOne({ _id: staffUser._id });
    res.json({ message: 'Staff user deleted successfully.' });
  } catch (err) {
    res.status(401).json({ message: 'Token expired or invalid.' });
  }
});

export default router;
