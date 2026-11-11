import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import archiver from 'archiver';
import { Router } from 'express';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { signToken, verifyToken } from '../lib/crypto.js';
import { HttpError, wrap } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { runRelDir, safeAbsPath } from '../backup/storage.js';

export const runsRouter = Router();
export const downloadsRouter = Router();
export const auditRouter = Router();

runsRouter.use(requireAuth);
auditRouter.use(requireAuth);

const runView = (r: {
  id: string; connectionId: string; status: string; trigger: string; createdAt: Date; startedAt: Date | null; finishedAt: Date | null; message: string | null;
}) => ({
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
        items: run.items.map((i) => ({
          id: i.id,
          kind: i.kind,
          name: i.name,
          status: i.status,
          expectedCount: i.expectedCount,
          rowCount: i.rowCount,
          bytes: i.bytes,
          sha256: i.sha256,
          note: i.note,
          error: i.error,
          downloadable: !!i.filePath,
        })),
      },
    });
  }),
);

/** Gives a short-lived signed link. The link works without a cookie, for 10 minutes only. */
runsRouter.post(
  '/:id/download-link',
  wrap(async (req, res) => {
    const run = await prisma.backupRun.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
    if (!run) throw new HttpError(404, 'Backup run not found.');
    const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId : undefined;
    if (itemId) {
      const item = await prisma.backupItem.findFirst({ where: { id: itemId, runId: run.id, tenantId: run.tenantId } });
      if (!item || !item.filePath) throw new HttpError(404, 'That item has no saved file.');
    }
    const { token, expiresAt } = signToken({ t: run.tenantId, r: run.id, i: itemId ?? null }, 600);
    await audit(run.tenantId, req.user!.id, 'backup.download-link', run.id, itemId ?? 'whole run');
    res.json({ url: `/api/downloads/${token}`, expiresAt });
  }),
);

downloadsRouter.get(
  '/:token',
  wrap(async (req, res) => {
    const payload = verifyToken<{ t: string; r: string; i: string | null }>(req.params.token);
    if (!payload) throw new HttpError(403, 'This download link is invalid or has expired.');
    const run = await prisma.backupRun.findFirst({ where: { id: payload.r, tenantId: payload.t } });
    if (!run) throw new HttpError(404, 'Backup run not found.');

    if (payload.i) {
      const item = await prisma.backupItem.findFirst({ where: { id: payload.i, runId: run.id, tenantId: run.tenantId } });
      if (!item?.filePath) throw new HttpError(404, 'That item has no saved file.');
      const abs = safeAbsPath(run.tenantId, item.filePath);
      const info = await stat(abs).catch(() => null);
      if (info?.isFile()) {
        res.setHeader('Content-Disposition', `attachment; filename="${basename(abs)}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        createReadStream(abs).pipe(res);
        return;
      }
      // A metadata item is a folder of zips: send the folder as one zip.
      zipFolder(res, safeAbsPath(run.tenantId, item.filePath), `${item.name}.zip`);
      return;
    }
    zipFolder(res, safeAbsPath(run.tenantId, runRelDir(run.tenantId, run.connectionId, run.id)), `backup-${run.id}.zip`);
  }),
);

function zipFolder(res: import('express').Response, absDir: string, name: string) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^A-Za-z0-9_.-]/g, '_')}"`);
  const zip = archiver('zip', { zlib: { level: 1 } });
  zip.on('error', (e) => {
    console.error('zip error', e.message);
    res.destroy(e);
  });
  zip.pipe(res);
  zip.directory(absDir, false);
  void zip.finalize();
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
