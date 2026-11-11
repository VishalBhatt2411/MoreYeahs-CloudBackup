import { createHash } from 'node:crypto';
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
}, tenant: { name: string; timeZone: string }) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    isPlatformAdmin: u.isPlatformAdmin,
    tenant: { id: u.tenantId, name: tenant.name, timeZone: tenant.timeZone },
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
    // The very first account on a fresh install becomes the platform admin (it can save the
    // Salesforce Connected App details). Every later account is a normal customer.
    // A database lock makes sure two sign-ups at the same moment cannot both become admin.
    const tenant = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(727001)`;
      const adminExists = (await tx.user.count({ where: { isPlatformAdmin: true } })) > 0;
      return tx.tenant.create({
        data: {
          name: body.workspaceName,
          users: {
            create: { email: body.email, name: body.name, passwordHash, role: 'OWNER', isPlatformAdmin: !adminExists },
          },
        },
        include: { users: true },
      });
    });
    const user = tenant.users[0]!;
    setSessionCookie(res, user.id);
    await audit(tenant.id, user.id, 'auth.register', user.email);
    res.status(201).json({ user: publicUser(user, tenant) });
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
    if (!user.active) throw new HttpError(403, 'This account has been switched off. Ask your company owner.', 'account_disabled');
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    setSessionCookie(res, user.id, user.tenant.sessionHours);
    await audit(user.tenantId, user.id, 'auth.login', user.email);
    res.json({ user: publicUser(user, user.tenant) });
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
    res.json({ user: publicUser(req.user!, tenant) });
  }),
);

export const hashInviteToken = (t: string) => createHash('sha256').update(t).digest('hex');

async function findOpenInvite(token: string) {
  const invite = await prisma.invite.findUnique({ where: { tokenHash: hashInviteToken(token) }, include: { tenant: true } });
  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
    throw new HttpError(404, 'This invitation is not valid any more. Ask your company owner for a new one.', 'invite_invalid');
  }
  return invite;
}

// What the "Join your team" page shows before the person picks a password.
authRouter.get(
  '/invite/:token',
  limiter,
  wrap(async (req, res) => {
    const invite = await findOpenInvite(String(req.params.token));
    res.json({ email: invite.email, role: invite.role, company: invite.tenant.name });
  }),
);

authRouter.post(
  '/accept-invite',
  limiter,
  wrap(async (req, res) => {
    const body = z
      .object({ token: z.string().min(10), name: z.string().trim().min(1, 'Name is required').max(80), password: passwordRule })
      .parse(req.body);
    const invite = await findOpenInvite(body.token);
    if (await prisma.user.findUnique({ where: { email: invite.email } })) {
      throw new HttpError(409, 'An account with this email already exists. Try signing in.');
    }
    const passwordHash = await bcrypt.hash(body.password, config.bcryptCost);
    // Mark the invite used first, in the same step, so one link cannot create two accounts.
    const user = await prisma.$transaction(async (tx) => {
      const used = await tx.invite.updateMany({ where: { id: invite.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
      if (used.count !== 1) throw new HttpError(404, 'This invitation was already used.', 'invite_invalid');
      return tx.user.create({
        data: { email: invite.email, name: body.name, passwordHash, role: invite.role, tenantId: invite.tenantId, lastLoginAt: new Date() },
      });
    });
    setSessionCookie(res, user.id, invite.tenant.sessionHours);
    await audit(invite.tenantId, user.id, 'team.invite.accepted', user.email);
    res.status(201).json({ user: publicUser(user, invite.tenant) });
  }),
);

authRouter.post(
  '/password',
  limiter,
  requireAuth,
  wrap(async (req, res) => {
    const body = z.object({ currentPassword: z.string().min(1), newPassword: passwordRule }).parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    if (!(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
      throw new HttpError(400, 'Your current password is not correct.');
    }
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(body.newPassword, config.bcryptCost) } });
    await audit(user.tenantId, user.id, 'auth.password.changed', user.email);
    res.json({ ok: true });
  }),
);
