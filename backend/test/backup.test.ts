import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, makeConnection, resetDb, signUp } from './helpers.js';
import { prisma } from '../src/db.js';
import { recoverStaleRuns, waitForRun } from '../src/backup/runner.js';
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
}

const DATA: Record<string, Record<string, unknown>[]> = {
  Account: [
    { Id: '001A', Name: 'Acme', attributes: { type: 'Account' } },
    { Id: '001B', Name: 'Beta, "Quoted" Ltd', attributes: { type: 'Account' } },
    { Id: '001C', Name: 'Ünïcode Ço', attributes: { type: 'Account' } },
  ],
  Contact: [
    { Id: '003A', LastName: 'Smith', attributes: { type: 'Contact' } },
    { Id: '003B', LastName: 'Jones', attributes: { type: 'Contact' } },
  ],
  Broken__c: [],
};

function fakeGateway(opts: FakeOptions = {}) {
  const queries: string[] = [];
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
      ];
    },
    async *queryPages(soql): AsyncGenerator<QueryPage> {
      queries.push(soql);
      if (opts.gate) await opts.gate;
      const name = /FROM (\w+)/.exec(soql)![1];
      if (opts.failObjects?.includes(name)) throw new Error('QUERY_TIMEOUT: your query request was running for too long');
      const rows = DATA[name] ?? [];
      const total = opts.totalSizeOverride?.[name] ?? rows.length;
      // Two pages, to prove paging works.
      const half = Math.ceil(rows.length / 2);
      yield { records: rows.slice(0, half), totalSize: total };
      if (rows.length > half) yield { records: rows.slice(half), totalSize: total };
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
  return { gw, queries };
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

  it('refuses a second run while one is in progress', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { agent, conn } = await setup({ gate });
    const first = await agent.post(`/api/connections/${conn.id}/runs`).send({ includeMetadata: false, objects: ['Contact'] });
    expect(first.status).toBe(202);
    const second = await agent.post(`/api/connections/${conn.id}/runs`).send({});
    expect(second.status).toBe(409);
    open();
    const done = await waitForRun(first.body.run.id);
    expect(done.status).toBe('SUCCEEDED');
    // Once it is finished, a new run is allowed again.
    const third = await agent.post(`/api/connections/${conn.id}/runs`).send({ includeMetadata: false, objects: ['Contact'] });
    expect(third.status).toBe(202);
    await waitForRun(third.body.run.id);
  });

  it('marks runs cut off by a restart as FAILED', async () => {
    const s = await signUp('Restart');
    const conn = await makeConnection(s.user.tenant.id);
    const run = await prisma.backupRun.create({ data: { tenantId: s.user.tenant.id, connectionId: conn.id, trigger: 'manual', status: 'RUNNING' } });
    await prisma.backupItem.create({ data: { runId: run.id, tenantId: s.user.tenant.id, kind: 'OBJECT', name: 'Account', status: 'RUNNING' } });
    expect(await recoverStaleRuns()).toBeGreaterThanOrEqual(1);
    const after = await prisma.backupRun.findUniqueOrThrow({ where: { id: run.id }, include: { items: true } });
    expect(after.status).toBe('FAILED');
    expect(after.message).toMatch(/restarted/);
    expect(after.items[0].status).toBe('FAILED');
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
    await prisma.user.create({ data: { email, name: 'V', passwordHash: ownerRow.passwordHash, role: 'VIEWER', tenantId: owner.user.tenant.id } });
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
