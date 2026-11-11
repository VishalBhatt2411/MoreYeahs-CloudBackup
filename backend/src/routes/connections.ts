import { Router } from 'express';
import { z } from 'zod';
import type { OrgConnection } from '@prisma/client';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { decrypt } from '../lib/crypto.js';
import { HttpError, wrap } from '../lib/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { classifyObjects } from '../backup/coverage.js';
import { startRun } from '../backup/runner.js';
import { getGateway } from '../salesforce/gateway.js';
import { SalesforceAuthError, fetchIdentity, refreshOrgLogin, requireAppCredentials, revokeToken } from '../salesforce/oauth.js';

export const connectionsRouter = Router();
connectionsRouter.use(requireAuth);

/** What the browser may see about a connection. Never includes the token. */
function publicView(c: OrgConnection) {
  return {
    id: c.id,
    label: c.label,
    environment: c.environment,
    username: c.username,
    orgName: c.orgName,
    sfOrgId: c.sfOrgId,
    instanceUrl: c.instanceUrl,
    status: c.status,
    lastError: c.lastError,
    connectedAt: c.connectedAt,
    lastCheckedAt: c.lastCheckedAt,
    scheduleHours: c.scheduleHours,
    nextRunAt: c.nextRunAt,
  };
}

async function findMine(tenantId: string, id: string) {
  const c = await prisma.orgConnection.findFirst({ where: { id, tenantId } });
  if (!c) throw new HttpError(404, 'Org not found.');
  return c;
}

connectionsRouter.get(
  '/',
  wrap(async (req, res) => {
    const list = await prisma.orgConnection.findMany({
      where: { tenantId: req.user!.tenantId },
      orderBy: { connectedAt: 'desc' },
    });
    const lastRuns = await prisma.backupRun.findMany({
      where: { tenantId: req.user!.tenantId, connectionId: { in: list.map((c) => c.id) } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, connectionId: true, status: true, createdAt: true, finishedAt: true },
    });
    const latest = new Map<string, (typeof lastRuns)[number]>();
    for (const r of lastRuns) if (!latest.has(r.connectionId)) latest.set(r.connectionId, r);
    res.json({ connections: list.map((c) => ({ ...publicView(c), lastRun: latest.get(c.id) ?? null })) });
  }),
);

connectionsRouter.get(
  '/:id',
  wrap(async (req, res) => {
    res.json({ connection: publicView(await findMine(req.user!.tenantId, req.params.id)) });
  }),
);

/** Disconnect: tells Salesforce to forget the token, then removes it from our database. Backups already taken are kept. */
connectionsRouter.delete(
  '/:id',
  requireRole('OWNER', 'ADMIN'),
  wrap(async (req, res) => {
    const c = await findMine(req.user!.tenantId, req.params.id);
    try {
      await revokeToken({ loginUrl: c.loginUrl, token: decrypt(c.refreshTokenEnc) });
    } catch {
      /* best effort */
    }
    await prisma.orgConnection.update({
      where: { id: c.id },
      data: { status: 'DISCONNECTED', refreshTokenEnc: '', scheduleHours: null, nextRunAt: null, lastError: null },
    });
    await audit(c.tenantId, req.user!.id, 'org.disconnect', c.id, c.label);
    res.json({ ok: true });
  }),
);

/** Health check: can we still log in to this org with the saved token? */
connectionsRouter.post(
  '/:id/check',
  requireRole('OWNER', 'ADMIN'),
  wrap(async (req, res) => {
    const c = await findMine(req.user!.tenantId, req.params.id);
    if (c.status === 'DISCONNECTED') throw new HttpError(409, 'This org is disconnected. Connect it again first.');
    const creds = await requireAppCredentials();
    try {
      const t = await refreshOrgLogin(c, creds);
      const updated = await prisma.orgConnection.update({
        where: { id: c.id },
        data: { status: 'ACTIVE', lastError: null, lastCheckedAt: new Date(), instanceUrl: t.instanceUrl },
      });
      res.json({ ok: true, connection: publicView(updated) });
    } catch (e) {
      if (e instanceof SalesforceAuthError) {
        const updated = await prisma.orgConnection.update({
          where: { id: c.id },
          data: { status: 'NEEDS_RECONNECT', lastError: 'Salesforce no longer accepts the saved login. Please reconnect.', lastCheckedAt: new Date() },
        });
        res.json({ ok: false, connection: publicView(updated) });
        return;
      }
      throw new HttpError(502, 'Could not reach Salesforce to check this org. Try again in a moment.');
    }
  }),
);

/** Lists what a backup would copy and what it would not (with the reason). */
connectionsRouter.get(
  '/:id/coverage',
  wrap(async (req, res) => {
    const c = await findMine(req.user!.tenantId, req.params.id);
    if (c.status !== 'ACTIVE') throw new HttpError(409, 'Reconnect this org to see what can be backed up.');
    let gw;
    try {
      gw = await getGateway(c);
    } catch {
      throw new HttpError(502, 'Could not log in to Salesforce. Use "Check connection" or reconnect the org.');
    }
    const [objects, types] = await Promise.all([gw.describeGlobal(), gw.describeMetadataTypes()]);
    const { included, excluded } = classifyObjects(objects);
    res.json({
      apiVersion: gw.apiVersion,
      objects: included.map((o) => ({ name: o.name, label: o.label, custom: o.custom })),
      excludedObjects: excluded,
      metadataTypes: types.map((t) => t.xmlName).sort(),
    });
  }),
);

connectionsRouter.put(
  '/:id/schedule',
  requireRole('OWNER', 'ADMIN'),
  wrap(async (req, res) => {
    const body = z.object({ scheduleHours: z.number().int().min(1).max(24 * 30).nullable() }).parse(req.body);
    const c = await findMine(req.user!.tenantId, req.params.id);
    if (c.status !== 'ACTIVE') throw new HttpError(409, 'Reconnect this org before scheduling backups.');
    const updated = await prisma.orgConnection.update({
      where: { id: c.id },
      data: {
        scheduleHours: body.scheduleHours,
        nextRunAt: body.scheduleHours ? new Date(Date.now() + body.scheduleHours * 3600 * 1000) : null,
      },
    });
    await audit(c.tenantId, req.user!.id, 'org.schedule', c.id, body.scheduleHours ? `every ${body.scheduleHours}h` : 'off');
    res.json({ connection: publicView(updated) });
  }),
);

connectionsRouter.post(
  '/:id/runs',
  requireRole('OWNER', 'ADMIN'),
  wrap(async (req, res) => {
    const body = z
      .object({
        includeMetadata: z.boolean().optional(),
        objects: z.array(z.string().regex(/^[A-Za-z0-9_]+$/)).max(2000).optional(),
        fullCopy: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const c = await findMine(req.user!.tenantId, req.params.id);
    const run = await startRun({ connection: c, userId: req.user!.id, trigger: 'manual', options: body });
    res.status(202).json({ run: { id: run.id, status: run.status } });
  }),
);

// `fetchIdentity` is re-exported for the connect callback's tests.
export { fetchIdentity };
