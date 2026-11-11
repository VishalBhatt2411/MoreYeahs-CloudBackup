import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { HttpError, wrap } from '../lib/http.js';
import { clearSessionCookie, requireAuth, setSessionCookie } from '../middleware/auth.js';

export const authRouter = Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isTest ? 1000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

let cachedDummy: string | undefined;
const dummyHash = () => (cachedDummy ??= bcrypt.hashSync('not-a-real-password', config.bcryptCost));

const passwordRule = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password is too long');

const registerBody = z.object({
  workspaceName: z.string().trim().min(2, 'Company name is too short').max(80),
  name: z.string().trim().min(1, 'Name is required').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: passwordRule,
});

function publicUser(u: {
  id: string;
  email: string;
  name: string;
  role: string;
  isPlatformAdmin: boolean;
  tenantId: string;
}, tenantName: string) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    isPlatformAdmin: u.isPlatformAdmin,
    tenant: { id: u.tenantId, name: tenantName },
  };
}

authRouter.post(
  '/register',
  limiter,
  wrap(async (req, res) => {
    const body = registerBody.parse(req.body);
    const exists = await prisma.user.findUnique({ where: { email: body.email } });
    if (exists) throw new HttpError(409, 'An account with this email already exists. Try signing in.');
    const passwordHash = await bcrypt.hash(body.password, config.bcryptCost);
    const tenant = await prisma.tenant.create({
      data: {
        name: body.workspaceName,
        users: { create: { email: body.email, name: body.name, passwordHash, role: 'OWNER' } },
      },
      include: { users: true },
    });
    const user = tenant.users[0]!;
    setSessionCookie(res, user.id);
    await audit(tenant.id, user.id, 'auth.register', user.email);
    res.status(201).json({ user: publicUser(user, tenant.name) });
  }),
);

authRouter.post(
  '/login',
  limiter,
  wrap(async (req, res) => {
    const body = z
      .object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) })
      .parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email }, include: { tenant: true } });
    // Same message for "no such user" and "wrong password" so attackers learn nothing.
    const ok = await bcrypt.compare(body.password, user ? user.passwordHash : dummyHash());
    if (!user || !ok) throw new HttpError(401, 'Wrong email or password.');
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    setSessionCookie(res, user.id);
    await audit(user.tenantId, user.id, 'auth.login', user.email);
    res.json({ user: publicUser(user, user.tenant.name) });
  }),
);

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user!.tenantId } });
    res.json({ user: publicUser(req.user!, tenant.name) });
  }),
);
