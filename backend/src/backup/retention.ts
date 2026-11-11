import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { getStorage, guardTenantPath, runRelDir } from './storage.js';

const DAY = 24 * 3600 * 1000;

/**
 * Backups that are older than `days` and finished. Two safety rules:
 * - a backup that is still running is never touched;
 * - the newest good backup (Succeeded, else Partial) of each org is always kept, so an org is
 *   never left with no backup at all just because it has not run for a while.
 */
export async function findExpiredRuns(tenantId: string, days: number) {
  const cutoff = new Date(Date.now() - days * DAY);
  const candidates = await prisma.backupRun.findMany({
    where: { tenantId, finishedAt: { lt: cutoff }, status: { in: ['SUCCEEDED', 'PARTIAL', 'FAILED'] } },
    select: { id: true, connectionId: true, status: true, finishedAt: true },
  });
  if (candidates.length === 0) return [];
  const keep = new Set<string>();
  for (const connectionId of new Set(candidates.map((c) => c.connectionId))) {
    for (const status of ['SUCCEEDED', 'PARTIAL'] as const) {
      const newest = await prisma.backupRun.findFirst({
        where: { tenantId, connectionId, status },
        orderBy: { finishedAt: 'desc' },
        select: { id: true },
      });
      if (newest) {
        keep.add(newest.id);
        break;
      }
    }
  }
  return candidates.filter((c) => !keep.has(c.id));
}

export async function previewRetention(tenantId: string, days: number) {
  // A legal hold freezes deletion: nothing would be removed while it is on.
  const hold = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { legalHold: true } });
  if (hold?.legalHold) return { runs: 0, bytes: 0, legalHold: true };
  const runs = await findExpiredRuns(tenantId, days);
  const sum = runs.length
    ? await prisma.backupItem.aggregate({ where: { tenantId, runId: { in: runs.map((r) => r.id) } }, _sum: { bytes: true } })
    : null;
  return { runs: runs.length, bytes: sum?._sum.bytes ?? 0, legalHold: false };
}

/** Deletes the expired backups' files and records. Returns how many backups were removed. */
export async function purgeTenant(tenantId: string, days: number): Promise<number> {
  // Re-checked here (not only in the caller) so no code path can delete under a legal hold.
  const hold = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { legalHold: true } });
  if (!hold || hold.legalHold) return 0;
  const runs = await findExpiredRuns(tenantId, days);
  let removed = 0;
  for (const run of runs) {
    try {
      await getStorage().removeTree(guardTenantPath(tenantId, runRelDir(tenantId, run.connectionId, run.id)));
      await prisma.backupRun.delete({ where: { id: run.id } });
      removed++;
    } catch (e) {
      // Keep the record if the files could not be removed, so nothing is half-deleted silently.
      console.warn(`Retention: could not remove backup ${run.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (removed > 0) await audit(tenantId, null, 'retention.purged', `${removed} backup(s)`, `older than ${days} days`);
  return removed;
}

/** Runs the clean-up for every company that has a retention period set. */
export async function purgeAllTenants(): Promise<number> {
  const tenants = await prisma.tenant.findMany({ where: { retentionDays: { not: null } }, select: { id: true, retentionDays: true } });
  let total = 0;
  for (const t of tenants) total += await purgeTenant(t.id, t.retentionDays!);
  return total;
}
