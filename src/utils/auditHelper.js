import AuditLog from '../models/AuditLog.js';

/**
 * Helper to log security/financial audit entries to MongoDB.
 * 
 * @param {String} userId - Admin user ID
 * @param {String} action - Action identifier (e.g. LOAN_CREATED)
 * @param {String} details - Human readable summary
 * @param {Object} oldValue - Previous state snapshot
 * @param {Object} newValue - Updated state snapshot
 * @param {Object} req - Express Request object to extract IP
 */
export async function logAuditAction(userId = 'admin', action, details, oldValue = null, newValue = null, req = null) {
  try {
    let ipAddress = '127.0.0.1';
    if (req) {
      ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    }

    const log = new AuditLog({
      userId,
      action,
      details,
      oldValue,
      newValue,
      ipAddress
    });

    await log.save();
    console.log(`[AUDIT LOG] ${action}: ${details}`);
  } catch (err) {
    console.error(`[AUDIT FAILED] Failed to write log: ${err.message}`);
  }
}
