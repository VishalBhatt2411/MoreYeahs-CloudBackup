import { Router } from 'express';
import { prisma } from '../db.js';
import { wrap } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

const DAY = 24 * 3600 * 1000;

interface Attention {
  kind: 'reconnect' | 'failed' | 'partial' | 'overdue' | 'never';
  connectionId: string;
  orgLabel: string;
  text: string;
  runId?: string;
}

/** Everything the Dashboard screen shows, for the signed-in user's company only. */
dashboardRouter.get(
  '/',
  wrap(async (req, res) => {
    const tenantId = req.user!.tenantId;
    const since = new Date(Date.now() - 30 * DAY);

    const [tenant, connections, recent, byStatus, storage, running] = await Promise.all([
      prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { retentionDays: true, timeZone: true } }),
      prisma.orgConnection.findMany({ where: { tenantId, status: { not: 'DISCONNECTED' } }, orderBy: { label: 'asc' } }),
      prisma.backupRun.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: { connection: { select: { label: true, username: true } } },
      }),
      prisma.backupRun.groupBy({ by: ['status'], where: { tenantId, createdAt: { gte: since } }, _count: true }),
      prisma.backupItem.aggregate({ where: { tenantId }, _sum: { bytes: true, rowCount: true } }),
      prisma.backupRun.count({ where: { tenantId, status: { in: ['QUEUED', 'RUNNING'] } } }),
    ]);

    const orgs = [];
    const attention: Attention[] = [];
    for (const c of connections) {
      const [last, lastGood] = await Promise.all([
        prisma.backupRun.findFirst({ where: { connectionId: c.id }, orderBy: { createdAt: 'desc' } }),
        prisma.backupRun.findFirst({ where: { connectionId: c.id, status: 'SUCCEEDED' }, orderBy: { finishedAt: 'desc' } }),
      ]);
      orgs.push({
        id: c.id,
        label: c.label,
        username: c.username,
        environment: c.environment,
        status: c.status,
        scheduleHours: c.scheduleHours,
        nextRunAt: c.nextRunAt,
        lastRun: last ? { id: last.id, status: last.status, finishedAt: last.finishedAt, createdAt: last.createdAt } : null,
        lastGoodAt: lastGood?.finishedAt ?? null,
      });
      if (c.status === 'NEEDS_RECONNECT') {
        attention.push({ kind: 'reconnect', connectionId: c.id, orgLabel: c.label, text: 'Salesforce no longer accepts the saved login. Connect it again.' });
      } else if (!last) {
        attention.push({ kind: 'never', connectionId: c.id, orgLabel: c.label, text: 'No backup has been taken yet.' });
      } else if (last.status === 'FAILED') {
        attention.push({ kind: 'failed', connectionId: c.id, orgLabel: c.label, text: last.message ?? 'The last backup failed.', runId: last.id });
      } else if (last.status === 'PARTIAL') {
        attention.push({ kind: 'partial', connectionId: c.id, orgLabel: c.label, text: 'The last backup is partial: some items were not copied.', runId: last.id });
      }
      // Scheduled but nothing good for twice the schedule: the schedule is not delivering.
      if (c.status === 'ACTIVE' && c.scheduleHours && last && last.status !== 'FAILED') {
        const age = Date.now() - (lastGood?.finishedAt ?? last.createdAt).getTime();
        if (age > 2 * c.scheduleHours * 3600 * 1000 && !attention.some((a) => a.connectionId === c.id)) {
          attention.push({ kind: 'overdue', connectionId: c.id, orgLabel: c.label, text: `No successful backup for longer than twice its schedule (every ${c.scheduleHours} h).` });
        }
      }
    }

    const counts = { SUCCEEDED: 0, PARTIAL: 0, FAILED: 0, RUNNING: 0, QUEUED: 0 } as Record<string, number>;
    for (const g of byStatus) counts[g.status] = g._count;

    res.json({
      timeZone: tenant.timeZone,
      retentionDays: tenant.retentionDays,
      totals: {
        orgs: connections.length,
        connected: connections.filter((c) => c.status === 'ACTIVE').length,
        running,
        bytes: storage._sum.bytes ?? 0,
        rows: storage._sum.rowCount ?? 0,
      },
      last30Days: counts,
      nextScheduled: connections
        .filter((c) => c.status === 'ACTIVE' && c.nextRunAt)
        .sort((a, b) => a.nextRunAt!.getTime() - b.nextRunAt!.getTime())
        .slice(0, 1)
        .map((c) => ({ connectionId: c.id, orgLabel: c.label, at: c.nextRunAt }))[0] ?? null,
      orgs,
      attention,
      recentRuns: recent.map((r) => ({
        id: r.id,
        status: r.status,
        trigger: r.trigger,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
        orgLabel: r.connection.label,
        orgUsername: r.connection.username,
      })),
    });
  }),
);
