import express from 'express';
import { getWhatsAppStatus, logoutWhatsApp, sendWhatsAppMessage } from '../utils/whatsappService.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = express.Router();

// GET /api/whatsapp/status
router.get('/status', authMiddleware, (req, res) => {
  try {
    const statusData = getWhatsAppStatus();
    res.json(statusData);
  } catch (err) {
    res.status(500).json({ message: 'Failed to retrieve WhatsApp status: ' + err.message });
  }
});

// POST /api/whatsapp/logout
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    await logoutWhatsApp();
    res.json({ message: 'WhatsApp session logged out. Local credentials deleted.' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to logout WhatsApp: ' + err.message });
  }
});

// POST /api/whatsapp/send-test
router.post('/send-test', authMiddleware, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ message: 'Phone number and message body are required.' });
  }

  try {
    const success = await sendWhatsAppMessage(phone, message);
    if (success) {
      res.json({ message: 'Test message sent successfully!' });
    } else {
      res.status(400).json({ message: 'Failed to send message. Make sure the QR code is scanned.' });
    }
  } catch (err) {
    res.status(500).json({ message: 'Failed to send test message: ' + err.message });
  }
});

export default router;
