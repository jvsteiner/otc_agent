/**
 * Simple admin authentication middleware
 * Uses bcrypt for password hashing and JWT for session tokens
 */

import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

interface AdminUser {
  email: string;
  loginAt: string;
}

export interface AuthenticatedRequest extends Request {
  admin?: AdminUser;
}

/**
 * Login endpoint - validates credentials and creates JWT token
 */
export async function adminLogin(req: Request, res: Response) {
  const { email, password } = req.body;

  // Get credentials from environment
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
  const jwtSecret = process.env.ADMIN_JWT_SECRET || 'change-me-in-production';

  if (!adminEmail || !adminPasswordHash) {
    return res.status(500).json({
      error: 'Admin credentials not configured. Run: tsx packages/backend/scripts/setup-admin.ts'
    });
  }

  // Validate email
  if (email !== adminEmail) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Validate password
  try {
    const isValid = await bcrypt.compare(password, adminPasswordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    console.error('[AdminAuth] Password validation error:', error);
    return res.status(500).json({ error: 'Authentication error' });
  }

  // Create JWT token
  const token = (jwt.sign as any)(
    { email, loginAt: new Date().toISOString() },
    jwtSecret,
    { expiresIn: process.env.ADMIN_SESSION_EXPIRY || '24h' }
  );

  // Set HTTP-only cookie
  res.cookie('admin_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  });

  return res.json({
    success: true,
    email,
    message: 'Login successful'
  });
}

/**
 * Logout endpoint - clears session cookie
 */
export function adminLogout(req: Request, res: Response) {
  res.clearCookie('admin_token');
  return res.json({ success: true, message: 'Logged out' });
}

/**
 * Auth middleware - validates JWT token from cookie
 */
export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.admin_token;
  const jwtSecret = process.env.ADMIN_JWT_SECRET || 'change-me-in-production';

  if (!token) {
    return res.redirect('/admin/login');
  }

  try {
    const decoded = jwt.verify(token, jwtSecret) as AdminUser;
    req.admin = decoded;
    next();
  } catch (error) {
    res.clearCookie('admin_token');
    return res.redirect('/admin/login');
  }
}

/**
 * API auth middleware - returns JSON error instead of redirect
 */
export function requireAdminAPI(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = req.cookies?.admin_token;
  const jwtSecret = process.env.ADMIN_JWT_SECRET || 'change-me-in-production';

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const decoded = jwt.verify(token, jwtSecret) as AdminUser;
    req.admin = decoded;
    next();
  } catch (error) {
    res.clearCookie('admin_token');
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}
