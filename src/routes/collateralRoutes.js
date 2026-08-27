import express from 'express';
import Collateral from '../models/Collateral.js';
import AuditLog from '../models/AuditLog.js';

const router = express.Router();

// Helper for auditing
async function logAuditAction(username, action, details, customerId, diff, req) {
  try {
    const log = new AuditLog({
      username,
      action,
      details,
      customerId,
      diff,
      ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1',
      userAgent: req.headers['user-agent'] || 'Unknown',
      tenantId: req.admin.tenantId,
    });
    await log.save();
  } catch (err) {
    console.error('Audit logging failed:', err);
  }
}

// GET /api/collateral/customer/:customerId - Fetch all collateral for a borrower
router.get('/customer/:customerId', async (req, res) => {
  try {
    const assets = await Collateral.find({
      customerId: req.params.customerId,
      tenantId: req.admin.tenantId
    }).populate('loanId').sort({ createdAt: -1 });

    res.json(assets);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/collateral/loan/:loanId - Fetch all collateral for a specific loan
router.get('/loan/:loanId', async (req, res) => {
  try {
    const assets = await Collateral.find({
      loanId: req.params.loanId,
      tenantId: req.admin.tenantId
    }).sort({ createdAt: -1 });

    res.json(assets);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// POST /api/collateral - Add new collateral asset
router.post('/', async (req, res) => {
  const { customerId, loanId, assetName, assetType, weight, quantity, estimatedValue, status, remarks } = req.body;

  if (!customerId || !assetName || !estimatedValue) {
    return res.status(400).json({ message: 'customerId, assetName, and estimatedValue are required.' });
  }

  try {
    const asset = new Collateral({
      customerId,
      loanId: loanId || null,
      assetName,
      assetType: assetType || 'other',
      weight: weight ? parseFloat(weight) : 0,
      quantity: quantity ? parseInt(quantity) : 1,
      estimatedValue: parseFloat(estimatedValue),
      status: status || 'pledged',
      remarks: remarks || '',
      tenantId: req.admin.tenantId
    });

    const saved = await asset.save();

    await logAuditAction(
      req.admin?.username || 'admin',
      'COLLATERAL_ADDED',
      `Added collateral asset ${assetName} (Valued at ₹${estimatedValue}) for customer ID: ${customerId}`,
      customerId,
      saved.toObject(),
      req
    );

    res.status(201).json(saved);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// PUT /api/collateral/:id - Update collateral details or release status
router.put('/:id', async (req, res) => {
  try {
    const asset = await Collateral.findOne({
      _id: req.params.id,
      tenantId: req.admin.tenantId
    });

    if (!asset) {
      return res.status(404).json({ message: 'Collateral asset not found.' });
    }

    const { assetName, assetType, weight, quantity, estimatedValue, status, remarks, loanId } = req.body;

    if (assetName !== undefined) asset.assetName = assetName;
    if (assetType !== undefined) asset.assetType = assetType;
    if (weight !== undefined) asset.weight = parseFloat(weight) || 0;
    if (quantity !== undefined) asset.quantity = parseInt(quantity) || 1;
    if (estimatedValue !== undefined) asset.estimatedValue = parseFloat(estimatedValue) || 0;
    if (status !== undefined) asset.status = status;
    if (remarks !== undefined) asset.remarks = remarks;
    if (loanId !== undefined) asset.loanId = loanId || null;

    const updated = await asset.save();

    await logAuditAction(
      req.admin?.username || 'admin',
      'COLLATERAL_UPDATED',
      `Updated collateral asset ${asset.assetName} status to ${status || asset.status}`,
      asset.customerId,
      updated.toObject(),
      req
    );

    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// DELETE /api/collateral/:id - Remove a collateral record
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Collateral.findOneAndDelete({
      _id: req.params.id,
      tenantId: req.admin.tenantId
    });

    if (!deleted) {
      return res.status(404).json({ message: 'Collateral asset not found.' });
    }

    await logAuditAction(
      req.admin?.username || 'admin',
      'COLLATERAL_DELETED',
      `Deleted collateral asset ${deleted.assetName}`,
      deleted.customerId,
      null,
      req
    );

    res.json({ message: 'Collateral record deleted successfully.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
