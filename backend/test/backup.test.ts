import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, makeConnection, resetDb, signUp } from './helpers.js';
import { prisma } from '../src/db.js';
import { claimNextRun, waitForRun, workerTick } from '../src/backup/runner.js';
import { absPath } from '../src/backup/storage.js';
import { setGatewayFactory, type QueryPage, type SfGateway } from '../src/salesforce/gateway.js';

beforeAll(resetDb);
afterEach(() => setGatewayFactory(null));

interface FakeOptions {
  /** How many rows Salesforce "says" each object has (defaults to the real number). */
  totalSizeOverride?: Record<string, number>;
  failObjects?: string[];
  failAllMetadata?: boolean;
  dropMember?: string; // "Type/Name" that never comes back from retrieve
  gate?: Promise<void>; // makes the run wait (to test overlapping runs)
  /** Gives Account a SystemModstamp and IsDeleted field, so incremental copies are possible. */
  stamped?: boolean;
  /** Replaces the Account rows with this many generated rows (to reach the Bulk API threshold). */
  bigAccount?: number;
  failBulk?: boolean;
  /** Bulk returns only this many rows and then stops (like the jsforce multi-page bug did). */
  shortBulk?: number;
  /** Account gets 500 extra fields; the standard API refuses such a long query address (HTTP 431). */
  wideAccount?: boolean;
  /** Any Account query that selects the Name field returns only this many rows. */
  nameDropsRows?: number;
}

type Row = Record<string, unknown>;

const T0 = Date.parse('2026-01-01T00:00:00Z');
/** Salesforce REST style date-time. */
const stamp = (offsetMs: number) => new Date(T0 + offsetMs).toISOString().replace('Z', '+0000');

function baseData(opts: FakeOptions): Record<string, Row[]> {
  const stampFields = opts.stamped ? (i: number) => ({ SystemModstamp: stamp(i * 600_000), IsDeleted: false }) : () => ({});
  const account: Row[] = opts.bigAccount
    ? Array.from({ length: opts.bigAccount }, (_, i) => ({ Id: `001X${String(i).padStart(5, '0')}`, Name: `Account ${i}`, ...stampFields(i) }))
    : [
        { Id: '001A', Name: 'Acme', ...stampFields(0) },
        { Id: '001B', Name: 'Beta, "Quoted" Ltd', ...stampFields(1) },
        { Id: '001C', Name: 'Ünïcode Ço', ...stampFields(2) },
      ];
  return {
    Account: account,
    Contact: [
      { Id: '003A', LastName: 'Smith' },
      { Id: '003B', LastName: 'Jones' },
    ],
    Broken__c: [],
  };
}

function fakeGateway(opts: FakeOptions = {}) {
  const queries: string[] = [];
  const bulkQueries: string[] = [];
  /** Live rows. Tests change these between runs to simulate edits in Salesforce. */
  const data = baseData(opts);
  /** Rows deleted in Salesforce (still in the recycle bin). */
  const deleted: Record<string, Row[]> = { Account: [] };

  const project = (rows: Row[], soql: string): Row[] => {
    const cols = /^SELECT (.+?) FROM /.exec(soql)![1].split(',').map((c) => c.trim());
    return rows.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])));
  };
  const sinceOf = (soql: string) => {
    const m = /SystemModstamp >= (\S+)/.exec(soql);
    return m ? Date.parse(m[1]) : null;
  };
  const select = (soql: string, includeDeleted: boolean): Row[] => {
    const name = /FROM (\w+)/.exec(soql)![1];
    if (opts.failObjects?.includes(name)) throw new Error('QUERY_TIMEOUT: your query request was running for too long');
    const since = sinceOf(soql);
    const pick = (rows: Row[]) => rows.filter((r) => since === null || Date.parse(String(r.SystemModstamp).replace(/\+0000$/, 'Z')) >= since);
    if (includeDeleted && /IsDeleted = true/.test(soql)) return project(pick(deleted[name] ?? []), soql);
    const out = project(pick(data[name] ?? []), soql);
    // Like PermissionSetTabSetting live: selecting Name makes Salesforce drop rows.
    const selectsName = /^SELECT (.+?) FROM /.exec(soql)![1].split(',').some((c) => c.trim() === 'Name');
    return opts.nameDropsRows !== undefined && name === 'Account' && selectsName ? out.slice(0, opts.nameDropsRows) : out;
  };

  const gw: SfGateway = {
    apiVersion: '62.0',
    async describeGlobal() {
      const o = (name: string, extra: Record<string, unknown> = {}) => ({
        name, label: name, custom: name.endsWith('__c'), queryable: true, deprecatedAndHidden: false, ...extra,
      });
      return [o('Account'), o('Contact'), o('Broken__c'), o('AccountChangeEvent'), o('NotQueryable', { queryable: false })];
    },
    async describeFields(name) {
      if (name === 'Contact') return [{ name: 'Id', type: 'id' }, { name: 'LastName', type: 'string' }];
      return [
        { name: 'Name', type: 'string' },
        { name: 'Id', type: 'id' },
        { name: 'BillingAddress', type: 'address' },
        { name: 'Photo', type: 'base64' },
        ...(name === 'Account' && opts.stamped
          ? [{ name: 'SystemModstamp', type: 'datetime' }, { name: 'IsDeleted', type: 'boolean' }]
          : []),
        ...(name === 'Account' && opts.wideAccount
          ? Array.from({ length: 500 }, (_, i) => ({ name: `PermissionsWideField${i}`, type: 'boolean' }))
          : []),
      ];
    },
    async countRows(name) {
      return opts.totalSizeOverride?.[name] ?? (data[name] ?? []).length;
    },
    async *queryPages(soql, o): AsyncGenerator<QueryPage> {
      queries.push(soql);
      if (encodeURIComponent(soql).length > 8000) throw new Error('HTTP 431 Request Header Fields Too Large');
      if (opts.gate) await opts.gate;
      const name = /FROM (\w+)/.exec(soql)![1];
      const rows = select(soql, !!o?.includeDeleted);
      const total = opts.totalSizeOverride?.[name] ?? rows.length;
      // Two pages, to prove paging works.
      const half = Math.ceil(rows.length / 2);
      yield { records: rows.slice(0, half), totalSize: total };
      if (rows.length > half) yield { records: rows.slice(half), totalSize: total };
    },
    async *bulkQueryPages(soql, o): AsyncGenerator<QueryPage> {
      bulkQueries.push(soql);
      if (opts.failBulk) throw new Error('BULK_JOB_FAILED: job aborted');
      const rows = select(soql, !!o?.includeDeleted).map((r) => ({ ...r, ...(r.SystemModstamp ? { SystemModstamp: String(r.SystemModstamp).replace('+0000', 'Z') } : {}) }));
      const served = opts.shortBulk !== undefined ? rows.slice(0, opts.shortBulk) : rows;
      for (let i = 0; i < served.length || i === 0; i += 400) {
        yield { records: served.slice(i, i + 400), totalSize: o?.expectedRows ?? 0 };
      }
    },
    async describeMetadataTypes() {
      return [{ xmlName: 'ApexClass', inFolder: false }, { xmlName: 'CustomObject', inFolder: false }];
    },
    async listMetadata(type) {
      if (opts.failAllMetadata) throw new Error('INVALID_TYPE: not available');
      if (type === 'ApexClass') {
        return ['A', 'B', 'C'].map((n) => ({ type, fullName: n, manageableState: 'unmanaged' }));
      }
      return [
        { type, fullName: 'Mine__c', manageableState: 'unmanaged' },
        { type, fullName: 'ns__Theirs__c', manageableState: 'installed' },
      ];
    },
    async retrieveMetadata(types) {
      const found: string[] = [];
      for (const [t, members] of Object.entries(types)) {
        for (const m of members) if (`${t}/${m}` !== opts.dropMember) found.push(`${t}/${m}`);
      }
      return { zip: Buffer.from(`PK-fake-zip-${Object.keys(types).join(',')}`), found, warnings: [] };
    },
  };
  return { gw, queries, bulkQueries, data, deleted };
}

async function setup(opts: FakeOptions = {}, label = 'Backup') {
  const fake = fakeGateway(opts);
  setGatewayFactory(async () => fake.gw);
  const s = await signUp(label);
  const conn = await makeConnection(s.user.tenant.id);
  return { ...s, conn, fake };
}

async function startAndWait(agent: ReturnType<typeof request.agent>, connId: string, body: Record<string, unknown> = {}) {
  const res = await agent.post(`/api/connections/${connId}/runs`).send(body);
  expect(res.status).toBe(202);
  const done = await waitForRun(res.body.run.id);
  const detail = await agent.get(`/api/runs/${done.id}`);
  return { run: done, detail: detail.body.run, runId: done.id as string };
}

function binary(r: request.Test) {
  return r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

describe('a clean backup', () => {
  it('copies metadata and records, verifies them, and only then says SUCCEEDED', async () => {
    const { agent, conn, user, fake } = await setup({ failObjects: [] });
    // Broken__c has zero rows and is fine here; nothing fails.
    const { run, detail, runId } = await startAndWait(agent, conn.id);

    expect(run.status).toBe('SUCCEEDED');
    expect(detail.summary.failed).toBe(0);
    expect(detail.summary.partial).toBe(0);
    expect(detail.summary.rows).toBe(5);

    const account = detail.items.find((i: { name: string; kind: string }) => i.name === 'Account' && i.kind === 'OBJECT');
    expect(account).toMatchObject({ status: 'SUCCEEDED', rowCount: 3, expectedCount: 3 });
    expect(detail.items.find((i: { name: string }) => i.name === 'NotQueryable')).toBeUndefined();

    // Binary and address fields are not requested.
    const q = fake.queries.find((s) => s.includes('FROM Account'))!;
    expect(q).toContain('Name');
    expect(q).not.toContain('BillingAddress');
    expect(q).not.toContain('Photo');

    // The file on disk really holds the records, and its checksum matches what we recorded.
    const row = await prisma.backupItem.findFirstOrThrow({ where: { runId, name: 'Account' } });
    const bytes = await readFile(absPath(row.filePath!));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256);
    const lines = gunzipSync(bytes).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[1].Name).toBe('Beta, "Quoted" Ltd');
    expect(lines[2].Name).toBe('Ünïcode Ço');
    expect(lines[0].attributes).toBeUndefined();

    // Manifest lists what was NOT copied, with reasons.
    const manifest = JSON.parse(await readFile(join(absPath(`tenants/${user.tenant.id}/orgs/${conn.id}/runs/${runId}`), 'manifest.json'), 'utf8'));
    expect(manifest.status).toBe('SUCCEEDED');
    expect(manifest.notCopied.map((n: { name: string }) => n.name)).toContain('AccountChangeEvent');
    expect(manifest.limits.length).toBeGreaterThan(0);

    // Managed-package metadata is skipped and says so.
    const co = detail.items.find((i: { name: string; kind: string }) => i.kind === 'METADATA' && i.name === 'CustomObject');
    expect(co.status).toBe('SUCCEEDED');
    expect(co.expectedCount).toBe(1);
    expect(co.note).toMatch(/installed managed packages/);
  });

  it('gives a zip of the whole run and of a single item', async () => {
    const { agent, conn } = await setup();
    const { runId, detail } = await startAndWait(agent, conn.id);

    const link = await agent.post(`/api/runs/${runId}/download-link`).send({});
    expect(link.status).toBe(200);
    // The link works without being logged in (it is signed and short-lived).
    const zip = await binary(request(app).get(link.body.url));
    expect(zip.status).toBe(200);
    expect(zip.headers['content-type']).toMatch(/zip/);
    expect(zip.body.subarray(0, 2).toString()).toBe('PK');
    expect(zip.body.includes(Buffer.from('manifest.json'))).toBe(true);

    const acct = detail.items.find((i: { name: string }) => i.name === 'Account');
    const one = await agent.post(`/api/runs/${runId}/download-link`).send({ itemId: acct.id });
    const file = await binary(request(app).get(one.body.url));
    expect(file.status).toBe(200);
    expect(gunzipSync(file.body).toString().trim().split('\n')).toHaveLength(3);

    expect((await request(app).get('/api/downloads/not-a-real-token')).status).toBe(403);
  });

  it('copies only the objects that were asked for', async () => {
    const { agent, conn } = await setup();
    const { run, detail } = await startAndWait(agent, conn.id, { includeMetadata: false, objects: ['Contact'] });
    expect(run.status).toBe('SUCCEEDED');
    expect(detail.items.map((i: { name: string }) => i.name)).toEqual(['Contact']);
  });
});

describe('honest results when things go wrong', () => {
  it('a failing object makes the run PARTIAL, never SUCCEEDED', async () => {
    const { agent, conn } = await setup({ failObjects: ['Contact'] });
    const { run, detail } = await startAndWait(agent, conn.id);
    expect(run.status).toBe('PARTIAL');
    const contact = detail.items.find((i: { name: string }) => i.name === 'Contact');
    expect(contact.status).toBe('FAILED');
    expect(contact.error).toMatch(/QUERY_TIMEOUT/);
    expect(detail.items.find((i: { name: string; kind: string }) => i.name === 'Account' && i.kind === 'OBJECT').status).toBe('SUCCEEDED');
  });

  it('a row count that does not match Salesforce makes the item and the run PARTIAL', async () => {
    const { agent, conn } = await setup({ totalSizeOverride: { Account: 5 } });
    const { run, detail } = await startAndWait(agent, conn.id);
    const account = detail.items.find((i: { name: string; kind: string }) => i.name === 'Account' && i.kind === 'OBJECT');
    expect(account.status).toBe('PARTIAL');
    expect(account.error).toMatch(/said 5 rows but we received 3/);
    expect(run.status).toBe('PARTIAL');
  });

  it('metadata that Salesforce does not return makes that type PARTIAL', async () => {
    const { agent, conn } = await setup({ dropMember: 'ApexClass/B' });
    const { run, detail } = await startAndWait(agent, conn.id);
    const apex = detail.items.find((i: { name: string }) => i.name === 'ApexClass');
    expect(apex.status).toBe('PARTIAL');
    expect(apex.expectedCount).toBe(3);
    expect(apex.rowCount).toBe(2);
    expect(apex.error).toMatch(/ApexClass\/B/);
    expect(run.status).toBe('PARTIAL');
  });

  it('is FAILED when nothing could be copied', async () => {
    const { agent, conn } = await setup({ failAllMetadata: true, failObjects: ['Account', 'Contact', 'Broken__c'] });
    const { run } = await startAndWait(agent, conn.id);
    expect(run.status).toBe('FAILED');
    expect(run.message).toMatch(/Nothing could be copied/);
  });

  it('a Salesforce login failure marks the org as needing reconnect', async () => {
    const s = await signUp('Reconnect');
    const conn = await makeConnection(s.user.tenant.id);
    setGatewayFactory(async () => {
      throw new Error('invalid_grant: expired access/refresh token');
    });
    const { run } = await startAndWait(s.agent, conn.id);
    expect(run.status).toBe('FAILED');
    expect(run.message).toMatch(/reconnect/i);
    expect((await prisma.orgConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe('NEEDS_RECONNECT');
    // And a new backup is refused until the org is reconnected.
    const again = await s.agent.post(`/api/connections/${conn.id}/runs`).send({});
    expect(again.status).toBe(409);
  });

  it('queues a second run behind the first and refuses a third', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { agent, conn } = await setup({ gate });
    const body = { includeMetadata: false, objects: ['Contact'] };
    const first = await agent.post(`/api/connections/${conn.id}/runs`).send(body);
    expect(first.status).toBe(202);
    const second = await agent.post(`/api/connections/${conn.id}/runs`).send(body);
    expect(second.status).toBe(202);
    const third = await agent.post(`/api/connections/${conn.id}/runs`).send({});
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('run_queue_full');
    // Never two at once for one org: the second one waits.
    expect((await prisma.backupRun.findUniqueOrThrow({ where: { id: second.body.run.id } })).status).toBe('QUEUED');
    open();
    expect((await waitForRun(first.body.run.id)).status).toBe('SUCCEEDED');
    expect((await waitForRun(second.body.run.id)).status).toBe('SUCCEEDED');
    // Once they are finished, a new run is allowed again.
    const fourth = await agent.post(`/api/connections/${conn.id}/runs`).send(body);
    expect(fourth.status).toBe(202);
    await waitForRun(fourth.body.run.id);
  });

  it('continues an interrupted run where it stopped instead of starting over', async () => {
    const { user, conn, fake } = await setup();
    const tenantId = user.tenant.id;
    const run = await prisma.backupRun.create({
      data: {
        tenantId, connectionId: conn.id, trigger: 'manual', status: 'RUNNING', attempts: 1,
        leaseUntil: new Date(Date.now() - 60_000), workerId: 'dead-worker',
        options: { includeMetadata: false, objects: ['Account', 'Contact'] },
      },
    });
    // Account was already copied and verified before the "crash"; Contact was in progress.
    await prisma.backupItem.create({ data: { runId: run.id, tenantId, kind: 'OBJECT', name: 'Account', status: 'SUCCEEDED', rowCount: 3, expectedCount: 3 } });
    await prisma.backupItem.create({ data: { runId: run.id, tenantId, kind: 'OBJECT', name: 'Contact', status: 'RUNNING' } });

    await workerTick();
    const done = await waitForRun(run.id);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.attempts).toBe(2);
    expect(fake.queries.some((q) => q.includes('FROM Account'))).toBe(false); // not copied again
    expect(fake.queries.some((q) => q.includes('FROM Contact'))).toBe(true);
    const items = await prisma.backupItem.findMany({ where: { runId: run.id } });
    expect(items.every((i) => i.status === 'SUCCEEDED')).toBe(true);
  });

  it('gives up on a run that was interrupted too many times', async () => {
    const s = await signUp('Restart');
    const conn = await makeConnection(s.user.tenant.id);
    const run = await prisma.backupRun.create({
      data: {
        tenantId: s.user.tenant.id, connectionId: conn.id, trigger: 'manual', status: 'RUNNING',
        attempts: 3, maxAttempts: 3, leaseUntil: new Date(Date.now() - 1000), workerId: 'dead-worker',
      },
    });
    await prisma.backupItem.create({ data: { runId: run.id, tenantId: s.user.tenant.id, kind: 'OBJECT', name: 'Account', status: 'RUNNING' } });
    await claimNextRun('test-worker');
    const after = await prisma.backupRun.findUniqueOrThrow({ where: { id: run.id }, include: { items: true } });
    expect(after.status).toBe('FAILED');
    expect(after.message).toMatch(/interrupted/);
    expect(after.items[0].status).toBe('FAILED');
  });

  it('does not take over a run whose worker is still alive, and keeps one run per org', async () => {
    const s = await signUp('Alive');
    const conn = await makeConnection(s.user.tenant.id);
    const live = await prisma.backupRun.create({
      data: { tenantId: s.user.tenant.id, connectionId: conn.id, trigger: 'manual', status: 'RUNNING', attempts: 1, leaseUntil: new Date(Date.now() + 60_000), workerId: 'other' },
    });
    const queued = await prisma.backupRun.create({ data: { tenantId: s.user.tenant.id, connectionId: conn.id, trigger: 'manual' } });
    expect(await claimNextRun('me')).toBeNull();
    expect((await prisma.backupRun.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('QUEUED');
    expect((await prisma.backupRun.findUniqueOrThrow({ where: { id: live.id } })).workerId).toBe('other');
    await prisma.backupRun.deleteMany({ where: { connectionId: conn.id } });
  });

  it('two workers never take the same run', async () => {
    const s = await signUp('Race');
    const conn = await makeConnection(s.user.tenant.id);
    await prisma.backupRun.create({ data: { tenantId: s.user.tenant.id, connectionId: conn.id, trigger: 'manual' } });
    const [a, b] = await Promise.all([claimNextRun('w1'), claimNextRun('w2')]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    await prisma.backupRun.deleteMany({ where: { connectionId: conn.id } });
  });

  it('tries Salesforce again when it cannot be reached, then fails honestly', async () => {
    const s = await signUp('Flaky');
    const conn = await makeConnection(s.user.tenant.id);
    let calls = 0;
    setGatewayFactory(async () => {
      calls++;
      throw new Error('ECONNRESET: socket hang up');
    });
    const { run } = await startAndWait(s.agent, conn.id);
    expect(calls).toBe(3);
    expect(run.status).toBe('FAILED');
    expect(run.attempts).toBe(3);
    expect(run.message).toMatch(/Could not connect to Salesforce/);
    // A temporary network problem is not a reason to demand a reconnect.
    expect((await prisma.orgConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe('ACTIVE');
  });

  it('retries an item that fails once and still ends SUCCEEDED', async () => {
    const { agent, conn, fake } = await setup();
    let failed = false;
    const flaky: SfGateway = {
      ...fake.gw,
      async *queryPages(soql, o) {
        if (/FROM Contact/.test(soql) && !failed) {
          failed = true;
          throw new Error('REQUEST_LIMIT_EXCEEDED: try later');
        }
        yield* fake.gw.queryPages(soql, o);
      },
    };
    setGatewayFactory(async () => flaky);
    const { run } = await startAndWait(agent, conn.id, { includeMetadata: false, objects: ['Contact'] });
    expect(failed).toBe(true);
    expect(run.status).toBe('SUCCEEDED');
  });
});

describe('large objects (Bulk API 2.0)', () => {
  it('uses the Bulk API for an object over the threshold and still verifies the row count', async () => {
    const { agent, conn, fake } = await setup({ bigAccount: 1200 });
    const { run, runId } = await startAndWait(agent, conn.id, { includeMetadata: false, objects: ['Account'] });
    expect(run.status).toBe('SUCCEEDED');
    expect(fake.bulkQueries).toHaveLength(1);
    expect(fake.queries.some((q) => q.includes('FROM Account'))).toBe(false);
    const item = await prisma.backupItem.findFirstOrThrow({ where: { runId, name: 'Account' } });
    expect(item).toMatchObject({ status: 'SUCCEEDED', rowCount: 1200, expectedCount: 1200 });
    expect(item.note).toMatch(/Bulk API 2\.0/);
    const lines = gunzipSync(await readFile(absPath(item.filePath!))).toString('utf8').trim().split('\n');
    expect(lines).toHaveLength(1200);
  });

  it('small objects keep using the standard API', async () => {
    const { agent, conn, fake } = await setup();
    await startAndWait(agent, conn.id, { includeMetadata: false, objects: ['Account'] });
    expect(fake.bulkQueries).toHaveLength(0);
  });

  it('falls back to the standard API when the bulk job fails, and says so', async () => {
    const { agent, conn, fake } = await setup({ bigAccount: 1200, failBulk: true });
    const { run, runId } = await startAndWait(agent, conn.id, { includeMetadata: false, objects: ['Account'] });
    expect(run.status).toBe('SUCCEEDED');
    expect(fake.queries.some((q) => q.includes('FROM Account'))).toBe(true);
    const item = await prisma.backupItem.findFirstOrThrow({ where: { runId, name: 'Account' } });
    expect(item.rowCount).toBe(1200);
    expect(item.note).toMatch(/Bulk API 2\.0 failed/);
  });

  it('never settles for a short Bulk copy: it copies again with the standard API', async () => {
    const { agent, conn, fake } = await setup({ bigAccount: 1200, shortBulk: 400 });
    const { run, runId } = await startAndWait(agent, conn.id, { includeMetadata: false, objects: ['Account'] });
    expect(run.status).toBe('SUCCEEDED');
    expect(fake.bulkQueries).toHaveLength(1);
    expect(fake.queries.some((q) => q.includes('FROM Account'))).toBe(true);
    const item = await prisma.backupItem.findFirstOrThrow({ where: { runId, name: 'Account' } });
    expect(item).toMatchObject({ status: 'SUCCEEDED', rowCount: 1200, expectedCount: 1200 });
    expect(item.note).toMatch(/returned 400 of 1200 rows; copied again/);
  });

  it('sends an object with hundreds of fields through Bulk, because the standard API address would be too long', async () => {
    const { agent, conn, fake } = await setup({ wideAccount: true });
    const { run, runId } = await startAndWait(agent, conn.id, { includeMetadata: false, objects: ['Account'] });
    expect(run.status).toBe('SUCCEEDED');
    expect(fake.bulkQueries).toHaveLength(1);
    expect(fake.queries.some((q) => q.includes('FROM Account'))).toBe(false);
    const item = await prisma.backupItem.findFirstOrThrow({ where: { runId, name: 'Account' } });
    expect(item.note).toMatch(/too many fields/);
  });
});

describe('objects where selecting Name silently drops rows', () => {
  const only = { includeMetadata: false, objects: ['Account'] };

  it('copies again without Name, keeps every record, and says what was left out', async () => {
    const { agent, conn } = await setup({ bigAccount: 1200, nameDropsRows: 500 });
    const { run, runId } = await startAndWait(agent, conn.id, only);
    expect(run.status).toBe('SUCCEEDED');
    const item = await prisma.backupItem.findFirstOrThrow({ where: { runId, name: 'Account' } });
    expect(item).toMatchObject({ status: 'SUCCEEDED', rowCount: 1200, expectedCount: 1200 });
    expect(item.note).toMatch(/Name field made Salesforce return only 500 of 1200 rows, so Name was left out/);
    const lines = gunzipSync(await readFile(absPath(item.filePath!))).toString('utf8').trim().split('\n');
    expect(lines).toHaveLength(1200);
    expect(JSON.parse(lines[0]!)).not.toHaveProperty('Name');
    expect(JSON.parse(lines[0]!)).toHaveProperty('Id');
  });

  it('works for small objects on the standard API too', async () => {
    const { agent, conn } = await setup({ nameDropsRows: 2 });
    const { run, runId } = await startAndWait(agent, conn.id, only);
    expect(run.status).toBe('SUCCEEDED');
    const item = await prisma.backupItem.findFirstOrThrow({ where: { runId, name: 'Account' } });
    expect(item).toMatchObject({ status: 'SUCCEEDED', rowCount: 3, expectedCount: 3 });
  });

  it('stays PARTIAL when leaving Name out still does not give every row', async () => {
    const { agent, conn } = await setup({ nameDropsRows: 2, totalSizeOverride: { Account: 5 } });
    const { run, runId } = await startAndWait(agent, conn.id, only);
    expect(run.status).toBe('PARTIAL');
    const item = await prisma.backupItem.findFirstOrThrow({ where: { runId, name: 'Account' } });
    expect(item.status).toBe('PARTIAL');
    expect(item.rowCount).toBe(3);
    expect(item.note).toMatch(/still short/);
  });

  it('does not touch objects whose copy is complete', async () => {
    const { agent, conn } = await setup();
    const { runId } = await startAndWait(agent, conn.id, only);
    const item = await prisma.backupItem.findFirstOrThrow({ where: { runId, name: 'Account' } });
    expect(item.note ?? '').not.toMatch(/Name/);
  });
});

describe('incremental backups', () => {
  const only = { includeMetadata: false, objects: ['Account'] };
  const rowsOf = async (runId: string) => {
    const item = await prisma.backupItem.findFirstOrThrow({ where: { runId, name: 'Account' } });
    const rows = gunzipSync(await readFile(absPath(item.filePath!))).toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as Row);
    return { item, rows };
  };

  it('copies only changed records, applies deletions, and each run is a complete snapshot', async () => {
    const { agent, conn, fake } = await setup({ stamped: true });

    // 1) The first copy is always full and leaves a checkpoint behind.
    const r1 = await startAndWait(agent, conn.id, only);
    expect(r1.run.status).toBe('SUCCEEDED');
    const first = await rowsOf(r1.runId);
    expect(first.item.mode).toBe('FULL');
    expect(first.rows).toHaveLength(3);
    const cp = await prisma.objectCheckpoint.findUniqueOrThrow({ where: { connectionId_objectName: { connectionId: conn.id, objectName: 'Account' } } });
    expect(cp.lastFilePath).toBe(first.item.filePath);
    expect(cp.needsFull).toBe(false);

    // 2) Salesforce changes: edit A, add D, delete B.
    const [a, b, c] = fake.data.Account;
    a.Name = 'Acme Renamed';
    a.SystemModstamp = stamp(60 * 60_000);
    const d: Row = { Id: '001D', Name: 'Delta', SystemModstamp: stamp(61 * 60_000), IsDeleted: false };
    fake.data.Account = [a, c, d];
    fake.deleted.Account.push({ Id: b.Id, IsDeleted: true, SystemModstamp: stamp(62 * 60_000) });

    const before = fake.queries.length;
    const r2 = await startAndWait(agent, conn.id, only);
    expect(r2.run.status).toBe('SUCCEEDED');
    const second = await rowsOf(r2.runId);
    expect(second.item.mode).toBe('INCREMENTAL');
    expect(second.item.deletedCount).toBe(1);
    expect(second.item.changedCount).toBeGreaterThanOrEqual(2);
    expect(second.item.rowCount).toBe(3);
    expect(second.rows.map((r) => r.Id).sort()).toEqual(['001A', '001C', '001D']);
    expect(second.rows.find((r) => r.Id === '001A')!.Name).toBe('Acme Renamed');
    // It asked Salesforce only for what changed, never for the whole table.
    const asked = fake.queries.slice(before);
    expect(asked.some((q) => !q.includes('WHERE'))).toBe(false);
    expect(asked.some((q) => q.includes('IsDeleted = true'))).toBe(true);
    // The first snapshot is untouched (history is kept).
    expect((await rowsOf(r1.runId)).rows).toHaveLength(3);
    expect(r2.detail.status).toBe('SUCCEEDED');

    // 3) "Force full copy" ignores the checkpoint.
    const r3 = await startAndWait(agent, conn.id, { ...only, fullCopy: true });
    const third = await rowsOf(r3.runId);
    expect(third.item.mode).toBe('FULL');
    expect(third.rows).toHaveLength(3);
  });

  it('falls back to a full copy when the counts do not add up, and never calls it SUCCEEDED', async () => {
    const opts: FakeOptions = { stamped: true };
    const { agent, conn } = await setup(opts);
    await startAndWait(agent, conn.id, only);
    opts.totalSizeOverride = { Account: 99 }; // Salesforce suddenly "has" more rows than we can find
    const r = await startAndWait(agent, conn.id, only);
    const item = await prisma.backupItem.findFirstOrThrow({ where: { runId: r.runId, name: 'Account' } });
    expect(item.note).toMatch(/Full copy made \(row count did not match/);
    expect(item.mode).toBe('FULL');
    expect(item.status).toBe('PARTIAL');
    expect(r.run.status).toBe('PARTIAL');
  });

  it('makes a full copy of an object that has no change timestamp, every time', async () => {
    const { agent, conn } = await setup();
    await startAndWait(agent, conn.id, { includeMetadata: false, objects: ['Contact'] });
    const r = await startAndWait(agent, conn.id, { includeMetadata: false, objects: ['Contact'] });
    const item = await prisma.backupItem.findFirstOrThrow({ where: { runId: r.runId, name: 'Contact' } });
    expect(item.mode).toBe('FULL');
    expect(item.rowCount).toBe(2);
    expect(r.run.status).toBe('SUCCEEDED');
  });

  it('does not move the checkpoint when a copy is not fully verified', async () => {
    const opts: FakeOptions = { stamped: true };
    const { agent, conn } = await setup(opts);
    const r1 = await startAndWait(agent, conn.id, only);
    opts.totalSizeOverride = { Account: 99 };
    await startAndWait(agent, conn.id, only);
    const cp = await prisma.objectCheckpoint.findUniqueOrThrow({ where: { connectionId_objectName: { connectionId: conn.id, objectName: 'Account' } } });
    const firstItem = await prisma.backupItem.findFirstOrThrow({ where: { runId: r1.runId, name: 'Account' } });
    expect(cp.lastItemId).toBe(firstItem.id);
  });
});

describe('customers cannot see each other', () => {
  it('another customer gets 404 for connections, runs and downloads', async () => {
    const a = await setup({}, 'TenantA');
    const { runId, detail } = await startAndWait(a.agent, a.conn.id);
    const b = await signUp('TenantB');

    expect((await b.agent.get('/api/connections')).body.connections).toHaveLength(0);
    expect((await b.agent.get(`/api/connections/${a.conn.id}`)).status).toBe(404);
    expect((await b.agent.post(`/api/connections/${a.conn.id}/runs`).send({})).status).toBe(404);
    expect((await b.agent.delete(`/api/connections/${a.conn.id}`)).status).toBe(404);
    expect((await b.agent.get(`/api/runs/${runId}`)).status).toBe(404);
    expect((await b.agent.get('/api/runs')).body.runs).toHaveLength(0);
    expect((await b.agent.post(`/api/runs/${runId}/download-link`).send({})).status).toBe(404);
    expect((await b.agent.get('/api/audit')).body.entries.every((e: { target: string | null }) => e.target !== runId)).toBe(true);

    const item = detail.items[0];
    expect((await b.agent.post(`/api/runs/${runId}/download-link`).send({ itemId: item.id })).status).toBe(404);
  });

  it('a signed link cannot be bent to reach another customer\'s run', async () => {
    const a = await setup({}, 'LinkA');
    const { runId } = await startAndWait(a.agent, a.conn.id);
    const b = await signUp('LinkB');
    const { signToken } = await import('../src/lib/crypto.js');
    // A valid signature, but with the wrong tenant for that run.
    const { token } = signToken({ t: b.user.tenant.id, r: runId, i: null }, 60);
    expect((await request(app).get(`/api/downloads/${token}`)).status).toBe(404);
  });

  it('a read-only user can look but not start or delete', async () => {
    const owner = await setup({}, 'Roles');
    const ownerRow = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    const email = `viewer-${Date.now()}@example.com`;
    await prisma.user.create({ data: { email, name: 'V', passwordHash: ownerRow.passwordHash, role: 'VIEWER', tenantId: owner.user.tenant.id, emailVerifiedAt: new Date() } });
    const v = request.agent(app);
    await v.post('/api/auth/login').send({ email, password: 'a-long-test-password' }).expect(200);
    expect((await v.get('/api/connections')).body.connections).toHaveLength(1);
    expect((await v.post(`/api/connections/${owner.conn.id}/runs`).send({})).status).toBe(403);
    expect((await v.delete(`/api/connections/${owner.conn.id}`)).status).toBe(403);
    expect((await v.put(`/api/connections/${owner.conn.id}/schedule`).send({ scheduleHours: 24 })).status).toBe(403);
  });
});

describe('schedule and coverage', () => {
  it('saves and clears a schedule', async () => {
    const { agent, conn } = await setup({}, 'Sched');
    const set = await agent.put(`/api/connections/${conn.id}/schedule`).send({ scheduleHours: 24 });
    expect(set.status).toBe(200);
    const row = await prisma.orgConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(row.scheduleHours).toBe(24);
    expect(row.nextRunAt).not.toBeNull();
    await agent.put(`/api/connections/${conn.id}/schedule`).send({ scheduleHours: null }).expect(200);
    const cleared = await prisma.orgConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(cleared.scheduleHours).toBeNull();
    expect(cleared.nextRunAt).toBeNull();
  });

  it('shows what would and would not be copied, with reasons', async () => {
    const { agent, conn } = await setup({}, 'Cov');
    const res = await agent.get(`/api/connections/${conn.id}/coverage`);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).toContain('Account');
    expect(text).toContain('AccountChangeEvent');
  });
});

describe('data explorer and the read-only auditor', () => {
  async function auditorFor(owner: Awaited<ReturnType<typeof setup>>) {
    const ownerRow = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    const email = `auditor-${Date.now()}@example.com`;
    await prisma.user.create({
      data: { email, name: 'Auditor', passwordHash: ownerRow.passwordHash, role: 'AUDITOR', tenantId: owner.user.tenant.id, emailVerifiedAt: new Date() },
    });
    const a = request.agent(app);
    await a.post('/api/auth/login').send({ email, password: 'a-long-test-password' }).expect(200);
    return a;
  }

  it('lists backups and objects, and pages through the records', async () => {
    const o = await setup({}, 'Explore');
    const { runId } = await startAndWait(o.agent, o.conn.id);

    const snaps = await o.agent.get('/api/explorer/snapshots').query({ connectionId: o.conn.id });
    expect(snaps.body.snapshots.map((s: { id: string }) => s.id)).toContain(runId);

    const objs = await o.agent.get(`/api/explorer/runs/${runId}/objects`);
    const names = objs.body.objects.map((x: { name: string }) => x.name);
    expect(names).toEqual(expect.arrayContaining(['Account', 'Contact']));

    const page1 = await o.agent.get(`/api/explorer/runs/${runId}/objects/Account/records`).query({ limit: 2 });
    expect(page1.status).toBe(200);
    expect(page1.body.records).toHaveLength(2);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.total).toBe(3);
    expect(page1.body.columns).toContain('Name');
    const page2 = await o.agent.get(`/api/explorer/runs/${runId}/objects/Account/records`).query({ limit: 2, offset: 2 });
    expect(page2.body.records).toHaveLength(1);
    expect(page2.body.hasMore).toBe(false);
    expect(page2.body.records[0].Name).toBe('Ünïcode Ço');
  });

  it('searches across all fields or one field, ignoring upper/lower case', async () => {
    const o = await setup({}, 'Search');
    const { runId } = await startAndWait(o.agent, o.conn.id);
    const all = await o.agent.get(`/api/explorer/runs/${runId}/objects/Account/records`).query({ q: 'QUOTED' });
    expect(all.body.records).toHaveLength(1);
    expect(all.body.total).toBeNull(); // not known once filtered
    const one = await o.agent.get(`/api/explorer/runs/${runId}/objects/Account/records`).query({ q: '001a', field: 'Id' });
    expect(one.body.records.map((r: { Name: string }) => r.Name)).toEqual(['Acme']);
    const none = await o.agent.get(`/api/explorer/runs/${runId}/objects/Account/records`).query({ q: 'zzz' });
    expect(none.body.records).toHaveLength(0);
    expect((await o.agent.get(`/api/explorer/runs/${runId}/objects/Account/records`).query({ limit: 9999 })).status).toBe(400);
    expect((await o.agent.get(`/api/explorer/runs/${runId}/objects/Nope/records`)).status).toBe(404);
  });

  it('keeps customers apart', async () => {
    const a = await setup({}, 'ExpA');
    const b = await signUp('ExpB');
    const { runId } = await startAndWait(a.agent, a.conn.id);
    expect((await b.agent.get(`/api/explorer/runs/${runId}/objects`)).status).toBe(404);
    expect((await b.agent.get(`/api/explorer/runs/${runId}/objects/Account/records`)).status).toBe(404);
    expect((await b.agent.get(`/api/explorer/runs/${runId}/objects/Account/export.csv`)).status).toBe(404);
    expect((await b.agent.get('/api/explorer/snapshots')).body.snapshots).toHaveLength(0);
    expect((await request(app).get('/api/explorer/snapshots')).status).toBe(401);
  });

  it('exports CSV, neutralises spreadsheet formulas, and records who did it', async () => {
    const o = await setup({}, 'Csv');
    o.fake.data.Account[0].Name = '=HYPERLINK("http://evil.example","x")';
    const { runId } = await startAndWait(o.agent, o.conn.id);
    const res = await o.agent.get(`/api/explorer/runs/${runId}/objects/Account/export.csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toContain('Name');
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(res.text).toContain('"Beta, ""Quoted"" Ltd"');
    expect(lines).toHaveLength(4);
    const log = await prisma.auditLog.findFirst({ where: { tenantId: o.user.tenant.id, action: 'explorer.export' } });
    expect(log).not.toBeNull();
  });

  it('lets an auditor look, but not take data out', async () => {
    const o = await setup({}, 'Aud');
    const { runId } = await startAndWait(o.agent, o.conn.id);
    const a = await auditorFor(o);

    expect((await a.get('/api/connections')).body.connections).toHaveLength(1);
    expect((await a.get(`/api/runs/${runId}`)).status).toBe(200);
    expect((await a.get('/api/audit')).status).toBe(200);
    expect((await a.get(`/api/explorer/runs/${runId}/objects/Account/records`)).status).toBe(200);

    expect((await a.get(`/api/explorer/runs/${runId}/objects/Account/export.csv`)).status).toBe(403);
    expect((await a.post(`/api/runs/${runId}/download-link`).send({})).status).toBe(403);
    expect((await a.post(`/api/connections/${o.conn.id}/runs`).send({})).status).toBe(403);
    expect((await a.delete(`/api/connections/${o.conn.id}`)).status).toBe(403);
  });
});
