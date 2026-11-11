import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { HttpError, wrap } from '../lib/http.js';
import { explainMailError, isEmailConfigured, renderEmail, sendMail } from '../lib/mail.js';
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
    // Customers must prove they own the email, but only once the platform can actually send mail
    // (otherwise nobody could ever finish signing up). The very first account (the platform admin)
    // is exempt: it is the person who sets mail up in the first place.
    const mailReady = await isEmailConfigured();
    // The very first account on a fresh install becomes the platform admin (it can save the
    // Salesforce Connected App details). Every later account is a normal customer.
    // A database lock makes sure two sign-ups at the same moment cannot both become admin.
    const tenant = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(727001)`;
      const adminExists = (await tx.user.count({ where: { isPlatformAdmin: true } })) > 0;
      const needsVerification = mailReady && adminExists;
      return tx.tenant.create({
        data: {
          name: body.workspaceName,
          users: {
            create: {
              email: body.email,
              name: body.name,
              passwordHash,
              role: 'OWNER',
              isPlatformAdmin: !adminExists,
              emailVerifiedAt: needsVerification ? null : new Date(),
            },
          },
        },
        include: { users: true },
      });
    });
    const user = tenant.users[0]!;
    await audit(tenant.id, user.id, 'auth.register', user.email);
    if (!user.emailVerifiedAt) {
      try {
        await sendVerificationEmail(user);
      } catch (e) {
        console.error('Verification email failed:', explainMailError(e));
      }
      // No login yet: the person must open the link in the email first.
      res.status(201).json({ verificationRequired: true, email: user.email });
      return;
    }
    setSessionCookie(res, user.id);
    res.status(201).json({ user: publicUser(user, tenant) });
  }),
);

// ---- Email verification ----------------------------------------------------------------------

export const VERIFY_HOURS = 24;
const VERIFY_COOLDOWN_MS = 60 * 1000;

// Each request can send an email, so this is stricter than the general limiter.
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isTest ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

async function sendVerificationEmail(user: { id: string; email: string; name: string; tenantId: string }) {
  const token = randomBytes(32).toString('hex');
  await prisma.emailVerification.create({
    data: { userId: user.id, tokenHash: hashInviteToken(token), expiresAt: new Date(Date.now() + VERIFY_HOURS * 3600 * 1000) },
  });
  const mail = renderEmail({
    heading: 'Confirm your email',
    lines: [
      `Hi ${user.name}, welcome to CloudBackup. Please confirm that this is your email address.`,
      `This link works once and for ${VERIFY_HOURS} hours.`,
    ],
    button: { label: 'Confirm my email', url: `${config.appUrl}/verify/${token}` },
  });
  await sendMail({ to: user.email, subject: 'Confirm your CloudBackup email', text: mail.text, html: mail.html });
  await audit(user.tenantId, user.id, 'auth.verify.sent', user.email);
}

authRouter.post(
  '/verify-email',
  limiter,
  wrap(async (req, res) => {
    const body = z.object({ token: z.string().min(10) }).parse(req.body);
    const row = await prisma.emailVerification.findUnique({ where: { tokenHash: hashInviteToken(body.token) }, include: { user: true } });
    if (!row || row.usedAt || row.expiresAt < new Date()) {
      throw new HttpError(404, 'This confirmation link is not valid any more. Ask for a new one on the sign-in page.', 'verify_invalid');
    }
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const used = await tx.emailVerification.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
      if (used.count !== 1) throw new HttpError(404, 'This confirmation link was already used.', 'verify_invalid');
      await tx.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: row.user.emailVerifiedAt ?? now } });
    });
    await audit(row.user.tenantId, row.userId, 'auth.verified', row.user.email);
    // Deliberately does not sign anyone in: the link alone must not be enough to get a session.
    res.json({ ok: true });
  }),
);

// Same answer whether or not the address has an unverified account.
authRouter.post(
  '/resend-verification',
  verifyLimiter,
  wrap(async (req, res) => {
    const body = z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email') }).parse(req.body);
    if (!(await isEmailConfigured())) {
      throw new HttpError(409, 'Email is not set up on this platform, so a confirmation cannot be sent.', 'email_not_configured');
    }
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (user && user.active && !user.emailVerifiedAt) {
      const recent = await prisma.emailVerification.count({ where: { userId: user.id, createdAt: { gt: new Date(Date.now() - VERIFY_COOLDOWN_MS) } } });
      if (recent === 0) void sendVerificationEmail(user).catch((e) => console.error('Verification email failed:', explainMailError(e)));
    }
    res.json({ ok: true });
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
    // Only said after the password is right, so it reveals nothing to someone guessing emails.
    if (!user.emailVerifiedAt) {
      throw new HttpError(403, 'Please confirm your email first. Open the link we sent you, or ask for a new one below.', 'email_not_verified');
    }
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
        // Opening the emailed invitation already proves the person owns that address.
        data: { email: invite.email, name: body.name, passwordHash, role: invite.role, tenantId: invite.tenantId, lastLoginAt: new Date(), emailVerifiedAt: new Date() },
      });
    });
    setSessionCookie(res, user.id, invite.tenant.sessionHours);
    await audit(invite.tenantId, user.id, 'team.invite.accepted', user.email);
    res.status(201).json({ user: publicUser(user, invite.tenant) });
  }),
);

// ---- Forgot password -------------------------------------------------------------------------

export const RESET_MINUTES = 60;
const RESET_COOLDOWN_MS = 60 * 1000;

// Stricter than the general limiter: each request can send an email.
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isTest ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

export async function sendResetEmail(user: { id: string; email: string; name: string; tenantId: string }) {
  const token = randomBytes(32).toString('hex');
  await prisma.passwordReset.create({
    data: { userId: user.id, tokenHash: hashInviteToken(token), expiresAt: new Date(Date.now() + RESET_MINUTES * 60 * 1000) },
  });
  const link = `${config.appUrl}/reset/${token}`;
  const mail = renderEmail({
    heading: 'Reset your password',
    lines: [
      `Hi ${user.name}, we got a request to reset the password for your CloudBackup account.`,
      `This link works once and for ${RESET_MINUTES} minutes.`,
      'If you did not ask for this, you can ignore this email. Your password stays as it is.',
    ],
    button: { label: 'Choose a new password', url: link },
  });
  await sendMail({ to: user.email, subject: 'Reset your CloudBackup password', text: mail.text, html: mail.html });
  await audit(user.tenantId, user.id, 'auth.password.reset.requested', user.email);
}

// Always answers the same, whether or not the email has an account, so nobody can use it to find accounts.
authRouter.post(
  '/forgot-password',
  resetLimiter,
  wrap(async (req, res) => {
    const body = z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email') }).parse(req.body);
    // This says nothing about any account: it is the state of the whole platform.
    if (!(await isEmailConfigured())) {
      throw new HttpError(409, 'Password reset by email is not set up on this platform. Ask your company owner or the platform administrator.', 'email_not_configured');
    }
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (user && user.active) {
      const recent = await prisma.passwordReset.count({ where: { userId: user.id, createdAt: { gt: new Date(Date.now() - RESET_COOLDOWN_MS) } } });
      // Send in the background so the answer takes the same time either way.
      if (recent === 0) {
        void sendResetEmail(user).catch((e) => console.error('Password reset email failed:', explainMailError(e)));
      }
    }
    res.json({ ok: true });
  }),
);

async function findOpenReset(token: string) {
  const reset = await prisma.passwordReset.findUnique({ where: { tokenHash: hashInviteToken(token) }, include: { user: true } });
  if (!reset || reset.usedAt || reset.expiresAt < new Date() || !reset.user.active) {
    throw new HttpError(404, 'This reset link is not valid any more. Ask for a new one.', 'reset_invalid');
  }
  return reset;
}

// Lets the page say "this link is no good" before the person types a password.
authRouter.get(
  '/reset/:token',
  limiter,
  wrap(async (req, res) => {
    const reset = await findOpenReset(String(req.params.token));
    res.json({ email: reset.user.email });
  }),
);

authRouter.post(
  '/reset-password',
  limiter,
  wrap(async (req, res) => {
    const body = z.object({ token: z.string().min(10), password: passwordRule }).parse(req.body);
    const reset = await findOpenReset(body.token);
    const passwordHash = await bcrypt.hash(body.password, config.bcryptCost);
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      // Claim the link first, so one link cannot be used twice at the same moment.
      const used = await tx.passwordReset.updateMany({ where: { id: reset.id, usedAt: null }, data: { usedAt: now } });
      if (used.count !== 1) throw new HttpError(404, 'This reset link was already used.', 'reset_invalid');
      // Any other open links for this person die too, and every existing login stops working.
      await tx.passwordReset.updateMany({ where: { userId: reset.userId, usedAt: null }, data: { usedAt: now } });
      // The link was delivered to their mailbox, which also proves they own the address.
      await tx.user.update({ where: { id: reset.userId }, data: { passwordHash, passwordChangedAt: now, emailVerifiedAt: reset.user.emailVerifiedAt ?? now } });
    });
    clearSessionCookie(res);
    await audit(reset.user.tenantId, reset.userId, 'auth.password.reset', reset.user.email);
    res.json({ ok: true });
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
