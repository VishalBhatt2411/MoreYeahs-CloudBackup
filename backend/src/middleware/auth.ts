import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Role, User } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { HttpError } from '../lib/http.js';

export const SESSION_COOKIE = 'cb_session';

export type AuthedUser = Pick<User, 'id' | 'email' | 'name' | 'role' | 'isPlatformAdmin' | 'tenantId'>;

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthedUser;
  }
}

/** `hours` is the company's "sign-in lasts" setting (Settings > Security). */
export function setSessionCookie(res: Response, userId: string, hours = 168) {
  const token = jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: `${hours}h` });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: hours * 3600 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Reads the login cookie and loads the user. Does not fail if there is none. */
export async function loadUser(req: Request): Promise<AuthedUser | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub?: string; iat?: number };
    if (!payload.sub) return null;
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, name: true, role: true, isPlatformAdmin: true, tenantId: true, active: true, passwordChangedAt: true },
    });
    // A switched-off account stops working at once, even with a valid cookie.
    if (!user || !user.active) return null;
    // After a password reset, logins issued before it (for example by someone who knew the old password) stop working.
    if (user.passwordChangedAt && (payload.iat ?? 0) < Math.floor(user.passwordChangedAt.getTime() / 1000)) return null;
    const { active: _active, passwordChangedAt: _changed, ...rest } = user;
    return rest;
  } catch {
    return null;
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = await loadUser(req);
    if (!user) throw new HttpError(401, 'Please sign in.', 'unauthenticated');
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

/** Use after requireAuth. Allows only the listed roles. */
export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new HttpError(403, 'Your role does not allow this action.', 'forbidden'));
    }
    next();
  };

export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user?.isPlatformAdmin) {
    return next(new HttpError(403, 'Only the platform administrator can do this.', 'forbidden'));
  }
  next();
}

/** Blocks cross-site form posts: if a browser sends an Origin header it must be our own site. */
export function sameOriginOnly(req: Request, _res: Response, next: NextFunction) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  let allowed = false;
  try {
    const o = new URL(origin);
    const app = new URL(config.appUrl);
    allowed = o.host === app.host || o.host === req.headers.host;
  } catch {
    allowed = false;
  }
  if (!allowed) return next(new HttpError(403, 'Request blocked (different origin).', 'bad_origin'));
  next();
}
