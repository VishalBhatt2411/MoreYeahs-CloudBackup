import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { alertRecipients } from '../backup/alerts.js';
import { previewRetention } from '../backup/retention.js';
import { getStorage, guardTenantPath } from '../backup/storage.js';
import { decrypt } from '../lib/crypto.js';
import { explainMailError, isEmailConfigured, renderEmail, sendMail } from '../lib/mail.js';
import { audit } from '../lib/audit.js';
import { HttpError, wrap } from '../lib/http.js';
import { clearSessionCookie, requireAuth, requireRole } from '../middleware/auth.js';
import { revokeToken } from '../salesforce/oauth.js';
import { hashInviteToken, sendResetEmail } from './auth.js';

export const settingsRouter = Router();
export const teamRouter = Router();
settingsRouter.use(requireAuth);
teamRouter.use(requireAuth);

const validZone = (z0: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: z0 });
    return true;
  } catch {
    return false;
  }
};

// Node lists some zones under their old names (e.g. Asia/Calcutta). People look for the current
// names, so add them when this server accepts them.
const MODERN_NAMES = ['UTC', 'Asia/Kolkata', 'Asia/Ho_Chi_Minh', 'Asia/Yangon', 'Europe/Kyiv', 'America/Argentina/Buenos_Aires', 'Atlantic/Faroe'];
const zoneList = () => [...new Set([...Intl.supportedValuesOf('timeZone'), ...MODERN_NAMES.filter(validZone)])].sort();

const tenantView = (t: {
  name: string;
  timeZone: string;
  retentionDays: number | null;
  defaultScheduleHours: number | null;
  alertOnFailure: boolean;
  alertEmail: string | null;
  sessionHours: number;
  legalHold: boolean;
  legalHoldReason: string | null;
  legalHoldAt: Date | null;
}) => ({
  legalHold: t.legalHold,
  legalHoldReason: t.legalHoldReason,
  legalHoldAt: t.legalHoldAt,
  name: t.name,
  timeZone: t.timeZone,
  retentionDays: t.retentionDays,
  defaultScheduleHours: t.defaultScheduleHours,
  alertOnFailure: t.alertOnFailure,
  alertEmail: t.alertEmail,
  sessionHours: t.sessionHours,
});

settingsRouter.get(
  '/',
  wrap(async (req, res) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user!.tenantId } });
    res.json({
      settings: tenantView(tenant),
      // Real list of zones the server knows, so the screen never offers one that would be refused.
      timeZones: zoneList(),
      // True once the platform admin has entered the mail server details.
      emailConfigured: await isEmailConfigured(),
      alertRecipients: await alertRecipients(tenant.id, tenant.alertEmail),
      recentAlerts: await prisma.alertLog.findMany({
        where: { tenantId: tenant.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, runId: true, toEmail: true, status: true, detail: true, createdAt: true },
      }),
    });
  }),
);

// Sends a sample alert to whoever would get a real one, so the owner can check it arrives.
settingsRouter.post(
  '/test-alert',
  requireRole('OWNER'),
  wrap(async (req, res) => {
    if (!(await isEmailConfigured())) {
      throw new HttpError(409, 'Email is not set up on this server yet. Ask the platform administrator to set it up.');
    }
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user!.tenantId } });
    const to = await alertRecipients(tenant.id, tenant.alertEmail);
    if (to.length === 0) throw new HttpError(400, 'There is nobody to send to. Enter an alert email first.');
    const mail = renderEmail({
      heading: 'Test alert',
      lines: [`This is a test alert for ${tenant.name}.`, 'When a backup fails, you will get an email like this one.'],
      button: { label: 'Open CloudBackup', url: `${config.appUrl}/dashboard` },
    });
    try {
      await sendMail({ to, subject: '[CloudBackup] Test alert', ...mail });
      res.json({ ok: true, message: `Test alert sent to ${to.join(', ')}.` });
    } catch (e) {
      res.json({ ok: false, message: explainMailError(e) });
    }
  }),
);

const settingsBody = z.object({
  name: z.string().trim().min(2, 'Company name is too short').max(80),
  timeZone: z.string().refine(validZone, 'Unknown time zone'),
  retentionDays: z.number().int().min(1).max(3650).nullable(),
  defaultScheduleHours: z.number().int().min(1).max(24 * 30).nullable(),
  alertOnFailure: z.boolean(),
  alertEmail: z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid alert email')]).nullable(),
  sessionHours: z.number().int().min(1).max(24 * 30),
});

settingsRouter.put(
  '/',
  requireRole('OWNER'),
  wrap(async (req, res) => {
    const body = settingsBody.parse(req.body);
    const before = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user!.tenantId } });
    const updated = await prisma.tenant.update({
      where: { id: before.id },
      data: { ...body, alertEmail: body.alertEmail || null },
    });
    const changed = (Object.keys(settingsBody.shape) as (keyof typeof body)[])
      .filter((k) => String(before[k] ?? '') !== String(updated[k] ?? ''))
      .join(', ');
    if (changed) await audit(before.id, req.user!.id, 'settings.updated', null, changed);
    res.json({ settings: tenantView(updated) });
  }),
);

// How many backups would be removed if the retention period were set to `days`. Nothing is deleted.
settingsRouter.get(
  '/retention-preview',
  wrap(async (req, res) => {
    const days = z.coerce.number().int().min(1).max(3650).parse(req.query.days);
    res.json(await previewRetention(req.user!.tenantId, days));
  }),
);

// Give every org the company's default schedule now (for orgs connected before it was set).
settingsRouter.post(
  '/apply-schedule',
  requireRole('OWNER'),
  wrap(async (req, res) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user!.tenantId } });
    const hours = tenant.defaultScheduleHours;
    const r = await prisma.orgConnection.updateMany({
      where: { tenantId: tenant.id, status: 'ACTIVE' },
      data: { scheduleHours: hours, nextRunAt: hours ? new Date(Date.now() + hours * 3600 * 1000) : null },
    });
    await audit(tenant.id, req.user!.id, 'settings.schedule.applied', null, hours ? `every ${hours}h on ${r.count} org(s)` : `off on ${r.count} org(s)`);
    res.json({ updated: r.count });
  }),
);

// ---------- Legal hold and data deletion ----------

// While a legal hold is on, nothing may be deleted automatically or by hand (retention is frozen).
settingsRouter.put(
  '/legal-hold',
  requireRole('OWNER'),
  wrap(async (req, res) => {
    const body = z
      .object({ enabled: z.boolean(), reason: z.string().trim().max(300).optional() })
      .refine((b) => !b.enabled || !!b.reason, { message: 'Say why the hold is being applied.', path: ['reason'] })
      .parse(req.body);
    const t = await prisma.tenant.update({
      where: { id: req.user!.tenantId },
      data: body.enabled
        ? { legalHold: true, legalHoldReason: body.reason, legalHoldAt: new Date() }
        : { legalHold: false, legalHoldReason: null, legalHoldAt: null },
    });
    await audit(t.id, req.user!.id, body.enabled ? 'legalhold.on' : 'legalhold.off', null, body.reason ?? null);
    res.json({ settings: tenantView(t) });
  }),
);

async function refuseIfBusyOrHeld(tenantId: string) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (tenant.legalHold) {
    throw new HttpError(409, 'A legal hold is on, so nothing can be deleted. Turn the hold off first.', 'legal_hold');
  }
  const busy = await prisma.backupRun.count({ where: { tenantId, status: { in: ['QUEUED', 'RUNNING'] } } });
  if (busy > 0) throw new HttpError(409, 'A backup is queued or running. Wait for it to finish, then try again.', 'run_active');
  return tenant;
}

// Deletes every saved backup and its files. The account, team and connected orgs stay.
settingsRouter.post(
  '/delete-backups',
  requireRole('OWNER'),
  wrap(async (req, res) => {
    const body = z.object({ confirm: z.string() }).parse(req.body);
    const tenant = await refuseIfBusyOrHeld(req.user!.tenantId);
    if (body.confirm !== tenant.name) throw new HttpError(400, 'Type the company name exactly to confirm.');
    const runs = await prisma.backupRun.count({ where: { tenantId: tenant.id } });
    await getStorage().removeTree(guardTenantPath(tenant.id, `tenants/${tenant.id}/orgs`));
    await prisma.$transaction([
      prisma.objectCheckpoint.deleteMany({ where: { tenantId: tenant.id } }),
      prisma.backupRun.deleteMany({ where: { tenantId: tenant.id } }), // items go with their run
      prisma.alertLog.deleteMany({ where: { tenantId: tenant.id } }),
    ]);
    await audit(tenant.id, req.user!.id, 'tenant.backups.deleted', null, `${runs} backup(s)`);
    res.json({ deleted: runs });
  }),
);

// Removes the whole company: org logins (revoked at Salesforce), files, accounts and records.
settingsRouter.delete(
  '/tenant',
  requireRole('OWNER'),
  wrap(async (req, res) => {
    const body = z.object({ confirm: z.string(), password: z.string().min(1) }).parse(req.body);
    const tenant = await refuseIfBusyOrHeld(req.user!.tenantId);
    if (body.confirm !== tenant.name) throw new HttpError(400, 'Type the company name exactly to confirm.');
    const me = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    if (!(await bcrypt.compare(body.password, me.passwordHash))) throw new HttpError(400, 'Your password is not correct.');
    if ((await prisma.user.count({ where: { tenantId: tenant.id, isPlatformAdmin: true } })) > 0) {
      throw new HttpError(400, 'This company holds the platform administrator account, so it cannot be deleted.');
    }
    // Tell Salesforce to forget our access first (best effort), so nothing is left that could be used.
    const conns = await prisma.orgConnection.findMany({ where: { tenantId: tenant.id } });
    for (const c of conns) {
      if (!c.refreshTokenEnc) continue;
      try {
        await revokeToken({ loginUrl: c.loginUrl, token: decrypt(c.refreshTokenEnc) });
      } catch {
        /* best effort */
      }
    }
    await getStorage().removeTree(guardTenantPath(tenant.id, `tenants/${tenant.id}/`));
    await prisma.$transaction([
      prisma.alertLog.deleteMany({ where: { tenantId: tenant.id } }),
      prisma.oAuthState.deleteMany({ where: { tenantId: tenant.id } }),
      prisma.tenant.delete({ where: { id: tenant.id } }), // users, orgs, runs, items, audit rows go with it
    ]);
    // The company's own audit rows are gone with it; leave one line that says what happened.
    await audit(null, null, 'tenant.deleted', tenant.id, `${tenant.name} (by ${me.email})`);
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

// ---------- Team ----------

const INVITE_DAYS = 7;

teamRouter.get(
  '/',
  wrap(async (req, res) => {
    const tenantId = req.user!.tenantId;
    const [users, invites] = await Promise.all([
      prisma.user.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, email: true, name: true, role: true, active: true, createdAt: true, lastLoginAt: true },
      }),
      prisma.invite.findMany({
        where: { tenantId, acceptedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, email: true, role: true, createdAt: true, expiresAt: true },
      }),
    ]);
    res.json({ users, invites });
  }),
);

teamRouter.post(
  '/invites',
  requireRole('OWNER'),
  wrap(async (req, res) => {
    const body = z
      .object({ email: z.string().trim().toLowerCase().email('Enter a valid email'), role: z.enum(['OWNER', 'ADMIN', 'VIEWER', 'AUDITOR']) })
      .parse(req.body);
    const tenantId = req.user!.tenantId;
    if (await prisma.user.findUnique({ where: { email: body.email } })) {
      throw new HttpError(409, 'Someone with this email already has an account.');
    }
    // A new invite replaces any open one for the same email.
    await prisma.invite.deleteMany({ where: { tenantId, email: body.email, acceptedAt: null } });
    const token = randomBytes(32).toString('hex');
    const invite = await prisma.invite.create({
      data: {
        tenantId,
        email: body.email,
        role: body.role,
        tokenHash: hashInviteToken(token),
        invitedById: req.user!.id,
        expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 3600 * 1000),
      },
    });
    await audit(tenantId, req.user!.id, 'team.invited', body.email, body.role);
    const link = `${config.appUrl}/join/${token}`;
    // Email the link when mail is set up. The link is still shown once, so it can be shared by hand.
    let emailed = false;
    let emailError: string | null = null;
    if (await isEmailConfigured()) {
      const [tenant, inviter] = await Promise.all([
        prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
        prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } }),
      ]);
      const mail = renderEmail({
        heading: `Join ${tenant.name} on CloudBackup`,
        lines: [
          `${inviter.name} invited you to ${tenant.name} as ${body.role.toLowerCase()}.`,
          `Open the link, choose a password, and you are in. The link works once and expires in ${INVITE_DAYS} days.`,
        ],
        button: { label: 'Accept the invitation', url: link },
      });
      try {
        await sendMail({ to: body.email, subject: `You are invited to ${tenant.name} on CloudBackup`, ...mail });
        emailed = true;
      } catch (e) {
        emailError = explainMailError(e);
      }
    }
    res.status(201).json({
      invite: { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt },
      link,
      emailed,
      emailError,
    });
  }),
);

teamRouter.delete(
  '/invites/:id',
  requireRole('OWNER'),
  wrap(async (req, res) => {
    const r = await prisma.invite.deleteMany({ where: { id: String(req.params.id), tenantId: req.user!.tenantId, acceptedAt: null } });
    if (r.count === 0) throw new HttpError(404, 'Invitation not found.');
    await audit(req.user!.tenantId, req.user!.id, 'team.invite.cancelled', String(req.params.id));
    res.json({ ok: true });
  }),
);

teamRouter.patch(
  '/users/:id',
  requireRole('OWNER'),
  wrap(async (req, res) => {
    const body = z.object({ role: z.enum(['OWNER', 'ADMIN', 'VIEWER', 'AUDITOR']).optional(), active: z.boolean().optional() }).parse(req.body);
    const tenantId = req.user!.tenantId;
    const target = await prisma.user.findFirst({ where: { id: String(req.params.id), tenantId } });
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.id === req.user!.id) throw new HttpError(400, 'You cannot change your own role or switch yourself off.');
    if (target.isPlatformAdmin && (body.active === false)) {
      throw new HttpError(400, 'The platform administrator account cannot be switched off.');
    }
    const losesOwner = target.role === 'OWNER' && target.active && ((body.role !== undefined && body.role !== 'OWNER') || body.active === false);
    if (losesOwner) {
      const others = await prisma.user.count({ where: { tenantId, role: 'OWNER', active: true, id: { not: target.id } } });
      if (others === 0) throw new HttpError(400, 'A company must keep at least one active owner.');
    }
    const updated = await prisma.user.update({ where: { id: target.id }, data: body });
    if (body.role && body.role !== target.role) await audit(tenantId, req.user!.id, 'team.role.changed', target.email, `${target.role} -> ${body.role}`);
    if (body.active !== undefined && body.active !== target.active) {
      await audit(tenantId, req.user!.id, body.active ? 'team.user.enabled' : 'team.user.disabled', target.email);
    }
    res.json({ user: { id: updated.id, role: updated.role, active: updated.active } });
  }),
);

// The owner sends a team member a "choose a new password" email. The owner never sees or sets
// the password, and cannot do this for themselves (they use "Forgot password" for that).
teamRouter.post(
  '/users/:id/reset-password',
  requireRole('OWNER'),
  wrap(async (req, res) => {
    const tenantId = req.user!.tenantId;
    const target = await prisma.user.findFirst({ where: { id: String(req.params.id), tenantId } });
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.id === req.user!.id) throw new HttpError(400, 'Use "Forgot password" on the sign-in page for your own account.');
    if (!target.active) throw new HttpError(400, 'This account is switched off. Turn it on first.');
    if (!(await isEmailConfigured())) {
      throw new HttpError(409, 'Email is not set up on this platform, so a reset link cannot be sent.', 'email_not_configured');
    }
    try {
      await sendResetEmail(target);
    } catch (e) {
      throw new HttpError(502, explainMailError(e));
    }
    await audit(tenantId, req.user!.id, 'team.reset.sent', target.email);
    res.json({ ok: true });
  }),
);
