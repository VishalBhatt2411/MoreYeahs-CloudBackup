import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { HttpError, wrap } from '../lib/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { gzLines } from '../backup/snapshot.js';
import { guardTenantPath } from '../backup/storage.js';

/**
 * Data Explorer: look inside a saved backup without downloading it.
 * Everything is read-only and scoped to the signed-in customer's own runs.
 */
export const explorerRouter = Router();
explorerRouter.use(requireAuth);

const MAX_LIMIT = 200;

async function findRun(tenantId: string, runId: string) {
  const run = await prisma.backupRun.findFirst({ where: { id: runId, tenantId } });
  if (!run) throw new HttpError(404, 'Backup run not found.');
  return run;
}

async function findObjectItem(tenantId: string, runId: string, name: string) {
  const item = await prisma.backupItem.findFirst({
    where: { tenantId, runId, kind: 'OBJECT', name, status: { in: ['SUCCEEDED', 'PARTIAL'] } },
  });
  if (!item || !item.filePath) throw new HttpError(404, 'That object was not saved in this backup.');
  return { item, rel: guardTenantPath(tenantId, item.filePath) };
}

const cell = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function matches(row: Record<string, unknown>, q: string, field?: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (field) return cell(row[field]).toLowerCase().includes(needle);
  for (const v of Object.values(row)) if (cell(v).toLowerCase().includes(needle)) return true;
  return false;
}

function parseRow(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Backups that can be opened, newest first. */
explorerRouter.get(
  '/snapshots',
  wrap(async (req, res) => {
    const connectionId = typeof req.query.connectionId === 'string' ? req.query.connectionId : undefined;
    const runs = await prisma.backupRun.findMany({
      where: { tenantId: req.user!.tenantId, status: { in: ['SUCCEEDED', 'PARTIAL'] }, ...(connectionId ? { connectionId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { connection: { select: { label: true } } },
    });
    res.json({
      snapshots: runs.map((r) => ({
        id: r.id,
        connectionId: r.connectionId,
        orgLabel: r.connection.label,
        status: r.status,
        mode: r.mode,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
      })),
    });
  }),
);

explorerRouter.get(
  '/runs/:runId/objects',
  wrap(async (req, res) => {
    const run = await findRun(req.user!.tenantId, req.params.runId);
    const items = await prisma.backupItem.findMany({
      where: { runId: run.id, tenantId: run.tenantId, kind: 'OBJECT', status: { in: ['SUCCEEDED', 'PARTIAL'] }, filePath: { not: null } },
      orderBy: { name: 'asc' },
    });
    res.json({
      objects: items.map((i) => ({ name: i.name, status: i.status, rowCount: i.rowCount, bytes: i.bytes, mode: i.mode })),
    });
  }),
);

const pageQuery = z.object({
  offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  q: z.string().max(200).default(''),
  field: z
    .string()
    .regex(/^[A-Za-z0-9_.]+$/)
    .optional(),
});

/** One page of records. With a search term it scans the file and stops as soon as the page is full. */
explorerRouter.get(
  '/runs/:runId/objects/:name/records',
  wrap(async (req, res) => {
    const { offset, limit, q, field } = pageQuery.parse(req.query);
    const run = await findRun(req.user!.tenantId, req.params.runId);
    const { item, rel } = await findObjectItem(run.tenantId, run.id, req.params.name);

    const records: Record<string, unknown>[] = [];
    let columns: string[] = [];
    let seen = 0; // rows that matched so far
    let hasMore = false;
    for await (const line of gzLines(rel)) {
      const row = parseRow(line);
      if (!row) continue;
      if (!columns.length) columns = Object.keys(row);
      if (!matches(row, q, field)) continue;
      if (seen >= offset + limit) {
        hasMore = true;
        break;
      }
      if (seen >= offset) records.push(row);
      seen++;
    }
    res.json({
      object: item.name,
      columns,
      records,
      offset,
      limit,
      hasMore,
      // The full count is only known when nothing is filtered out.
      total: q ? null : item.rowCount,
    });
  }),
);

/** CSV of the matching rows. Not for Auditors (they may look, but not take data out). */
explorerRouter.get(
  '/runs/:runId/objects/:name/export.csv',
  requireRole('OWNER', 'ADMIN', 'VIEWER'),
  wrap(async (req, res) => {
    const q = z.string().max(200).default('').parse(req.query.q ?? '');
    const run = await findRun(req.user!.tenantId, req.params.runId);
    const { item, rel } = await findObjectItem(run.tenantId, run.id, req.params.name);

    // Spreadsheet programs run text starting with = + - @ as a formula; prefix those.
    const esc = (v: unknown) => {
      let s = cell(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${item.name.replace(/[^A-Za-z0-9_.-]/g, '_')}.csv"`);
    let columns: string[] | null = null;
    let n = 0;
    for await (const line of gzLines(rel)) {
      const row = parseRow(line);
      if (!row) continue;
      if (!columns) {
        columns = Object.keys(row);
        res.write(columns.map(esc).join(',') + '\r\n');
      }
      if (!matches(row, q)) continue;
      if (!res.write(columns.map((c) => esc(row[c])).join(',') + '\r\n')) {
        await new Promise((r) => res.once('drain', r));
      }
      n++;
    }
    res.end();
    await audit(run.tenantId, req.user!.id, 'explorer.export', `${run.id}/${item.name}`, `${n} rows${q ? ` matching "${q}"` : ''}`);
  }),
);
