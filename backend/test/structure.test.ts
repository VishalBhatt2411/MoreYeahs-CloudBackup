import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { app, makeConnection, resetDb, signUp } from './helpers.js';
import { prisma } from '../src/db.js';
import { normalizeOptions, startRun, waitForRun } from '../src/backup/runner.js';
import {
  CATEGORIES,
  categoryOfItem,
  categoryOfMetadataType,
  categoryOfObject,
  isCategoryId,
  metadataTypeLabel,
  planFilter,
} from '../src/backup/categories.js';
import { csvCell, neutraliseFormula } from '../src/backup/export/tables.js';
import { setGatewayFactory, type QueryPage, type SfGateway } from '../src/salesforce/gateway.js';

beforeAll(resetDb);
afterEach(() => setGatewayFactory(null));

type Row = Record<string, unknown>;

const LABELS: Record<string, string> = {
  Account: 'Account',
  Contact: 'Contact',
  Invoice__c: 'Invoice',
  Task: 'Task',
  AccountHistory: 'Account History',
};

const FIELDS: Record<string, { name: string; label: string; type: string }[]> = {
  Account: [
    { name: 'Id', label: 'Account ID', type: 'id' },
    { name: 'Name', label: 'Account Name', type: 'string' },
    { name: 'AnnualRevenue', label: 'Annual Revenue', type: 'currency' },
    { name: 'IsActive__c', label: 'Active', type: 'boolean' },
    { name: 'CreatedDate', label: 'Created Date', type: 'datetime' },
  ],
  Contact: [
    { name: 'Id', label: 'Contact ID', type: 'id' },
    { name: 'LastName', label: 'Last Name', type: 'string' },
  ],
  Invoice__c: [
    { name: 'Id', label: 'Record ID', type: 'id' },
    { name: 'Name', label: 'Invoice Number', type: 'string' },
  ],
  Task: [
    { name: 'Id', label: 'Task ID', type: 'id' },
    { name: 'Subject', label: 'Subject', type: 'string' },
  ],
  AccountHistory: [
    { name: 'Id', label: 'History ID', type: 'id' },
    { name: 'Field', label: 'Field', type: 'string' },
  ],
};

const DATA: Record<string, Row[]> = {
  Account: [
    { Id: '001A', Name: 'Acme', AnnualRevenue: 1250.5, IsActive__c: true, CreatedDate: '2026-03-04T10:20:30.000+0000' },
    { Id: '001B', Name: '=cmd|calc', AnnualRevenue: 99, IsActive__c: false, CreatedDate: '2026-03-05T00:00:00.000+0000' },
    { Id: '001C', Name: 'Beta, "Quoted" Ltd', AnnualRevenue: null, IsActive__c: true, CreatedDate: '2026-03-06T00:00:00.000+0000' },
  ],
  Contact: [
    { Id: '003A', LastName: 'Smith' },
    { Id: '003B', LastName: 'Jones' },
  ],
  Invoice__c: [{ Id: 'a01A', Name: 'INV-0001' }],
  Task: [],
  AccountHistory: [{ Id: '017A', Field: 'Name' }],
};

const METADATA: Record<string, string[]> = {
  ApexClass: ['Hello'],
  Profile: ['Admin'],
  Flow: ['Simple'],
  CustomObject: ['Invoice__c'],
};

const FILES: Record<string, Record<string, string>> = {
  ApexClass: {
    'classes/Hello.cls': 'public class Hello { public static String hi() { return "hi"; } }',
    'classes/Hello.cls-meta.xml': '<?xml version="1.0"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>',
  },
  Profile: {
    'profiles/Admin.profile': `<?xml version="1.0"?><Profile xmlns="http://soap.sforce.com/2006/04/metadata">
      <custom>false</custom><userLicense>Salesforce</userLicense>
      <objectPermissions><allowCreate>true</allowCreate><allowDelete>false</allowDelete><allowEdit>true</allowEdit><allowRead>true</allowRead><modifyAllRecords>false</modifyAllRecords><object>Account</object><viewAllRecords>false</viewAllRecords></objectPermissions>
      <fieldPermissions><editable>true</editable><field>Account.Name</field><readable>true</readable></fieldPermissions>
      <userPermissions><enabled>true</enabled><name>ApiEnabled</name></userPermissions>
    </Profile>`,
  },
  Flow: {
    'flows/Simple.flow': `<?xml version="1.0"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata">
      <label>Simple Flow</label><processType>AutoLaunchedFlow</processType><status>Active</status>
      <decisions><name>Check_It</name><label>Check it</label></decisions>
    </Flow>`,
  },
  CustomObject: {
    'objects/Invoice__c.object': `<?xml version="1.0"?><CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
      <label>Invoice</label><pluralLabel>Invoices</pluralLabel>
      <fields><fullName>Amount__c</fullName><label>Amount</label><type>Currency</type><required>false</required></fields>
      <validationRules><fullName>Amount_Positive</fullName><active>true</active><errorConditionFormula>Amount__c &lt; 0</errorConditionFormula><errorMessage>Must be positive</errorMessage></validationRules>
    </CustomObject>`,
  },
};

interface FakeOptions {
  gate?: Promise<void>;
}

function fakeGateway(opts: FakeOptions = {}) {
  const queries: string[] = [];
  const retrieved: string[] = [];
  const project = (rows: Row[], soql: string): Row[] => {
    const cols = /^SELECT (.+?) FROM /.exec(soql)![1].split(',').map((c) => c.trim());
    return rows.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])));
  };
  const gw: SfGateway = {
    apiVersion: '62.0',
    async describeGlobal() {
      const o = (name: string) => ({ name, label: LABELS[name] ?? name, custom: name.endsWith('__c'), queryable: true, deprecatedAndHidden: false });
      return [o('Account'), o('Contact'), o('Invoice__c'), o('Task'), o('AccountHistory'), o('AccountChangeEvent')];
    },
    async describeFields(name) {
      return (FIELDS[name] ?? [{ name: 'Id', label: 'ID', type: 'id' }]).map((f) => ({ ...f }));
    },
    async countRows(name) {
      return (DATA[name] ?? []).length;
    },
    async *queryPages(soql): AsyncGenerator<QueryPage> {
      queries.push(soql);
      if (opts.gate) await opts.gate;
      const name = /FROM (\w+)/.exec(soql)![1];
      const rows = project(DATA[name] ?? [], soql);
      yield { records: rows, totalSize: rows.length };
    },
    async *bulkQueryPages(): AsyncGenerator<QueryPage> {
      yield { records: [], totalSize: 0 };
    },
    async describeMetadataTypes() {
      return Object.keys(METADATA).map((xmlName) => ({ xmlName, inFolder: false }));
    },
    async listMetadata(type) {
      return (METADATA[type] ?? []).map((fullName) => ({ type, fullName, manageableState: 'unmanaged' }));
    },
    async retrieveMetadata(types) {
      const found: string[] = [];
      const files: Record<string, Uint8Array> = { 'package.xml': strToU8('<Package/>') };
      for (const [t, members] of Object.entries(types)) {
        retrieved.push(t);
        for (const m of members) found.push(`${t}/${m}`);
        for (const [path, body] of Object.entries(FILES[t] ?? {})) files[path] = strToU8(body);
      }
      return { zip: Buffer.from(zipSync(files)), found, warnings: [] };
    },
  };
  return { gw, queries, retrieved };
}

async function setup(opts: FakeOptions = {}, label = 'Structure') {
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

async function exportOf(agent: ReturnType<typeof request.agent>, runId: string, body: Record<string, unknown>) {
  const link = await agent.post(`/api/runs/${runId}/download-link`).send({ kind: 'structured', ...body });
  expect(link.status).toBe(200);
  const res = await binary(agent.get(link.body.url));
  return { res, body: res.body as Buffer };
}

async function readWorkbook(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  return wb;
}

const sheetRows = (ws: ExcelJS.Worksheet) => {
  const out: unknown[][] = [];
  ws.eachRow((row) => out.push((row.values as unknown[]).slice(1)));
  return out;
};

async function auditorFor(owner: Awaited<ReturnType<typeof setup>>) {
  const ownerRow = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
  const email = `auditor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  await prisma.user.create({
    data: { email, name: 'Auditor', passwordHash: ownerRow.passwordHash, role: 'AUDITOR', tenantId: owner.user.tenant.id, emailVerifiedAt: new Date() },
  });
  const a = request.agent(app);
  await a.post('/api/auth/login').send({ email, password: 'a-long-test-password' }).expect(200);
  return a;
}

// ---------------------------------------------------------------------------------------------

describe('sections', () => {
  it('puts objects in plain-language groups', () => {
    expect(categoryOfObject('Account')).toBe('data.business');
    expect(categoryOfObject('Opportunity')).toBe('data.business');
    expect(categoryOfObject('Invoice__c')).toBe('data.custom');
    expect(categoryOfObject('Task')).toBe('data.activity');
    expect(categoryOfObject('User')).toBe('data.users');
    expect(categoryOfObject('AccountHistory')).toBe('data.history');
    expect(categoryOfObject('SomethingElse')).toBe('data.system');
  });

  it('puts configuration types in plain-language groups', () => {
    expect(categoryOfMetadataType('ApexClass')).toBe('meta.apex');
    expect(categoryOfMetadataType('Profile')).toBe('meta.security');
    expect(categoryOfMetadataType('Flow')).toBe('meta.automation');
    expect(categoryOfMetadataType('CustomObject')).toBe('meta.schema');
    expect(categoryOfMetadataType('Layout')).toBe('meta.ui');
    expect(categoryOfMetadataType('Report')).toBe('meta.reports');
    expect(categoryOfMetadataType('SomeNewType')).toBe('meta.other');
    expect(categoryOfItem('OBJECT', 'Account')).toBe('data.business');
    expect(categoryOfItem('METADATA', 'ApexClass')).toBe('meta.apex');
  });

  it('has readable labels and valid ids', () => {
    expect(metadataTypeLabel('ApexClass')).toBe('Apex classes');
    expect(metadataTypeLabel('Profile')).toBe('Profiles');
    expect(isCategoryId('data.business')).toBe(true);
    expect(isCategoryId('nope')).toBe(false);
    expect(new Set(CATEGORIES.map((c) => c.id)).size).toBe(CATEGORIES.length);
  });

  it('turns a selection into a plan filter', () => {
    const all = planFilter({});
    expect(all.records).toBe(true);
    expect(all.metadata).toBe(true);
    expect(all.wantsObject).toBeNull();
    expect(all.wantsMetadataType).toBeNull();

    const recordsOnly = planFilter({ includeMetadata: false });
    expect(recordsOnly.metadata).toBe(false);
    expect(recordsOnly.records).toBe(true);

    const cat = planFilter({ categories: ['data.business', 'meta.apex'] });
    expect(cat.wantsObject?.('Account')).toBe(true);
    expect(cat.wantsObject?.('Invoice__c')).toBe(false);
    expect(cat.wantsMetadataType?.('ApexClass')).toBe(true);
    expect(cat.wantsMetadataType?.('Profile')).toBe(false);

    const single = planFilter({ objects: ['Invoice__c'], metadataTypes: ['Flow'] });
    expect(single.wantsObject?.('Invoice__c')).toBe(true);
    expect(single.wantsObject?.('Account')).toBe(false);
    expect(single.wantsMetadataType?.('Flow')).toBe(true);
    expect(single.wantsMetadataType?.('ApexClass')).toBe(false);
  });

  it('cleans up the options stored on a run', () => {
    expect(normalizeOptions()).toMatchObject({ includeMetadata: true, includeRecords: undefined });
    expect(normalizeOptions({ includeRecords: false, categories: ['data.business', 'bogus'], objects: ['A', 'A'] })).toMatchObject({
      includeRecords: false,
      categories: ['data.business'],
      objects: ['A'],
    });
  });
});

describe('choosing what to back up', () => {
  it('lists what can be chosen, grouped, with plain labels', async () => {
    const o = await setup({}, 'Coverage');
    const r = await o.agent.get(`/api/connections/${o.conn.id}/coverage`);
    expect(r.status).toBe(200);
    expect(r.body.categories.length).toBe(CATEGORIES.length);
    const account = r.body.objects.find((x: { name: string }) => x.name === 'Account');
    expect(account).toMatchObject({ label: 'Account', category: 'data.business' });
    expect(r.body.objects.find((x: { name: string }) => x.name === 'Invoice__c').category).toBe('data.custom');
    expect(r.body.objects.map((x: { name: string }) => x.name)).not.toContain('AccountChangeEvent');
    expect(r.body.excludedObjects.map((x: { name: string }) => x.name)).toContain('AccountChangeEvent');
    const apex = r.body.metadataTypes.find((x: { name: string }) => x.name === 'ApexClass');
    expect(apex).toMatchObject({ label: 'Apex classes', category: 'meta.apex' });
    expect(r.body.defaultSelection).toBeNull();
  });

  it('backs up only the records when configuration is switched off', async () => {
    const o = await setup({}, 'RecordsOnly');
    const { detail } = await startAndWait(o.agent, o.conn.id, { includeMetadata: false });
    expect(detail.status).toBe('SUCCEEDED');
    expect(detail.items.every((i: { kind: string }) => i.kind === 'OBJECT')).toBe(true);
    expect(detail.items.length).toBe(5);
    expect(o.fake.retrieved).toHaveLength(0);
  });

  it('backs up only the configuration when records are switched off', async () => {
    const o = await setup({}, 'ConfigOnly');
    const { detail } = await startAndWait(o.agent, o.conn.id, { includeRecords: false });
    expect(detail.items.every((i: { kind: string }) => i.kind === 'METADATA')).toBe(true);
    expect(detail.items.map((i: { name: string }) => i.name).sort()).toEqual(['ApexClass', 'CustomObject', 'Flow', 'Profile']);
    expect(o.fake.queries).toHaveLength(0);
  });

  it('backs up whole groups', async () => {
    const o = await setup({}, 'Groups');
    const { detail } = await startAndWait(o.agent, o.conn.id, { categories: ['data.business', 'meta.apex'] });
    expect(detail.items.map((i: { name: string }) => i.name).sort()).toEqual(['Account', 'ApexClass', 'Contact']);
    expect(detail.status).toBe('SUCCEEDED');
  });

  it('backs up single objects and single types', async () => {
    const o = await setup({}, 'Single');
    const { detail } = await startAndWait(o.agent, o.conn.id, { objects: ['Invoice__c'], metadataTypes: ['Flow'] });
    expect(detail.items.map((i: { name: string }) => i.name).sort()).toEqual(['Flow', 'Invoice__c']);
  });

  it('refuses an empty choice', async () => {
    const o = await setup({}, 'Empty');
    const r = await o.agent.post(`/api/connections/${o.conn.id}/runs`).send({ includeRecords: false, includeMetadata: false });
    expect(r.status).toBe(400);
  });

  it('returns each item with its group and a readable name', async () => {
    const o = await setup({}, 'Detail');
    const { detail } = await startAndWait(o.agent, o.conn.id);
    expect(detail.categories.length).toBe(CATEGORIES.length);
    const by = (n: string) => detail.items.find((i: { name: string }) => i.name === n);
    expect(by('Account').category).toBe('data.business');
    expect(by('ApexClass')).toMatchObject({ category: 'meta.apex', label: 'Apex classes' });
    expect(by('Profile').category).toBe('meta.security');
  });
});

describe('the saved selection for automatic backups', () => {
  it('is saved, used by scheduled runs, and can be reset', async () => {
    const o = await setup({}, 'Saved');
    const put = await o.agent.put(`/api/connections/${o.conn.id}/selection`).send({ selection: { includeMetadata: false, categories: ['data.business'] } });
    expect(put.status).toBe(200);
    expect((await o.agent.get(`/api/connections/${o.conn.id}/coverage`)).body.defaultSelection).toMatchObject({ includeMetadata: false, categories: ['data.business'] });

    const conn = await prisma.orgConnection.findUniqueOrThrow({ where: { id: o.conn.id } });
    const run = await startRun({ connection: conn, userId: null, trigger: 'schedule' });
    const done = await waitForRun(run.id);
    expect(done.status).toBe('SUCCEEDED');
    const items = await prisma.backupItem.findMany({ where: { runId: run.id } });
    expect(items.map((i) => i.name).sort()).toEqual(['Account', 'Contact']);

    // A manual run with its own choice ignores the saved one.
    const { detail } = await startAndWait(o.agent, o.conn.id, { metadataTypes: ['Flow'], includeRecords: false });
    expect(detail.items.map((i: { name: string }) => i.name)).toEqual(['Flow']);

    const reset = await o.agent.put(`/api/connections/${o.conn.id}/selection`).send({ selection: null });
    expect(reset.status).toBe(200);
    expect((await o.agent.get(`/api/connections/${o.conn.id}/coverage`)).body.defaultSelection).toBeNull();
  });

  it('refuses an empty selection and bad input', async () => {
    const o = await setup({}, 'SavedBad');
    expect((await o.agent.put(`/api/connections/${o.conn.id}/selection`).send({ selection: { includeRecords: false, includeMetadata: false } })).status).toBe(400);
    expect((await o.agent.put(`/api/connections/${o.conn.id}/selection`).send({ selection: { objects: ['bad name!'] } })).status).toBe(400);
  });

  it('can only be changed by an owner or admin', async () => {
    const o = await setup({}, 'SavedRole');
    const a = await auditorFor(o);
    expect((await a.put(`/api/connections/${o.conn.id}/selection`).send({ selection: null })).status).toBe(403);
  });

  it('cannot be reached from another organisation', async () => {
    const o = await setup({}, 'SavedA');
    const other = await signUp('SavedB');
    expect((await other.agent.put(`/api/connections/${o.conn.id}/selection`).send({ selection: null })).status).toBe(404);
    expect((await other.agent.get(`/api/connections/${o.conn.id}/coverage`)).status).toBe(404);
  });
});

describe('the readable download', () => {
  it('writes Excel files organised by section, with a summary and a guide', async () => {
    const o = await setup({}, 'Excel');
    const { runId } = await startAndWait(o.agent, o.conn.id);

    const { res, body } = await exportOf(o.agent, runId, { format: 'xlsx' });
    expect(res.headers['content-type']).toContain('application/zip');
    const files = unzipSync(new Uint8Array(body));
    const names = Object.keys(files);
    const root = names[0].split('/')[0];
    expect(root).toMatch(/ backup \d{4}-\d{2}-\d{2}$/);

    expect(names).toContain(`${root}/README.txt`);
    expect(names).toContain(`${root}/00 Summary.xlsx`);
    expect(names).toContain(`${root}/1 Records/1 Sales, Service & Marketing/Sales, Service & Marketing.xlsx`);
    expect(names).toContain(`${root}/1 Records/2 Custom objects/Custom objects.xlsx`);
    expect(names).toContain(`${root}/2 Configuration/2 Security & Access/Security & Access.xlsx`);
    expect(names).toContain(`${root}/2 Configuration/3 Apex Code & Pages/Source code/Apex classes/Hello.cls`.replace('Apex classes', 'Apex Classes'));

    const readme = Buffer.from(files[`${root}/README.txt`]).toString('utf8');
    expect(readme).toContain('WHAT IS IN THIS FOLDER');
    expect(readme).toContain('WHAT A BACKUP DOES NOT INCLUDE');

    // Summary
    const summary = await readWorkbook(Buffer.from(files[`${root}/00 Summary.xlsx`]));
    expect(summary.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(['Index', 'Overview', 'All Items']));
    const overview = sheetRows(summary.getWorksheet('Overview')!).flat().map(String);
    expect(overview).toContain('Organization');
    const all = sheetRows(summary.getWorksheet('All Items')!).map((r) => r.map(String).join('|'));
    expect(all.some((r) => r.includes('Account') && r.includes('Sales, Service & Marketing'))).toBe(true);
    expect(all.some((r) => r.includes('Apex classes'))).toBe(true);

    // Records
    const sales = await readWorkbook(Buffer.from(files[`${root}/1 Records/1 Sales, Service & Marketing/Sales, Service & Marketing.xlsx`]));
    expect(sales.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(['Index', 'Field Guide', 'Account', 'Contact']));
    const acc = sheetRows(sales.getWorksheet('Account')!);
    expect(acc[0]).toEqual(['Account ID', 'Account Name', 'Annual Revenue', 'Active', 'Created Date']);
    expect(acc).toHaveLength(4);
    expect(acc[1][0]).toBe('001A');
    expect(acc[1][2]).toBe(1250.5); // a real number
    expect(acc[1][3]).toBe(true); // a real checkbox value
    expect(acc[1][4]).toBeInstanceOf(Date); // a real date
    expect((acc[1][4] as Date).toISOString()).toBe('2026-03-04T10:20:30.000Z');
    expect(acc[2][1]).toBe('=cmd|calc'); // stored as a text cell, never a formula
    expect(acc[3][1]).toBe('Beta, "Quoted" Ltd');

    const guide = sheetRows(sales.getWorksheet('Field Guide')!).map((r) => r.map(String).join('|'));
    expect(guide.some((r) => r.includes('Annual Revenue') && r.includes('AnnualRevenue') && r.includes('Currency'))).toBe(true);

    // The empty Task object and its history appear only where they belong
    const activity = await readWorkbook(Buffer.from(files[`${root}/1 Records/3 Activities, Files & Collaboration/Activities, Files & Collaboration.xlsx`]));
    const idx = sheetRows(activity.getWorksheet('Index')!).map((r) => r.map(String).join('|'));
    expect(idx.some((r) => r.includes('Task') && r.includes('No records'))).toBe(true);

    // Configuration
    const sec = await readWorkbook(Buffer.from(files[`${root}/2 Configuration/2 Security & Access/Security & Access.xlsx`]));
    expect(sec.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(['Index', 'Types Saved', 'Profiles', 'Profile - Objects', 'Profile - Fields', 'Profile - System Perms']));
    const po = sheetRows(sec.getWorksheet('Profile - Objects')!).map((r) => r.map(String).join('|'));
    expect(po.some((r) => r.includes('Account'))).toBe(true);
    const pf = sheetRows(sec.getWorksheet('Profile - Fields')!).map((r) => r.map(String).join('|'));
    expect(pf.some((r) => r.startsWith('Admin|Account|Name|'))).toBe(true); // Object and Field are separate columns

    const schema = await readWorkbook(Buffer.from(files[`${root}/2 Configuration/1 Objects & Fields/Objects & Fields.xlsx`]));
    expect(schema.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(['Objects', 'Validation Rules']));
    const vr = sheetRows(schema.getWorksheet('Validation Rules')!).map((r) => r.map(String).join('|'));
    expect(vr.some((r) => r.includes('Amount_Positive'))).toBe(true);

    const auto = await readWorkbook(Buffer.from(files[`${root}/2 Configuration/4 Automation & Workflows/Automation & Workflows.xlsx`]));
    expect(auto.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(['Flows', 'Flow Steps']));

    const apex = Buffer.from(files[`${root}/2 Configuration/3 Apex Code & Pages/Source code/Apex Classes/Hello.cls`]).toString('utf8');
    expect(apex).toContain('public class Hello');
  });

  it('can show Salesforce API names as the column headings', async () => {
    const o = await setup({}, 'ApiHeaders');
    const { runId } = await startAndWait(o.agent, o.conn.id);
    const { body } = await exportOf(o.agent, runId, { format: 'xlsx', headers: 'api', category: 'data.business' });
    const wb = await readWorkbook(body);
    expect(sheetRows(wb.getWorksheet('Account')!)[0]).toEqual(['Id', 'Name', 'AnnualRevenue', 'IsActive__c', 'CreatedDate']);
  });

  it('writes CSV files with a byte-order mark so Excel reads accents correctly', async () => {
    const o = await setup({}, 'Csv');
    const { runId } = await startAndWait(o.agent, o.conn.id);
    const { res, body } = await exportOf(o.agent, runId, { format: 'csv' });
    expect(res.headers['content-type']).toContain('application/zip');
    const files = unzipSync(new Uint8Array(body));
    const names = Object.keys(files);
    const root = names[0].split('/')[0];
    expect(names).toContain(`${root}/README.txt`);
    expect(names.some((n) => n.startsWith(`${root}/00 Summary/`))).toBe(true);
    const accountCsv = names.find((n) => n.startsWith(`${root}/1 Records/1 Sales, Service & Marketing/`) && /Account\.csv$/.test(n));
    expect(accountCsv).toBeTruthy();
    const raw = Buffer.from(files[accountCsv!]);
    expect(raw.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const text = raw.toString('utf8').replace(/^﻿/, '');
    expect(text.split('\r\n')[0]).toBe('Account ID,Account Name,Annual Revenue,Active,Created Date');
    expect(text).toContain('"Beta, ""Quoted"" Ltd"');
    expect(text).toContain("'=cmd|calc");
  });

  it('gives a single group as one plain file, without folders', async () => {
    const o = await setup({}, 'OneGroup');
    const { runId } = await startAndWait(o.agent, o.conn.id);
    const { res, body } = await exportOf(o.agent, runId, { format: 'xlsx', category: 'data.custom' });
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('.xlsx');
    const wb = await readWorkbook(body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(['Index', 'Field Guide', 'Invoice']));
    expect(sheetRows(wb.getWorksheet('Invoice')!)[0]).toEqual(['Record ID', 'Invoice Number']);
  });

  it('gives a single item as one file', async () => {
    const o = await setup({}, 'OneItem');
    const { runId, detail } = await startAndWait(o.agent, o.conn.id);
    const contact = detail.items.find((i: { name: string }) => i.name === 'Contact');
    const { res, body } = await exportOf(o.agent, runId, { format: 'csv', itemId: contact.id });
    expect(res.headers['content-type']).toContain('zip');
    const files = unzipSync(new Uint8Array(body));
    const contactCsv = Object.keys(files).find((n) => /Contact\.csv$/.test(n));
    expect(contactCsv).toBeTruthy();
    expect(Object.keys(files).some((n) => n.endsWith('README.txt'))).toBe(false);
    expect(Buffer.from(files[contactCsv!]).toString('utf8')).toContain('Smith');
  });

  it('only includes the groups that were backed up', async () => {
    const o = await setup({}, 'Partial');
    const { runId } = await startAndWait(o.agent, o.conn.id, { includeMetadata: false, categories: ['data.custom'] });
    const { body } = await exportOf(o.agent, runId, { format: 'xlsx' });
    const names = Object.keys(unzipSync(new Uint8Array(body)));
    expect(names.some((n) => n.includes('/2 Configuration/'))).toBe(false);
    expect(names.some((n) => n.includes('/1 Records/2 Custom objects/'))).toBe(true);
    expect(names.some((n) => n.includes('/1 Records/1 Sales'))).toBe(false);
    const readme = Buffer.from(names.length ? unzipSync(new Uint8Array(body))[names.find((n) => n.endsWith('README.txt'))!] : []).toString('utf8');
    expect(readme).not.toContain('2 Configuration');
  });

  it('is refused while the backup is still running', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const o = await setup({ gate }, 'Running');
    const res = await o.agent.post(`/api/connections/${o.conn.id}/runs`).send({ includeMetadata: false });
    expect(res.status).toBe(202);
    const r = await o.agent.post(`/api/runs/${res.body.run.id}/download-link`).send({ kind: 'structured' });
    expect(r.status).toBe(409);
    release();
    await waitForRun(res.body.run.id);
    expect((await o.agent.post(`/api/runs/${res.body.run.id}/download-link`).send({ kind: 'structured' })).status).toBe(200);
  });

  it('rejects an unknown group', async () => {
    const o = await setup({}, 'BadGroup');
    const { runId } = await startAndWait(o.agent, o.conn.id, { includeMetadata: false });
    expect((await o.agent.post(`/api/runs/${runId}/download-link`).send({ kind: 'structured', category: 'data.nope' })).status).toBe(400);
  });

  it('is not available to an Auditor, nor across organisations, nor with a bad link', async () => {
    const o = await setup({}, 'Guard');
    const { runId } = await startAndWait(o.agent, o.conn.id, { includeMetadata: false });
    const a = await auditorFor(o);
    expect((await a.post(`/api/runs/${runId}/download-link`).send({ kind: 'structured' })).status).toBe(403);

    const other = await signUp('GuardOther');
    expect((await other.agent.post(`/api/runs/${runId}/download-link`).send({ kind: 'structured' })).status).toBe(404);

    expect((await request(app).get('/api/downloads/not-a-token')).status).toBe(403);
  });

  it('records who downloaded what in the audit log', async () => {
    const o = await setup({}, 'Audit');
    const { runId } = await startAndWait(o.agent, o.conn.id, { includeMetadata: false });
    await o.agent.post(`/api/runs/${runId}/download-link`).send({ kind: 'structured', format: 'csv', category: 'data.custom' });
    const log = await o.agent.get('/api/audit');
    expect(log.body.entries.some((e: { action: string; detail: string }) => e.action === 'backup.export-link' && e.detail.includes('csv'))).toBe(true);
  });

  it('still offers the raw archive', async () => {
    const o = await setup({}, 'Raw');
    const { runId } = await startAndWait(o.agent, o.conn.id, { includeMetadata: false });
    const link = await o.agent.post(`/api/runs/${runId}/download-link`).send({});
    expect(link.status).toBe(200);
    const res = await binary(o.agent.get(link.body.url));
    const files = unzipSync(new Uint8Array(res.body as Buffer));
    expect(Object.keys(files).some((n) => n.endsWith('.jsonl.gz'))).toBe(true);
  });
});

describe('file safety', () => {
  it('stops spreadsheet programs running text as a formula', () => {
    for (const s of ['=1+1', '+1', '-1', '@SUM(A1)']) expect(neutraliseFormula(s)).toBe(`'${s}`);
    expect(neutraliseFormula('plain')).toBe('plain');
    expect(neutraliseFormula('')).toBe('');
  });

  it('quotes CSV cells properly', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12.5)).toBe('12.5');
  });
});
