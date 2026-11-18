import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.ts';
import { getDb, isoNow } from './db.ts';

export type UserRole = 'OPERATOR' | 'REVIEWER' | 'AUDITOR' | 'ADMIN';

export interface AuthUser {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  theme_preference: 'light' | 'dark' | 'system';
  is_active: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId?: string;
    }
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, keyHex] = storedHash.split(':');
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

export function signSessionToken(user: AuthUser): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
    },
    config.jwtSecret,
    { expiresIn: '12h' }
  );
}

export function setSessionCookie(res: Response, token: string, req?: Request): void {
  const isHttps =
    Boolean(req?.secure) || req?.headers['x-forwarded-proto'] === 'https';
  res.cookie(config.sessionCookieName, token, {
    httpOnly: true,
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
    path: '/',
    maxAge: 12 * 60 * 60 * 1000,
  });
  res.clearCookie(config.signedOutCookieName, { path: '/' });
}

export function clearSessionCookie(res: Response, markSignedOut = false): void {
  res.clearCookie(config.sessionCookieName, { path: '/' });
  if (markSignedOut) {
    res.cookie(config.signedOutCookieName, '1', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 24 * 60 * 60 * 1000,
    });
  }
}

function getDemoUserByRole(role: UserRole = 'ADMIN'): AuthUser | null {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT id, email, full_name, role, theme_preference, is_active FROM users WHERE role = ? AND is_active = 1 ORDER BY created_at ASC LIMIT 1'
    )
    .get(role) as AuthUser | undefined;
  if (row) return row;
  const fallback = db
    .prepare(
      'SELECT id, email, full_name, role, theme_preference, is_active FROM users WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1'
    )
    .get() as AuthUser | undefined;
  return fallback ?? null;
}

export function getUserFromRequest(req: Request): AuthUser | null {
  if (config.pauseAuthForDemo || config.enableDemoRoleSwitcher) {
    const headerUserId = String(
      req.header('X-Demo-User-Id') ?? req.query?.demo_user_id ?? ''
    ).trim();
    if (headerUserId) {
      const db = getDb();
      const targetUser = db
        .prepare(
          'SELECT id, email, full_name, role, theme_preference, is_active FROM users WHERE id = ? AND is_active = 1'
        )
        .get(headerUserId) as AuthUser | undefined;
      if (targetUser) return targetUser;
    }

    const headerRole = String(
      req.header('X-Demo-Role') ?? req.query?.demo_role ?? ''
    ).toUpperCase() as UserRole;
    if (['OPERATOR', 'REVIEWER', 'AUDITOR', 'ADMIN'].includes(headerRole)) {
      const demoUser = getDemoUserByRole(headerRole);
      if (demoUser) return demoUser;
    }
  }

  const token = req.cookies?.[config.sessionCookieName];
  if (token && typeof token === 'string') {
    try {
      const decoded = jwt.verify(token, config.jwtSecret) as { sub: string };
      const db = getDb();
      const row = db
        .prepare(
          'SELECT id, email, full_name, role, theme_preference, is_active FROM users WHERE id = ? AND is_active = 1'
        )
        .get(decoded.sub) as AuthUser | undefined;
      if (row) return row;
    } catch {
      // Fall through to demo user when auth is paused
    }
  }

  if (config.pauseAuthForDemo) {
    return getDemoUserByRole('ADMIN');
  }

  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = getUserFromRequest(req);
  if (!user) {
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required.',
        request_id: req.requestId,
        details: {},
      },
    });
    return;
  }
  req.user = user;
  next();
}

export function requireRoles(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required.',
          request_id: req.requestId,
          details: {},
        },
      });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `Role '${req.user.role}' is not permitted to perform this action.`,
          request_id: req.requestId,
          details: { required_roles: roles, actual_role: req.user.role },
        },
      });
      return;
    }
    next();
  };
}

export function writeAuditLog(params: {
  actorId: string | null;
  actorType: 'USER' | 'SYSTEM';
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string;
  originalDecision?: string | null;
  newDecision?: string | null;
  details?: Record<string, unknown>;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO audit_logs (actor_id, actor_type, actor_role, action, resource_type, resource_id, original_decision, new_decision, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.actorId,
    params.actorType,
    params.actorRole,
    params.action,
    params.resourceType,
    params.resourceId,
    params.originalDecision ?? null,
    params.newDecision ?? null,
    JSON.stringify(params.details ?? {}),
    isoNow()
  );
}
