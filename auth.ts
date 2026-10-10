import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { prisma } from './prisma.js';
import { writeAuditLog } from './audit.js';

export type AdminRole = 'ADMIN' | 'MANAGER' | 'VIEWER';

// Augment express-session's SessionData
declare module 'express-session' {
  interface SessionData {
    adminId?: string;
    adminEmail?: string;
    adminRole?: AdminRole;
  }
}

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Requires a valid, active admin session. Attaches req.admin.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session || !req.session.adminId) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }
  next();
}

/**
 * Requires the session's admin to have one of the given roles.
 * Must be used AFTER requireAuth.
 */
export function requireRole(...roles: AdminRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.session?.adminRole;
    if (!role || !roles.includes(role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    next();
  };
}

// ── Simple in-memory login rate limiter (per email+ip) ──────────────────
// For 400 drivers / a handful of admins, this is sufficient; a Redis-backed
// limiter would be overkill for this scale and budget.
const loginAttempts = new Map<string, { count: number; firstAttemptAt: number }>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_MAX_ATTEMPTS = 8;

function loginRateLimitKey(email: string, ip: string) {
  return `${email.toLowerCase()}::${ip}`;
}

export function isLoginRateLimited(email: string, ip: string): boolean {
  const key = loginRateLimitKey(email, ip);
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

export function recordLoginFailure(email: string, ip: string) {
  const key = loginRateLimitKey(email, ip);
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttemptAt: Date.now() });
  } else {
    entry.count += 1;
  }
}

export function clearLoginFailures(email: string, ip: string) {
  loginAttempts.delete(loginRateLimitKey(email, ip));
}

/**
 * Handles POST /api/admin/login
 */
export async function loginHandler(req: Request, res: Response) {
  const email = (req.body?.email || '').toString().trim().toLowerCase();
  const password = (req.body?.password || '').toString();
  const ip = req.ip || 'unknown';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  if (isLoginRateLimited(email, ip)) {
    return res.status(429).json({ error: 'Too many failed login attempts. Please try again later.' });
  }

  const admin = await prisma.adminUser.findUnique({ where: { email } });

  if (!admin || admin.status !== 'ACTIVE') {
    recordLoginFailure(email, ip);
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const valid = await verifyPassword(password, admin.passwordHash);
  if (!valid) {
    recordLoginFailure(email, ip);
    await writeAuditLog({
      adminId: null,
      action: 'ADMIN_LOGIN_FAILED',
      entityType: 'AdminUser',
      entityId: admin.id,
      details: { email },
      ipAddress: ip,
    });
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  clearLoginFailures(email, ip);

  req.session.adminId = admin.id;
  req.session.adminEmail = admin.email;
  req.session.adminRole = admin.role as AdminRole;

  await writeAuditLog({
    adminId: admin.id,
    action: 'ADMIN_LOGIN_SUCCESS',
    entityType: 'AdminUser',
    entityId: admin.id,
    ipAddress: ip,
  });

  res.json({
    success: true,
    admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
  });
}

export async function logoutHandler(req: Request, res: Response) {
  const adminId = req.session?.adminId;
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to log out.' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
}

export async function meHandler(req: Request, res: Response) {
  if (!req.session?.adminId) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  const admin = await prisma.adminUser.findUnique({ where: { id: req.session.adminId } });
  if (!admin || admin.status !== 'ACTIVE') {
    return res.status(401).json({ error: 'Session no longer valid.' });
  }
  res.json({ admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } });
}
