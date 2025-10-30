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

  // Parse session expiry - support both seconds (3600) and time strings ('24h')
  const sessionExpiry = process.env.ADMIN_SESSION_EXPIRY || '24h';
  const sessionExpiryMs = typeof sessionExpiry === 'string' && /^\d+$/.test(sessionExpiry)
    ? parseInt(sessionExpiry) * 1000  // If numeric string, treat as seconds and convert to ms
    : 24 * 60 * 60 * 1000;             // Otherwise use default 24h in ms

  // Create JWT token with matching expiry
  const token = (jwt.sign as any)(
    { email, loginAt: new Date().toISOString() },
    jwtSecret,
    {
      expiresIn: typeof sessionExpiry === 'string' && /^\d+$/.test(sessionExpiry)
        ? parseInt(sessionExpiry)  // JWT expects seconds for numeric values
        : sessionExpiry            // Or time strings like '24h'
    }
  );

  // Set HTTP-only cookie with MATCHING expiry
  res.cookie('admin_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',  // Changed from 'strict' for better compatibility
    maxAge: sessionExpiryMs,  // Now dynamically matches JWT expiry
    path: '/' // CRITICAL: Cookie must be available to all routes
  });

  // Check if there's a return URL to redirect back to
  const returnUrl = req.query.returnUrl as string;
  const redirectTo = returnUrl && returnUrl.startsWith('/admin/') ? returnUrl : '/admin/deals';

  return res.redirect(redirectTo);
}

/**
 * Logout endpoint - clears session cookie
 */
export function adminLogout(req: Request, res: Response) {
  res.clearCookie('admin_token', {
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'  // Must match set options exactly
  });
  return res.redirect('/admin/login');
}

/**
 * Auth middleware - validates JWT token from cookie
 */
export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.admin_token;
  const jwtSecret = process.env.ADMIN_JWT_SECRET || 'change-me-in-production';

  if (!token) {
    // Preserve the original URL to redirect back after login
    const returnUrl = encodeURIComponent(req.originalUrl);
    return res.redirect(`/admin/login?returnUrl=${returnUrl}`);
  }

  try {
    const decoded = jwt.verify(token, jwtSecret) as AdminUser;
    req.admin = decoded;
    next();
  } catch (error) {
    // Log JWT verification errors to help debug session issues
    console.warn(`[AdminAuth] JWT verification failed for ${req.originalUrl}:`, error instanceof Error ? error.message : 'Unknown error');

    res.clearCookie('admin_token', {
      path: '/',
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });
    // Preserve the original URL to redirect back after login
    const returnUrl = encodeURIComponent(req.originalUrl);
    return res.redirect(`/admin/login?returnUrl=${returnUrl}`);
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
    console.warn(`[AdminAuth] API JWT verification failed:`, error instanceof Error ? error.message : 'Unknown error');

    res.clearCookie('admin_token', {
      path: '/',
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}
