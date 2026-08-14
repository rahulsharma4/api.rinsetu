import dotenv from 'dotenv';
import { verifyToken } from '../utils/jwtHelper.js';

dotenv.config();

/**
 * Middleware: Har protected route pe pehle JWT token verify karo.
 */
export function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"

  if (!token) {
    return res.status(401).json({
      message: 'Access denied. Pehle login karein.',
      code: 'NO_TOKEN'
    });
  }

  try {
    const decoded = verifyToken(token, process.env.JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      message: 'Session expire ho gaya. Dobara login karein.',
      code: 'INVALID_TOKEN'
    });
  }
}
