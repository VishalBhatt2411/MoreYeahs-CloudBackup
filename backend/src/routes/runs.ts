import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix } from 'node:path';
import archiver from 'archiver';
import { Router } from 'express';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { signToken, verifyToken } from '../lib/crypto.js';
import { HttpError, wrap } from '../lib/http.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getStorage, guardTenantPath, runRelDir } from '../backup/storage.js';
import { CATEGORIES, categoryOfItem, isCategoryId, metadataTypeLabel } from '../backup/categories.js';
import { buildExport, type ExportItem } from '../backup/export/package.js';

export const runsRouter = Router();
export const downloadsRouter = Router();
export const auditRouter = Router();

runsRouter.use(requireAuth);
auditRouter.use(requireAuth);

const runView = (r: {
  id: string; connectionId: string; status: string; trigger: string; createdAt: Date; startedAt: Date | null; finishedAt: Date | null; message: string | null;
  mode?: string; attempts?: number;
}) => ({
  mode: r.mode,
  attempts: r.attempts,
  id: r.id,
  connectionId: r.connectionId,
  status: r.status,
  trigger: r.trigger,
  createdAt: r.createdAt,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  message: r.message,
});

runsRouter.get(
  '/',
  wrap(async (req, res) => {
    const connectionId = typeof req.query.connectionId === 'string' ? req.query.connectionId : undefined;
    const runs = await prisma.backupRun.findMany({
      where: { tenantId: req.user!.tenantId, ...(connectionId ? { connectionId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { connection: { select: { label: true, username: true } } },
    });
    res.json({ runs: runs.map((r) => ({ ...runView(r), orgLabel: r.connection.label, orgUsername: r.connection.username })) });
  }),
);

runsRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const run = await prisma.backupRun.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
      include: { items: { orderBy: [{ kind: 'asc' }, { name: 'asc' }] }, connection: { select: { label: true, username: true } } },
    });
    if (!run) throw new HttpError(404, 'Backup run not found.');
    const s = (n: string) => run.items.filter((i) => i.status === n).length;
    res.json({
      run: {
        ...runView(run),
        orgLabel: run.connection.label,
        orgUsername: run.connection.username,
        summary: {
          total: run.items.length,
          succeeded: s('SUCCEEDED'),
          partial: s('PARTIAL'),
          failed: s('FAILED'),
          pending: s('PENDING') + s('RUNNING'),
          rows: run.items.filter((i) => i.kind === 'OBJECT').reduce((a, i) => a + (i.rowCount ?? 0), 0),
          bytes: run.items.reduce((a, i) => a + (i.bytes ?? 0), 0),
        },
        categories: CATEGORIES.map((c) => ({ id: c.id, kind: c.kind, order: c.order, label: c.label, description: c.description })),
        items: run.items.map((i) => ({
          id: i.id,
          kind: i.kind,
          name: i.name,
          label: i.kind === 'METADATA' ? metadataTypeLabel(i.name) : i.name,
          category: categoryOfItem(i.kind as 'OBJECT' | 'METADATA', i.name),
          status: i.status,
          expectedCount: i.expectedCount,
          rowCount: i.rowCount,
          bytes: i.bytes,
          sha256: i.sha256,
          note: i.note,
          error: i.error,
          mode: i.mode,
          changedCount: i.changedCount,
          deletedCount: i.deletedCount,
          downloadable: !!i.filePath,
        })),
      },
    });
  }),
);

type DownloadToken = {
  t: string;
  r: string;
  i: string | null;
  /** "structured" = the readable Excel/CSV copy. Missing = the raw archive. */
  k?: 'structured';
  f?: 'xlsx' | 'csv';
  c?: string;
  h?: 'label' | 'api';
}

/** Gives a short-lived signed link. The link works without a cookie, for 10 minutes only. */
runsRouter.post(
  '/:id/download-link',
  // An Auditor can inspect but not take copies of the data out.
  requireRole('OWNER', 'ADMIN', 'VIEWER'),
  wrap(async (req, res) => {
    const run = await prisma.backupRun.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
    if (!run) throw new HttpError(404, 'Backup run not found.');
    const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId : undefined;
    if (itemId) {
      const item = await prisma.backupItem.findFirst({ where: { id: itemId, runId: run.id, tenantId: run.tenantId } });
      if (!item || !item.filePath) throw new HttpError(404, 'That item has no saved file.');
    }
    const structured = req.body?.kind === 'structured';
    const payload: DownloadToken = { t: run.tenantId, r: run.id, i: itemId ?? null };
    let what = itemId ?? 'whole run';
    if (structured) {
      if (run.status === 'QUEUED' || run.status === 'RUNNING') throw new HttpError(409, 'This backup is still running. Download it when it has finished.');
      const format = req.body?.format === 'csv' ? 'csv' : 'xlsx';
      const category = typeof req.body?.category === 'string' ? req.body.category : undefined;
      if (category && !isCategoryId(category)) throw new HttpError(400, 'Unknown section.');
      payload.k = 'structured';
      payload.f = format;
      payload.h = req.body?.headers === 'api' ? 'api' : 'label';
      if (category) payload.c = category;
      what = `${what} (${format}${category ? `, ${category}` : ''})`;
    }
    const { token, expiresAt } = signToken({ ...payload }, 600);
    await audit(run.tenantId, req.user!.id, structured ? 'backup.export-link' : 'backup.download-link', run.id, what);
    res.json({ url: `/api/downloads/${token}`, expiresAt });
  }),
);

// Building a workbook reads the whole backup, so only a few run at once.
let activeExports = 0;
const MAX_EXPORTS = 2;

const MIME: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
};

type RunWithOrg = {
  id: string; tenantId: string; connectionId: string; status: string; mode: string; createdAt: Date; finishedAt: Date | null; message: string | null;
  connection: { label: string; username: string };
};

async function sendStructured(res: import('express').Response, run: RunWithOrg, payload: DownloadToken) {
  if (activeExports >= MAX_EXPORTS) throw new HttpError(429, 'Other downloads are being prepared. Try again in a minute.');
  const rows = await prisma.backupItem.findMany({ where: { runId: run.id, tenantId: run.tenantId } });
  const items: ExportItem[] = rows.map((i) => ({
    id: i.id, kind: i.kind, name: i.name, status: i.status, expectedCount: i.expectedCount, rowCount: i.rowCount,
    filePath: i.filePath, note: i.note, error: i.error, mode: i.mode, changedCount: i.changedCount, deletedCount: i.deletedCount,
  }));
  activeExports++;
  const outDir = await mkdtemp(join(tmpdir(), 'cb-export-'));
  let released = false;
  const cleanup = () => {
    if (released) return;
    released = true;
    activeExports--;
    void rm(outDir, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    const result = await buildExport({
      run,
      orgLabel: run.connection.label,
      orgUsername: run.connection.username,
      items,
      format: payload.f ?? 'xlsx',
      headers: payload.h ?? 'label',
      category: payload.c,
      itemId: payload.i ?? undefined,
      outDir,
    });
    if (result.files.length === 0) throw new HttpError(404, 'There is nothing to export for this selection.');
    res.on('close', cleanup);
    if (result.files.length === 1) {
      const name = basename(result.files[0]);
      const abs = join(result.rootDir, result.files[0]);
      const size = (await stat(abs)).size;
      const ext = name.split('.').pop() ?? 'xlsx';
      res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^A-Za-z0-9_. ()-]/g, '_')}"`);
      res.setHeader('Content-Length', String(size));
      createReadStream(abs).pipe(res);
      return;
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${result.rootName.replace(/[^A-Za-z0-9_. -]/g, '_')}.zip"`);
    const zip = archiver('zip', { zlib: { level: 1 } });
    zip.on('error', (e) => {
      console.error('zip error', e.message);
      res.destroy(e);
    });
    zip.pipe(res);
    zip.directory(result.rootDir, payload.c || payload.i ? false : result.rootName);
    await zip.finalize();
  } catch (e) {
    cleanup();
    throw e;
  }
}

downloadsRouter.get(
  '/:token',
  wrap(async (req, res) => {
    const payload = verifyToken<DownloadToken>(req.params.token);
    if (!payload) throw new HttpError(403, 'This download link is invalid or has expired.');
    const run = await prisma.backupRun.findFirst({
      where: { id: payload.r, tenantId: payload.t },
      include: { connection: { select: { label: true, username: true } } },
    });
    if (!run) throw new HttpError(404, 'Backup run not found.');
    if (payload.k === 'structured') {
      await sendStructured(res, run, payload);
      return;
    }

    if (payload.i) {
      const item = await prisma.backupItem.findFirst({ where: { id: payload.i, runId: run.id, tenantId: run.tenantId } });
      if (!item?.filePath) throw new HttpError(404, 'That item has no saved file.');
      const rel = guardTenantPath(run.tenantId, item.filePath);
      const storage = getStorage();
      const size = await storage.fileSize(rel);
      if (size !== null) {
        res.setHeader('Content-Disposition', `attachment; filename="${basename(rel).replace(/[^A-Za-z0-9_.-]/g, '_')}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(size));
        storage.openRead(rel).pipe(res);
        return;
      }
      // A metadata item is a folder of zips: send the folder as one zip.
      await zipFolder(res, rel, `${item.name}.zip`);
      return;
    }
    await zipFolder(res, guardTenantPath(run.tenantId, runRelDir(run.tenantId, run.connectionId, run.id)), `backup-${run.id}.zip`);
  }),
);

async function zipFolder(res: import('express').Response, relDir: string, name: string) {
  const storage = getStorage();
  const files = await storage.listFiles(relDir);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^A-Za-z0-9_.-]/g, '_')}"`);
  const zip = archiver('zip', { zlib: { level: 1 } });
  zip.on('error', (e) => {
    console.error('zip error', e.message);
    res.destroy(e);
  });
  zip.pipe(res);
  for (const f of files) zip.append(storage.openRead(posix.join(relDir, f)), { name: f });
  await zip.finalize();
}

auditRouter.get(
  '/',
  wrap(async (req, res) => {
    const rows = await prisma.auditLog.findMany({
      where: { tenantId: req.user!.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const userIds = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
    const users = await prisma.user.findMany({ where: { id: { in: userIds }, tenantId: req.user!.tenantId }, select: { id: true, email: true } });
    const email = new Map(users.map((u) => [u.id, u.email]));
    res.json({
      entries: rows.map((r) => ({ id: r.id, action: r.action, target: r.target, detail: r.detail, createdAt: r.createdAt, by: r.userId ? email.get(r.userId) ?? 'unknown' : 'system' })),
    });
  }),
);
