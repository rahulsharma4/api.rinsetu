import User from '../models/User.js';

/**
 * Middleware to check the subscription status of the tenant admin.
 * Blocks requests with a 403 status if the subscription has expired or is suspended.
 */
export async function subscriptionMiddleware(req, res, next) {
  // Super-admin has full bypass
  if (req.admin?.role === 'super-admin') {
    return next();
  }

  const tenantId = req.admin?.tenantId;
  if (!tenantId) {
    return res.status(400).json({ message: 'Tenant ID missing in request session.' });
  }

  try {
    const tenant = await User.findById(tenantId);
    if (!tenant) {
      return res.status(404).json({ message: 'Lender tenant account not found.' });
    }

    // 1. Check account suspension status
    if (tenant.status === 'Suspended') {
      return res.status(403).json({
        message: 'Aapka account suspend kar diya gaya hai. Kripya Superadmin se sampark karein.',
        code: 'ACCOUNT_SUSPENDED',
      });
    }

    // 2. Bypass check if super-admin granted free access
    if (tenant.isFreeAccess) {
      return next();
    }

    // 3. Check subscription expiry
    const now = new Date();
    const isExpired = now > new Date(tenant.renewalDate);

    if (isExpired) {
      if (tenant.subscriptionStatus !== 'expired') {
        tenant.subscriptionStatus = 'expired';
        await tenant.save();
      }

      return res.status(403).json({
        message: 'Aapka subscription period expire ho gaya hai. Kripya renew karein.',
        code: 'SUBSCRIPTION_EXPIRED',
      });
    }

    // Subscription is valid (trial or active)
    next();
  } catch (err) {
    return res.status(500).json({ message: 'Failed to verify subscription status: ' + err.message });
  }
}
