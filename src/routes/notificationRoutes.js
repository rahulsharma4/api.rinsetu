import express from 'express';
import Notification from '../models/Notification.js';
import { logAuditAction } from '../utils/auditHelper.js';

const router = express.Router();

// GET /api/notifications/pending - Fetch all pending notifications
router.get('/pending', async (req, res) => {
  try {
    const list = await Notification.find({ status: 'pending', tenantId: req.admin.tenantId })
      .populate('customerId')
      .populate('loanId')
      .sort({ createdAt: -1 });
    res.json(list);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// POST /api/notifications/:id/send - Mark notification as sent
router.post('/:id/send', async (req, res) => {
  try {
    const notification = await Notification.findOne({ _id: req.params.id, tenantId: req.admin.tenantId }).populate('customerId');
    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    notification.status = 'sent';
    notification.sentAt = new Date();
    await notification.save();

    // Audit Log
    await logAuditAction(
      req.admin?.username || 'admin',
      'NOTIFICATION_SENT',
      `Dispatched automated WhatsApp alert to borrower ${notification.customerId?.name || 'Borrower'} (${notification.recipientPhone})`,
      null,
      notification.toObject(),
      req
    );

    res.json({ message: 'Notification marked as sent.', notification });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// DELETE /api/notifications/:id - Remove notification from queue
router.delete('/:id', async (req, res) => {
  try {
    const notification = await Notification.findOne({ _id: req.params.id, tenantId: req.admin.tenantId });
    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    await Notification.deleteOne({ _id: notification._id });
    res.json({ message: 'Notification removed from queue successfully.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
