import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { previewRetention } from '../backup/retention.js';
import { audit } from '../lib/audit.js';
import { HttpError, wrap } from '../lib/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { hashInviteToken } from './auth.js';

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
}) => ({
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
      // Email is not sent by this version, so the screen says so honestly.
      emailConfigured: false,
    });
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
      .object({ email: z.string().trim().toLowerCase().email('Enter a valid email'), role: z.enum(['OWNER', 'ADMIN', 'VIEWER']) })
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
    // The link is shown once. No email is sent by this version, so the owner shares it.
    res.status(201).json({
      invite: { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt },
      link: `${config.appUrl}/join/${token}`,
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
    const body = z.object({ role: z.enum(['OWNER', 'ADMIN', 'VIEWER']).optional(), active: z.boolean().optional() }).parse(req.body);
    const tenantId = req.user!.tenantId;
    const target = await prisma.user.findFirst({ where: { id: String(req.params.id), tenantId } });
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.id === req.user!.id) throw new HttpError(400, 'You cannot change your own role or switch yourself off.');
    if (target.isPlatformAdmin && (body.active === false)) {
      throw new HttpError(400, 'The platform administrator account cannot be switched off.');
    }
    const losesOwner = target.role === 'OWNER' && target.active && (body.role === 'ADMIN' || body.role === 'VIEWER' || body.active === false);
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
