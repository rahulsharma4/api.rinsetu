import express from 'express';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
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
    // Find user in database
    const user = await User.findOne({ username: username.trim().toLowerCase() });
    if (!user) {
      console.log(`🔐 Login failed: user "${username}" not found.`);
      return res.status(401).json({ message: 'Galat username ya password. Dobara try karein.' });
    }

    // Verify status (Suspended check)
    if (user.role !== 'super-admin') {
      const tenantAdmin = await User.findById(user.tenantId);
      if (tenantAdmin && tenantAdmin.status === 'Suspended') {
        return res.status(403).json({ message: 'Aapka business tenant portal suspend kar diya gaya hai. Super Admin se contact karein.' });
      }
      if (user.status === 'Suspended') {
        return res.status(403).json({ message: 'Aapka account suspend kar diya gaya hai. Super Admin se contact karein.' });
      }
    }

    // Verify password using bcryptjs
    const isMatch = await bcrypt.compare(password, user.password);
    
    // Debug log (server console)
    console.log(`🔐 Login attempt: user="${username}" | db_user_found=true | pwd_match=${isMatch}`);

    if (!isMatch) {
      return res.status(401).json({ message: 'Galat username ya password. Dobara try karein.' });
    }

    const secret = process.env.JWT_SECRET || 'byaj_fallback_secret';
    // 24 hours token validity
    const token = signToken({ username: user.username, role: user.role, id: user._id, tenantId: user.tenantId }, secret, 86400);

    console.log('✅ Login successful for:', user.username);
    res.json({
      message: 'Login successful',
      token,
      admin: { username: user.username, role: user.role, name: user.name, tenantId: user.tenantId, businessName: user.businessName }
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
    
    const user = await User.findOne({ username: decoded.username });
    if (!user) {
      return res.status(401).json({ valid: false, message: 'User database mein nahi mila.' });
    }

    if (user.role !== 'super-admin') {
      const tenantAdmin = await User.findById(user.tenantId);
      if (tenantAdmin && tenantAdmin.status === 'Suspended') {
        return res.status(403).json({ valid: false, message: 'Aapka business tenant portal suspend ho chuka hai.' });
      }
      if (user.status === 'Suspended') {
        return res.status(403).json({ valid: false, message: 'Aapka account suspend ho chuka hai.' });
      }
    }

    res.json({
      valid: true,
      admin: {
        username: user.username,
        role: user.role,
        name: user.name,
        tenantId: user.tenantId,
        businessName: user.businessName,
        isImpersonating: decoded.isImpersonating || false,
        superAdminUsername: decoded.superAdminUsername || null
      }
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
      86400
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

export default router;
