import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { BackupItem, ItemStatus, OrgConnection, Prisma, RunStatus } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { getGateway, type SfGateway } from '../salesforce/gateway.js';
import { sendRunAlert } from './alerts.js';
import { classifyObjects, type ExcludedObject } from './coverage.js';
import { exportMetadataType, exportObject, type Baseline, type FileEntry, type ItemResult } from './exporters.js';
import { purgeAllTenants } from './retention.js';
import { getStorage, runRelDir } from './storage.js';

export interface RunOptions {
  includeMetadata: boolean;
  /** Names of objects to copy. Empty / missing = every copyable object. */
  objects?: string[];
  /** True = copy every record again instead of only what changed. */
  fullCopy?: boolean;
}

/** Per organisation: one backup running and one waiting. A third request is refused. */
const MAX_WAITING_PER_ORG = 2;
/** A failing item is tried again this many times (with a growing pause) before it is recorded as failed. */
const ITEM_RETRIES = 2;
const LOCK_KEY = 727002;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function looksLikeLoginProblem(text: string) {
  return /invalid_grant|expired access\/refresh token|refresh token|invalid_session|INVALID_SESSION_ID|inactive user|user is inactive/i.test(text);
}

/**
 * Puts a backup in the queue and returns at once. A worker picks it up (this process or a
 * separate one, see WORKER_MODE). An org has at most one run going and one waiting.
 */
export async function startRun(args: {
  connection: OrgConnection;
  userId: string | null;
  trigger: 'manual' | 'schedule';
  options?: Partial<RunOptions>;
}) {
  const { connection } = args;
  if (connection.status !== 'ACTIVE') {
    throw new HttpError(409, 'This org needs to be reconnected before it can be backed up.', 'needs_reconnect');
  }
  const waiting = await prisma.backupRun.count({ where: { connectionId: connection.id, status: { in: ['QUEUED', 'RUNNING'] } } });
  if (waiting >= MAX_WAITING_PER_ORG) {
    throw new HttpError(409, 'This org already has a backup running and another waiting. Please wait for them to finish.', 'run_queue_full');
  }

  const options: RunOptions = {
    includeMetadata: args.options?.includeMetadata ?? true,
    objects: args.options?.objects?.length ? args.options.objects : undefined,
    fullCopy: args.options?.fullCopy ? true : undefined,
  };
  const run = await prisma.backupRun.create({
    data: {
      tenantId: connection.tenantId,
      connectionId: connection.id,
      trigger: args.trigger,
      startedById: args.userId,
      options: options as never,
      mode: options.fullCopy ? 'FULL' : 'INCREMENTAL',
      maxAttempts: config.maxRunAttempts,
    },
  });
  const behind = waiting > 0 ? ' (queued behind a running backup)' : '';
  await audit(connection.tenantId, args.userId, 'backup.start', run.id, `${connection.label} (${args.trigger}${options.fullCopy ? ', full copy' : ''})${behind}`);
  kickWorker();
  return run;
}

/** Resolves when a given run has finished. Used by tests. */
export async function waitForRun(runId: string, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await prisma.backupRun.findUnique({ where: { id: runId } });
    if (r && r.status !== 'QUEUED' && r.status !== 'RUNNING') return r;
    if (Date.now() > end) throw new Error('Timed out waiting for run');
    await sleep(100);
  }
}

// ---------------------------------------------------------------------------------------------
// Queue: claiming work
// ---------------------------------------------------------------------------------------------

type ClaimedRun = Prisma.BackupRunGetPayload<{ include: { connection: true } }>;

/**
 * Takes the oldest waiting run that may start. Under one database lock, so two workers can never
 * take the same run, and never two runs of one org. First it deals with runs whose worker has
 * vanished (their lease ran out): they go back in the queue to be resumed, or fail for good
 * once they have used all their attempts.
 */
export async function claimNextRun(workerId: string): Promise<ClaimedRun | null> {
  const gaveUp: string[] = [];
  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    const now = new Date();

    const stale = await tx.backupRun.findMany({
      where: { status: 'RUNNING', OR: [{ leaseUntil: { lt: now } }, { leaseUntil: null }] },
    });
    for (const s of stale) {
      if (s.attempts >= s.maxAttempts) {
        await tx.backupRun.update({
          where: { id: s.id },
          data: {
            status: 'FAILED',
            finishedAt: now,
            leaseUntil: null,
            workerId: null,
            message: `The backup was interrupted ${s.attempts} times (the server stopped or restarted) and was given up. Start a new backup.`,
          },
        });
        await tx.backupItem.updateMany({
          where: { runId: s.id, status: { in: ['PENDING', 'RUNNING'] } },
          data: { status: 'FAILED', error: 'Stopped before this item finished.', finishedAt: now },
        });
        gaveUp.push(s.id);
      } else {
        await tx.backupRun.update({
          where: { id: s.id },
          data: { status: 'QUEUED', leaseUntil: null, workerId: null, nextAttemptAt: null, message: 'Interrupted; waiting to continue where it stopped.' },
        });
        await tx.backupItem.updateMany({ where: { runId: s.id, status: 'RUNNING' }, data: { status: 'PENDING' } });
      }
    }

    const busy = await tx.backupRun.findMany({ where: { status: 'RUNNING' }, select: { connectionId: true } });
    const next = await tx.backupRun.findFirst({
      where: {
        status: 'QUEUED',
        connectionId: { notIn: busy.map((b) => b.connectionId) },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!next) return null;
    return tx.backupRun.update({
      where: { id: next.id },
      data: {
        status: 'RUNNING',
        attempts: { increment: 1 },
        startedAt: next.startedAt ?? now,
        leaseUntil: new Date(now.getTime() + config.leaseSeconds * 1000),
        workerId,
        nextAttemptAt: null,
      },
      include: { connection: true },
    });
  });
  for (const id of gaveUp) {
    void sendRunAlert(id);
    void audit(null, null, 'backup.abandoned', id, 'Interrupted too many times').catch(() => {});
  }
  return claimed;
}

// ---------------------------------------------------------------------------------------------
// Worker: runs claimed backups
// ---------------------------------------------------------------------------------------------

const workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
/** In tests the API process works the queue itself; otherwise only a process that called startWorker() does. */
let workerActive = config.isTest;
let ticking = false;
let again = false;
let running = 0;

/** Wakes the worker if this process has one. With a separate worker process this does nothing; that process polls. */
export function kickWorker() {
  if (workerActive) void workerTick();
}

/** Starts as many waiting backups as this worker has room for. Safe to call at any time. */
export async function workerTick() {
  if (ticking) {
    again = true;
    return;
  }
  ticking = true;
  try {
    do {
      again = false;
      while (running < config.workerConcurrency) {
        let claimed: ClaimedRun | null;
        try {
          claimed = await claimNextRun(workerId);
        } catch (e) {
          console.error('Worker could not read the queue:', msg(e));
          break;
        }
        if (!claimed) break;
        running++;
        void processRun(claimed)
          .catch((e) => console.error('Backup run crashed:', msg(e)))
          .finally(() => {
            running--;
            void workerTick();
          });
      }
    } while (again);
  } finally {
    ticking = false;
  }
}

/** Starts the worker loop in this process (checks the queue every 2 seconds, and whenever a backup is queued). */
export function startWorker() {
  workerActive = true;
  const timer = setInterval(() => void workerTick(), 2000);
  timer.unref();
  void workerTick();
  return () => {
    clearInterval(timer);
    workerActive = false;
  };
}

/** Tests: run the queue once. */
export const runWorkerOnce = workerTick;

async function finishRun(runId: string, status: RunStatus, message: string, owner?: string): Promise<boolean> {
  const r = await prisma.backupRun.updateMany({
    where: { id: runId, status: 'RUNNING', ...(owner ? { workerId: owner } : {}) },
    data: { status, message, finishedAt: new Date(), leaseUntil: null },
  });
  // Failed runs email the company (if mail is set up). Runs in the background and never throws.
  if (r.count > 0 && status === 'FAILED') void sendRunAlert(runId);
  return r.count > 0;
}

async function processRun(run: ClaimedRun) {
  let lost = false;
  const beat = setInterval(() => {
    prisma.backupRun
      .updateMany({
        where: { id: run.id, status: 'RUNNING', workerId },
        data: { leaseUntil: new Date(Date.now() + config.leaseSeconds * 1000) },
      })
      .then((r) => {
        if (r.count === 0) lost = true; // someone else took the run over; stop touching it
      })
      .catch(() => {});
  }, config.heartbeatSeconds * 1000);
  try {
    await executeRun(run, run.connection, () => lost);
  } catch (e) {
    console.error('Backup run crashed:', msg(e));
    await finishRun(run.id, 'FAILED', `The backup stopped unexpectedly: ${msg(e).slice(0, 300)}`, workerId).catch(() => {});
  } finally {
    clearInterval(beat);
  }
}

async function buildPlan(gw: SfGateway, options: RunOptions) {
  const excluded: ExcludedObject[] = [];
  const planned: { kind: 'METADATA' | 'OBJECT'; name: string; inFolder?: boolean }[] = [];

  if (options.includeMetadata) {
    const types = await gw.describeMetadataTypes();
    for (const t of types.sort((a, b) => a.xmlName.localeCompare(b.xmlName))) {
      planned.push({ kind: 'METADATA', name: t.xmlName, inFolder: t.inFolder });
    }
  }
  const all = await gw.describeGlobal();
  const { included, excluded: ex } = classifyObjects(all);
  excluded.push(...ex);
  const wanted = options.objects?.length ? new Set(options.objects) : null;
  for (const o of included) {
    if (!wanted || wanted.has(o.name)) planned.push({ kind: 'OBJECT', name: o.name });
  }
  if (wanted) {
    const known = new Set(all.map((o) => o.name));
    for (const n of wanted) {
      if (!included.some((o) => o.name === n)) {
        excluded.push({ name: n, label: n, reason: known.has(n) ? 'Not copied (excluded - see the coverage list).' : 'This object does not exist in the org.' });
      }
    }
  }
  return { planned, excluded };
}

/** The run goes back in the queue to try again later (Salesforce could not be reached). */
async function requeueLater(run: ClaimedRun, message: string) {
  await prisma.backupRun.updateMany({
    where: { id: run.id, status: 'RUNNING', workerId },
    data: {
      status: 'QUEUED',
      leaseUntil: null,
      workerId: null,
      message,
      nextAttemptAt: new Date(Date.now() + config.retryDelayMs * run.attempts),
    },
  });
}

async function executeRun(run: ClaimedRun, connection: OrgConnection, lost: () => boolean) {
  const runId = run.id;
  const options = (run.options ?? { includeMetadata: true }) as unknown as RunOptions;
  const wantIncremental = run.mode === 'INCREMENTAL';

  if (connection.status !== 'ACTIVE') {
    await finishRun(runId, 'FAILED', 'This org needs to be reconnected before it can be backed up.', workerId);
    return;
  }

  let gw: SfGateway;
  try {
    gw = await getGateway(connection);
  } catch (e) {
    const text = msg(e);
    if (looksLikeLoginProblem(text)) {
      await prisma.orgConnection.update({
        where: { id: connection.id },
        data: { status: 'NEEDS_RECONNECT', lastError: 'Salesforce no longer accepts the saved login. Please reconnect.' },
      });
      await finishRun(runId, 'FAILED', 'Salesforce no longer accepts the saved login. Please reconnect this org.', workerId);
    } else if (run.attempts < run.maxAttempts) {
      await requeueLater(run, `Could not connect to Salesforce (attempt ${run.attempts} of ${run.maxAttempts}); trying again shortly. ${text.slice(0, 200)}`);
    } else {
      await finishRun(runId, 'FAILED', `Could not connect to Salesforce: ${text}`, workerId);
    }
    return;
  }

  // ---- Plan: figure out exactly what will be copied, and what will not (with reasons). ----
  const { planned, excluded } = await buildPlan(gw, options);

  let items = await prisma.backupItem.findMany({ where: { runId } });
  if (items.length === 0) {
    if (planned.length === 0) {
      await finishRun(runId, 'FAILED', 'Nothing to copy: no metadata types or objects were selected.', workerId);
      return;
    }
    await prisma.backupItem.createMany({
      data: planned.map((p) => ({ runId, tenantId: connection.tenantId, kind: p.kind, name: p.name })),
    });
    items = await prisma.backupItem.findMany({ where: { runId } });
  }
  // Keep the plan's order (metadata first, then objects), also when resuming.
  const order = new Map(planned.map((p, i) => [`${p.kind}:${p.name}`, i]));
  const inFolder = new Map(planned.filter((p) => p.kind === 'METADATA').map((p) => [p.name, !!p.inFolder]));
  items.sort((a, b) => (order.get(`${a.kind}:${a.name}`) ?? 1e9) - (order.get(`${b.kind}:${b.name}`) ?? 1e9));

  const rel = runRelDir(connection.tenantId, connection.id, runId);
  const checkpoints = wantIncremental ? await prisma.objectCheckpoint.findMany({ where: { connectionId: connection.id } }) : [];
  const baselines = new Map<string, Baseline>(
    checkpoints.map((c) => [c.objectName, { watermark: c.watermark, lastFilePath: c.lastFilePath, lastFullAt: c.lastFullAt, needsFull: c.needsFull }]),
  );

  // ---- Copy each item that is not done yet, recording an honest result for each. ----
  for (const item of items) {
    if (item.status !== 'PENDING' && item.status !== 'RUNNING') continue; // finished before a restart
    if (lost()) return; // another worker owns this run now
    await prisma.backupItem.update({ where: { id: item.id }, data: { status: 'RUNNING' } });

    let result: ItemResult = { status: 'FAILED', files: [], error: 'Not attempted.' };
    for (let attempt = 0; attempt <= ITEM_RETRIES; attempt++) {
      try {
        result =
          item.kind === 'OBJECT'
            ? await exportObject(gw, item.name, { relDir: rel, wantIncremental, baseline: baselines.get(item.name) ?? null })
            : await exportMetadataType(gw, item.name, inFolder.get(item.name) ?? false, rel);
        break;
      } catch (e) {
        result = { status: 'FAILED', files: [], error: msg(e).slice(0, 1000) };
        if (attempt < ITEM_RETRIES) await sleep(config.retryDelayMs * (attempt + 1));
      }
    }

    const done = await prisma.backupItem.update({
      where: { id: item.id },
      data: {
        status: result.status as ItemStatus,
        expectedCount: result.expectedCount ?? null,
        rowCount: result.rowCount ?? null,
        bytes: result.bytes ?? null,
        sha256: result.sha256 ?? null,
        filePath: result.filePath ?? null,
        note: result.note ?? null,
        error: result.error ?? null,
        files: result.files as never,
        mode: result.mode ?? null,
        changedCount: result.changedCount ?? null,
        deletedCount: result.deletedCount ?? null,
        finishedAt: new Date(),
      },
    });
    // Only a copy that was fully verified becomes the starting point of the next incremental copy.
    if (item.kind === 'OBJECT' && result.status === 'SUCCEEDED' && result.watermark && result.filePath) {
      const now = new Date();
      await prisma.objectCheckpoint.upsert({
        where: { connectionId_objectName: { connectionId: connection.id, objectName: item.name } },
        create: {
          tenantId: connection.tenantId,
          connectionId: connection.id,
          objectName: item.name,
          watermark: result.watermark,
          lastFilePath: result.filePath,
          lastItemId: done.id,
          lastFullAt: now,
        },
        update: {
          watermark: result.watermark,
          lastFilePath: result.filePath,
          lastItemId: done.id,
          needsFull: false,
          ...(result.mode === 'FULL' ? { lastFullAt: now } : {}),
        },
      });
    }
  }
  if (lost()) return;

  // ---- Overall status: SUCCEEDED only if every single item finished and verified. ----
  const all = await prisma.backupItem.findMany({ where: { runId } });
  const failed = all.filter((i) => i.status === 'FAILED').length;
  const partial = all.filter((i) => i.status === 'PARTIAL').length;
  const okCount = all.length - failed - partial;
  let status: RunStatus;
  let message: string;
  if (failed === 0 && partial === 0) {
    status = 'SUCCEEDED';
    message = `All ${all.length} items were copied and verified.`;
  } else if (okCount === 0 && partial === 0) {
    status = 'FAILED';
    message = `Nothing could be copied (${failed} items failed).`;
  } else {
    status = 'PARTIAL';
    message = `${okCount} items copied and verified, ${partial} incomplete, ${failed} failed.`;
  }
  const inc = all.filter((i) => i.mode === 'INCREMENTAL');
  if (inc.length) {
    const changed = inc.reduce((s, i) => s + (i.changedCount ?? 0), 0);
    const deleted = inc.reduce((s, i) => s + (i.deletedCount ?? 0), 0);
    message += ` ${inc.length} objects were updated incrementally (${changed} records new or changed, ${deleted} deleted).`;
  }
  if (excluded.length) message += ` ${excluded.length} objects were not copied (reasons are listed in the run details).`;

  const manifest = {
    product: 'MoreYeahs CloudBackup',
    runId,
    org: { id: connection.sfOrgId, name: connection.orgName, username: connection.username, environment: connection.environment },
    apiVersion: gw.apiVersion,
    options,
    mode: run.mode,
    status,
    message,
    finishedAt: new Date().toISOString(),
    items: all.map((item: BackupItem) => ({
      kind: item.kind,
      name: item.name,
      status: item.status,
      mode: item.mode,
      expectedCount: item.expectedCount,
      rowCount: item.rowCount,
      changedCount: item.changedCount,
      deletedCount: item.deletedCount,
      sha256: item.sha256,
      files: (item.files ?? []) as unknown as FileEntry[],
      note: item.note,
      error: item.error,
    })),
    notCopied: excluded,
    limits: [
      'File and attachment contents (ContentVersion data, Attachment bodies) are not part of this backup version.',
      'Binary (base64) fields and compound address/location fields are skipped; their component fields are saved.',
      'Installed managed-package metadata cannot be retrieved by Salesforce and is skipped.',
    ],
  };
  await getStorage().writeFile(join(rel, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (await finishRun(runId, status, message, workerId)) {
    await audit(connection.tenantId, null, 'backup.finish', runId, `${status}: ${message}`);
  }
}

/** Checks every minute for orgs whose scheduled backup is due, and once an hour applies each company's retention. */
export function startScheduler() {
  let lastPurge = 0;
  const tick = async () => {
    // Once an hour, delete backups older than each company's retention period.
    if (Date.now() - lastPurge > 3600_000) {
      lastPurge = Date.now();
      try {
        await purgeAllTenants();
      } catch (e) {
        console.error('Retention clean-up error:', msg(e));
      }
    }
    try {
      const due = await prisma.orgConnection.findMany({
        where: { status: 'ACTIVE', scheduleHours: { not: null }, nextRunAt: { lte: new Date() } },
      });
      for (const c of due) {
        // Still busy with the last one (running or waiting)? Do not pile up another; look again next minute.
        const busy = await prisma.backupRun.count({ where: { connectionId: c.id, status: { in: ['QUEUED', 'RUNNING'] } } });
        if (busy > 0) continue;
        const next = new Date(Date.now() + (c.scheduleHours ?? 24) * 3600 * 1000);
        await prisma.orgConnection.update({ where: { id: c.id }, data: { nextRunAt: next } });
        try {
          await startRun({ connection: c, userId: null, trigger: 'schedule' });
        } catch (e) {
          console.warn(`Scheduled backup skipped for ${c.id}: ${msg(e)}`);
        }
      }
    } catch (e) {
      console.error('Scheduler error:', msg(e));
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
