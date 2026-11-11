import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupItem, ItemStatus, OrgConnection, RunStatus } from '@prisma/client';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { getGateway, type SfGateway } from '../salesforce/gateway.js';
import { classifyObjects, type ExcludedObject } from './coverage.js';
import { exportMetadataType, exportObject, type ItemResult } from './exporters.js';
import { absPath, ensureDir, runRelDir } from './storage.js';

export interface RunOptions {
  includeMetadata: boolean;
  /** Names of objects to copy. Empty / missing = every copyable object. */
  objects?: string[];
}

const active = new Set<string>(); // connection ids that have a run in progress in this process

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function looksLikeLoginProblem(text: string) {
  return /invalid_grant|expired access\/refresh token|refresh token|invalid_session|INVALID_SESSION_ID|inactive user|user is inactive/i.test(text);
}

/** Creates a run and starts it in the background. Throws if the org already has a run going. */
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
  const busy = active.has(connection.id)
    ? true
    : (await prisma.backupRun.count({ where: { connectionId: connection.id, status: { in: ['QUEUED', 'RUNNING'] } } })) > 0;
  if (busy) throw new HttpError(409, 'A backup is already running for this org. Please wait for it to finish.', 'run_in_progress');

  const options: RunOptions = {
    includeMetadata: args.options?.includeMetadata ?? true,
    objects: args.options?.objects?.length ? args.options.objects : undefined,
  };
  const run = await prisma.backupRun.create({
    data: {
      tenantId: connection.tenantId,
      connectionId: connection.id,
      trigger: args.trigger,
      startedById: args.userId,
      options: options as never,
    },
  });
  active.add(connection.id);
  await audit(connection.tenantId, args.userId, 'backup.start', run.id, `${connection.label} (${args.trigger})`);
  // Run in the background; the HTTP request returns straight away.
  void executeRun(run.id, connection).finally(() => active.delete(connection.id));
  return run;
}

/** Resolves when a given run has finished. Used by tests. */
export async function waitForRun(runId: string, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await prisma.backupRun.findUnique({ where: { id: runId } });
    if (r && r.status !== 'QUEUED' && r.status !== 'RUNNING') return r;
    if (Date.now() > end) throw new Error('Timed out waiting for run');
    await new Promise((res) => setTimeout(res, 100));
  }
}

async function finishRun(runId: string, status: RunStatus, message: string) {
  await prisma.backupRun.update({ where: { id: runId }, data: { status, message, finishedAt: new Date() } });
}

async function executeRun(runId: string, connection: OrgConnection) {
  try {
    await prisma.backupRun.update({ where: { id: runId }, data: { status: 'RUNNING', startedAt: new Date() } });
    const run = await prisma.backupRun.findUniqueOrThrow({ where: { id: runId } });
    const options = (run.options ?? { includeMetadata: true }) as unknown as RunOptions;

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
        await finishRun(runId, 'FAILED', 'Salesforce no longer accepts the saved login. Please reconnect this org.');
      } else {
        await finishRun(runId, 'FAILED', `Could not connect to Salesforce: ${text}`);
      }
      return;
    }

    // ---- Plan: figure out exactly what will be copied, and what will not (with reasons). ----
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

    if (planned.length === 0) {
      await finishRun(runId, 'FAILED', 'Nothing to copy: no metadata types or objects were selected.');
      return;
    }

    await prisma.backupItem.createMany({
      data: planned.map((p) => ({ runId, tenantId: connection.tenantId, kind: p.kind, name: p.name })),
    });
    const items = await prisma.backupItem.findMany({ where: { runId } });
    const byKey = new Map(items.map((i) => [`${i.kind}:${i.name}`, i]));
    const rel = runRelDir(connection.tenantId, connection.id, runId);
    await ensureDir(rel);

    // ---- Copy each item, one at a time, recording an honest result for each. ----
    const results: { item: BackupItem; result: ItemResult }[] = [];
    for (const p of planned) {
      const item = byKey.get(`${p.kind}:${p.name}`)!;
      await prisma.backupItem.update({ where: { id: item.id }, data: { status: 'RUNNING' } });
      let result: ItemResult;
      try {
        result =
          p.kind === 'OBJECT'
            ? await exportObject(gw, p.name, rel)
            : await exportMetadataType(gw, p.name, !!p.inFolder, rel);
      } catch (e) {
        result = { status: 'FAILED', files: [], error: msg(e).slice(0, 1000) };
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
          finishedAt: new Date(),
        },
      });
      results.push({ item: done, result });
    }

    // ---- Overall status: SUCCEEDED only if every single item finished and verified. ----
    const failed = results.filter((r) => r.result.status === 'FAILED').length;
    const partial = results.filter((r) => r.result.status === 'PARTIAL').length;
    const okCount = results.length - failed - partial;
    let status: RunStatus;
    let message: string;
    if (failed === 0 && partial === 0) {
      status = 'SUCCEEDED';
      message = `All ${results.length} items were copied and verified.`;
    } else if (okCount === 0 && partial === 0) {
      status = 'FAILED';
      message = `Nothing could be copied (${failed} items failed).`;
    } else {
      status = 'PARTIAL';
      message = `${okCount} items copied and verified, ${partial} incomplete, ${failed} failed.`;
    }
    if (excluded.length) message += ` ${excluded.length} objects were not copied (reasons are listed in the run details).`;

    const finishedAt = new Date();
    const manifest = {
      product: 'MoreYeahs CloudBackup',
      runId,
      org: { id: connection.sfOrgId, name: connection.orgName, username: connection.username, environment: connection.environment },
      apiVersion: gw.apiVersion,
      options,
      status,
      message,
      finishedAt: finishedAt.toISOString(),
      items: results.map(({ item, result }) => ({
        kind: item.kind,
        name: item.name,
        status: result.status,
        expectedCount: result.expectedCount ?? null,
        rowCount: result.rowCount ?? null,
        sha256: result.sha256 ?? null,
        files: result.files,
        note: result.note ?? null,
        error: result.error ?? null,
      })),
      notCopied: excluded,
      limits: [
        'File and attachment contents (ContentVersion data, Attachment bodies) are not part of this backup version.',
        'Binary (base64) fields and compound address/location fields are skipped; their component fields are saved.',
        'Installed managed-package metadata cannot be retrieved by Salesforce and is skipped.',
      ],
    };
    await writeFile(join(absPath(rel), 'manifest.json'), JSON.stringify(manifest, null, 2));
    await finishRun(runId, status, message);
    await audit(connection.tenantId, null, 'backup.finish', runId, `${status}: ${message}`);
  } catch (e) {
    console.error('Backup run crashed:', msg(e));
    try {
      await finishRun(runId, 'FAILED', `The backup stopped unexpectedly: ${msg(e).slice(0, 300)}`);
    } catch {
      /* nothing more we can do */
    }
  }
}

/** On server start, any run still marked as running was cut off by a restart. Mark it honestly. */
export async function recoverStaleRuns() {
  const r = await prisma.backupRun.updateMany({
    where: { status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'FAILED', finishedAt: new Date(), message: 'The server restarted while this backup was running, so it was stopped. Start a new backup.' },
  });
  await prisma.backupItem.updateMany({
    where: { status: { in: ['PENDING', 'RUNNING'] }, run: { status: 'FAILED' } },
    data: { status: 'FAILED', error: 'Stopped before this item finished.', finishedAt: new Date() },
  });
  return r.count;
}

/** Checks every minute for orgs whose scheduled backup is due. */
export function startScheduler() {
  const tick = async () => {
    try {
      const due = await prisma.orgConnection.findMany({
        where: { status: 'ACTIVE', scheduleHours: { not: null }, nextRunAt: { lte: new Date() } },
      });
      for (const c of due) {
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
