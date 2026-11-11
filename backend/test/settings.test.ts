import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, makeConnection, resetDb, signUp } from './helpers.js';
import { prisma } from '../src/db.js';
import { purgeTenant } from '../src/backup/retention.js';
import { getStorage, runRelDir } from '../src/backup/storage.js';

beforeAll(async () => {
  await resetDb();
});

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000);

const goodSettings = {
  name: 'Acme Inc',
  timeZone: 'Asia/Kolkata',
  retentionDays: 90,
  defaultScheduleHours: 24,
  alertOnFailure: true,
  alertEmail: 'ops@example.com',
  sessionHours: 12,
};

/** Adds a teammate with a given role to an owner's company, through a real invitation. */
async function addMember(owner: Awaited<ReturnType<typeof signUp>>, role: 'ADMIN' | 'VIEWER' | 'OWNER' | 'AUDITOR') {
  const email = `member-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const inv = await owner.agent.post('/api/team/invites').send({ email, role });
  expect(inv.status).toBe(201);
  const token = String(inv.body.link).split('/join/')[1]!;
  const agent = request.agent(app);
  const acc = await agent.post('/api/auth/accept-invite').send({ token, name: 'Member', password: 'a-long-test-password' });
  expect(acc.status).toBe(201);
  return { agent, email, id: acc.body.user.id as string, token };
}

describe('settings', () => {
  it('everyone can read, only the owner can change, and bad values are refused', async () => {
    const owner = await signUp('SettingsCo');
    const viewer = await addMember(owner, 'VIEWER');

    const read = await viewer.agent.get('/api/settings');
    expect(read.status).toBe(200);
    expect(read.body.settings.timeZone).toBe('UTC');
    expect(read.body.timeZones).toContain('Asia/Kolkata');
    expect(read.body.emailConfigured).toBe(false);

    expect((await viewer.agent.put('/api/settings').send(goodSettings)).status).toBe(403);

    expect((await owner.agent.put('/api/settings').send({ ...goodSettings, timeZone: 'Mars/Base' })).status).toBe(400);
    expect((await owner.agent.put('/api/settings').send({ ...goodSettings, retentionDays: 0 })).status).toBe(400);
    expect((await owner.agent.put('/api/settings').send({ ...goodSettings, alertEmail: 'nope' })).status).toBe(400);

    const ok = await owner.agent.put('/api/settings').send(goodSettings);
    expect(ok.status).toBe(200);
    expect((await viewer.agent.get('/api/settings')).body.settings).toMatchObject({ timeZone: 'Asia/Kolkata', retentionDays: 90, sessionHours: 12 });
    const log = await prisma.auditLog.findMany({ where: { tenantId: owner.user.tenant.id, action: 'settings.updated' } });
    expect(log).toHaveLength(1);
  });

  it('a newly connected org gets the default schedule, and "apply" updates the existing ones', async () => {
    const owner = await signUp('ScheduleCo');
    const conn = await makeConnection(owner.user.tenant.id);
    await owner.agent.put('/api/settings').send({ ...goodSettings, defaultScheduleHours: 12 }).expect(200);
    const r = await owner.agent.post('/api/settings/apply-schedule');
    expect(r.body.updated).toBe(1);
    const row = await prisma.orgConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(row.scheduleHours).toBe(12);
    expect(row.nextRunAt).not.toBeNull();
  });

  it('sign-in length follows the setting', async () => {
    const owner = await signUp('SessionCo');
    await owner.agent.put('/api/settings').send({ ...goodSettings, sessionHours: 2 }).expect(200);
    const login = await request(app).post('/api/auth/login').send({ email: owner.email, password: 'a-long-test-password' });
    const cookie = String(login.headers['set-cookie']);
    const expires = /Expires=([^;]+)/i.exec(cookie)?.[1];
    const ms = new Date(expires!).getTime() - Date.now();
    expect(ms).toBeGreaterThan(1.9 * 3600 * 1000);
    expect(ms).toBeLessThan(2.1 * 3600 * 1000);
  });
});

describe('team and invitations', () => {
  it('only the owner invites; the link works once; the new person gets the invited role', async () => {
    const owner = await signUp('TeamCo');
    const admin = await addMember(owner, 'ADMIN');
    expect((await admin.agent.post('/api/team/invites').send({ email: 'x@example.com', role: 'VIEWER' })).status).toBe(403);

    const member = await addMember(owner, 'VIEWER');
    const me = await member.agent.get('/api/auth/me');
    expect(me.body.user.role).toBe('VIEWER');
    expect(me.body.user.tenant.id).toBe(owner.user.tenant.id);

    // The same link cannot be used again.
    const again = await request(app).post('/api/auth/accept-invite').send({ token: member.token, name: 'Again', password: 'a-long-test-password' });
    expect(again.status).toBe(404);
    expect((await request(app).get(`/api/auth/invite/${member.token}`)).status).toBe(404);

    const team = await owner.agent.get('/api/team');
    expect(team.body.users).toHaveLength(3);
    expect(JSON.stringify(team.body)).not.toContain('passwordHash');
  });

  it('refuses an existing email, an expired link and a made-up link; the token is stored hashed', async () => {
    const owner = await signUp('InviteRules');
    expect((await owner.agent.post('/api/team/invites').send({ email: owner.email, role: 'ADMIN' })).status).toBe(409);

    const inv = await owner.agent.post('/api/team/invites').send({ email: 'late@example.com', role: 'ADMIN' });
    const token = String(inv.body.link).split('/join/')[1]!;
    const row = await prisma.invite.findFirstOrThrow({ where: { email: 'late@example.com' } });
    expect(row.tokenHash).not.toContain(token);

    expect((await request(app).get(`/api/auth/invite/${token}`)).body).toMatchObject({ email: 'late@example.com', role: 'ADMIN' });
    await prisma.invite.update({ where: { id: row.id }, data: { expiresAt: daysAgo(1) } });
    expect((await request(app).get(`/api/auth/invite/${token}`)).status).toBe(404);
    expect((await request(app).get('/api/auth/invite/not-a-real-token-at-all')).status).toBe(404);
  });

  it('can switch a person off (they are locked out at once) and back on, and keeps one owner', async () => {
    const owner = await signUp('SwitchCo');
    const m = await addMember(owner, 'ADMIN');
    expect((await m.agent.get('/api/auth/me')).status).toBe(200);

    expect((await owner.agent.patch(`/api/team/users/${m.id}`).send({ active: false })).status).toBe(200);
    expect((await m.agent.get('/api/auth/me')).status).toBe(401);
    const login = await request(app).post('/api/auth/login').send({ email: m.email, password: 'a-long-test-password' });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe('account_disabled');

    await owner.agent.patch(`/api/team/users/${m.id}`).send({ active: true }).expect(200);
    expect((await m.agent.get('/api/auth/me')).status).toBe(200);

    // You cannot change yourself. A second owner can demote the first; roles apply at once.
    expect((await owner.agent.patch(`/api/team/users/${owner.user.id}`).send({ role: 'VIEWER' })).status).toBe(400);
    const second = await addMember(owner, 'OWNER');
    expect((await second.agent.patch(`/api/team/users/${owner.user.id}`).send({ role: 'VIEWER' })).status).toBe(200);
    expect((await owner.agent.patch(`/api/team/users/${second.id}`).send({ role: 'VIEWER' })).status).toBe(403); // owner is now a viewer
    expect((await second.agent.patch(`/api/team/users/${second.id}`).send({ active: false })).status).toBe(400); // not yourself
  });

  it('cannot reach another company\'s people', async () => {
    const a = await signUp('CompanyA');
    const b = await signUp('CompanyB');
    expect((await a.agent.patch(`/api/team/users/${b.user.id}`).send({ active: false })).status).toBe(404);
    expect((await b.agent.get('/api/auth/me')).status).toBe(200);
  });

  it('changes the password only with the right current one', async () => {
    const owner = await signUp('PwCo');
    expect((await owner.agent.post('/api/auth/password').send({ currentPassword: 'wrong-password-123', newPassword: 'another-long-password' })).status).toBe(400);
    expect((await owner.agent.post('/api/auth/password').send({ currentPassword: 'a-long-test-password', newPassword: 'short' })).status).toBe(400);
    await owner.agent.post('/api/auth/password').send({ currentPassword: 'a-long-test-password', newPassword: 'another-long-password' }).expect(200);
    await request(app).post('/api/auth/login').send({ email: owner.email, password: 'another-long-password' }).expect(200);
    expect((await request(app).post('/api/auth/login').send({ email: owner.email, password: 'a-long-test-password' })).status).toBe(401);
  });
});

describe('dashboard', () => {
  it('shows only this company, with counts, totals and things that need attention', async () => {
    const a = await signUp('DashA');
    const b = await signUp('DashB');
    const good = await makeConnection(a.user.tenant.id, { label: 'Good org' });
    const broken = await makeConnection(a.user.tenant.id, { label: 'Broken org', status: 'NEEDS_RECONNECT' });
    const failing = await makeConnection(a.user.tenant.id, { label: 'Failing org' });
    await makeConnection(b.user.tenant.id, { label: 'Other company org' });
    const run = (connectionId: string, status: 'SUCCEEDED' | 'FAILED', tenantId = a.user.tenant.id) =>
      prisma.backupRun.create({ data: { tenantId, connectionId, status, createdAt: daysAgo(1), startedAt: daysAgo(1), finishedAt: daysAgo(1), message: status === 'FAILED' ? 'Boom' : null } });
    const r1 = await run(good.id, 'SUCCEEDED');
    await run(failing.id, 'FAILED');
    await prisma.backupItem.create({ data: { runId: r1.id, tenantId: a.user.tenant.id, kind: 'OBJECT', name: 'Account', status: 'SUCCEEDED', rowCount: 10, bytes: 2048 } });

    const d = (await a.agent.get('/api/dashboard')).body;
    expect(d.totals).toMatchObject({ orgs: 3, connected: 2, bytes: 2048, rows: 10 });
    expect(d.last30Days).toMatchObject({ SUCCEEDED: 1, FAILED: 1 });
    expect(d.orgs.map((o: { label: string }) => o.label).sort()).toEqual(['Broken org', 'Failing org', 'Good org']);
    expect(JSON.stringify(d)).not.toContain('Other company org');
    const kinds = Object.fromEntries(d.attention.map((x: { connectionId: string; kind: string }) => [x.connectionId, x.kind]));
    expect(kinds[broken.id]).toBe('reconnect');
    expect(kinds[failing.id]).toBe('failed');
    expect(kinds[good.id]).toBeUndefined();
    expect(d.recentRuns).toHaveLength(2);
  });

  it('flags a scheduled org whose backups have stopped arriving', async () => {
    const o = await signUp('DashOverdue');
    const c = await makeConnection(o.user.tenant.id, { scheduleHours: 24, nextRunAt: new Date(Date.now() + 3600_000) });
    await prisma.backupRun.create({ data: { tenantId: o.user.tenant.id, connectionId: c.id, status: 'SUCCEEDED', createdAt: daysAgo(5), finishedAt: daysAgo(5) } });
    const d = (await o.agent.get('/api/dashboard')).body;
    expect(d.attention).toMatchObject([{ kind: 'overdue', connectionId: c.id }]);
    expect(d.nextScheduled.connectionId).toBe(c.id);
  });

  it('needs a login', async () => {
    expect((await request(app).get('/api/dashboard')).status).toBe(401);
  });
});

describe('retention', () => {
  it('removes old finished backups but keeps the newest good one, running ones and recent ones', async () => {
    const o = await signUp('RetentionCo');
    const tenantId = o.user.tenant.id;
    const c = await makeConnection(tenantId);
    const mk = (status: 'SUCCEEDED' | 'FAILED' | 'RUNNING', age: number) =>
      prisma.backupRun.create({ data: { tenantId, connectionId: c.id, status, createdAt: daysAgo(age), finishedAt: status === 'RUNNING' ? null : daysAgo(age) } });
    const oldGood = await mk('SUCCEEDED', 200);
    await mk('SUCCEEDED', 100);
    const oldFailed = await mk('FAILED', 150);
    const recent = await mk('SUCCEEDED', 5);
    const running = await mk('RUNNING', 300);
    await prisma.backupItem.create({ data: { runId: oldGood.id, tenantId, kind: 'OBJECT', name: 'Account', status: 'SUCCEEDED', bytes: 500 } });

    const preview = await o.agent.get('/api/settings/retention-preview').query({ days: 30 });
    expect(preview.body).toEqual({ runs: 3, bytes: 500, legalHold: false }); // the 200, 150 and 100 day old ones; `recent` is the newest good one

    expect(await purgeTenant(tenantId, 30)).toBe(3);
    const left = (await prisma.backupRun.findMany({ where: { tenantId } })).map((r) => r.id).sort();
    expect(left).toEqual([recent.id, running.id].sort());
    expect(await prisma.backupItem.count({ where: { runId: oldGood.id } })).toBe(0);
  });

  it('never deletes the only good backup of an org, however old', async () => {
    const o = await signUp('RetentionKeep');
    const tenantId = o.user.tenant.id;
    const c = await makeConnection(tenantId);
    const only = await prisma.backupRun.create({ data: { tenantId, connectionId: c.id, status: 'SUCCEEDED', createdAt: daysAgo(400), finishedAt: daysAgo(400) } });
    expect(await purgeTenant(tenantId, 30)).toBe(0);
    expect(await prisma.backupRun.findUnique({ where: { id: only.id } })).not.toBeNull();
  });
});

/** A finished backup with a real file on disk, so deletion can be checked. */
async function backupWithFile(o: Awaited<ReturnType<typeof signUp>>, ageDays = 1, connection?: Awaited<ReturnType<typeof makeConnection>>) {
  const tenantId = o.user.tenant.id;
  const c = connection ?? (await makeConnection(tenantId));
  const run = await prisma.backupRun.create({ data: { tenantId, connectionId: c.id, status: 'SUCCEEDED', createdAt: daysAgo(ageDays), finishedAt: daysAgo(ageDays) } });
  const rel = `${runRelDir(tenantId, c.id, run.id)}/objects/Account.jsonl.gz`;
  await getStorage().writeFile(rel, 'x');
  await prisma.backupItem.create({ data: { runId: run.id, tenantId, kind: 'OBJECT', name: 'Account', status: 'SUCCEEDED', bytes: 1, filePath: rel } });
  return { c, run, rel };
}

describe('legal hold', () => {
  it('only the owner can set it, and a reason is required', async () => {
    const owner = await signUp('HoldCo');
    const admin = await addMember(owner, 'ADMIN');
    expect((await admin.agent.put('/api/settings/legal-hold').send({ enabled: true, reason: 'x' })).status).toBe(403);
    expect((await owner.agent.put('/api/settings/legal-hold').send({ enabled: true })).status).toBe(400);
    const on = await owner.agent.put('/api/settings/legal-hold').send({ enabled: true, reason: 'Case 42' });
    expect(on.status).toBe(200);
    expect(on.body.settings).toMatchObject({ legalHold: true, legalHoldReason: 'Case 42' });
    expect((await owner.agent.get('/api/settings')).body.settings.legalHold).toBe(true);
    const off = await owner.agent.put('/api/settings/legal-hold').send({ enabled: false });
    expect(off.body.settings).toMatchObject({ legalHold: false, legalHoldReason: null });
    const log = (await prisma.auditLog.findMany({ where: { tenantId: owner.user.tenant.id } })).map((l) => l.action);
    expect(log).toEqual(expect.arrayContaining(['legalhold.on', 'legalhold.off']));
  });

  it('freezes retention and every deletion until it is switched off', async () => {
    const o = await signUp('HoldFreeze');
    const old = await backupWithFile(o, 200);
    await backupWithFile(o, 1, old.c); // a newer good backup of the same org, so the old one is expired
    await o.agent.put('/api/settings/legal-hold').send({ enabled: true, reason: 'Audit' }).expect(200);

    expect(await purgeTenant(o.user.tenant.id, 30)).toBe(0);
    expect((await o.agent.get('/api/settings/retention-preview').query({ days: 30 })).body).toEqual({ runs: 0, bytes: 0, legalHold: true });
    expect(await getStorage().fileSize(old.rel)).toBe(1);

    const wipe = await o.agent.post('/api/settings/delete-backups').send({ confirm: 'HoldFreeze Inc' });
    expect(wipe.status).toBe(409);
    expect(wipe.body.code).toBe('legal_hold');
    const del = await o.agent.delete('/api/settings/tenant').send({ confirm: 'HoldFreeze Inc', password: 'a-long-test-password' });
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('legal_hold');
    expect(await prisma.tenant.count({ where: { id: o.user.tenant.id } })).toBe(1);

    await o.agent.put('/api/settings/legal-hold').send({ enabled: false }).expect(200);
    expect(await purgeTenant(o.user.tenant.id, 30)).toBe(1);
  });
});

describe('deleting company data', () => {
  it('deletes all backups and files after the company name is typed, and keeps the account', async () => {
    const o = await signUp('WipeCo');
    const b = await backupWithFile(o);
    await prisma.objectCheckpoint.create({ data: { tenantId: o.user.tenant.id, connectionId: b.c.id, objectName: 'Account', watermark: new Date(), lastFilePath: b.rel, lastFullAt: new Date() } });
    const viewer = await addMember(o, 'VIEWER');
    expect((await viewer.agent.post('/api/settings/delete-backups').send({ confirm: 'WipeCo Inc' })).status).toBe(403);

    expect((await o.agent.post('/api/settings/delete-backups').send({ confirm: 'wrong name' })).status).toBe(400);
    expect(await prisma.backupRun.count({ where: { tenantId: o.user.tenant.id } })).toBe(1);

    const ok = await o.agent.post('/api/settings/delete-backups').send({ confirm: 'WipeCo Inc' });
    expect(ok.status).toBe(200);
    expect(ok.body.deleted).toBe(1);
    expect(await prisma.backupRun.count({ where: { tenantId: o.user.tenant.id } })).toBe(0);
    expect(await prisma.backupItem.count({ where: { tenantId: o.user.tenant.id } })).toBe(0);
    expect(await prisma.objectCheckpoint.count({ where: { tenantId: o.user.tenant.id } })).toBe(0);
    expect(await getStorage().fileSize(b.rel)).toBeNull();
    expect(await prisma.orgConnection.count({ where: { tenantId: o.user.tenant.id } })).toBe(1);
    expect((await o.agent.get('/api/settings')).status).toBe(200);
  });

  it('refuses while a backup is running', async () => {
    const o = await signUp('WipeBusy');
    const c = await makeConnection(o.user.tenant.id);
    await prisma.backupRun.create({ data: { tenantId: o.user.tenant.id, connectionId: c.id, status: 'RUNNING' } });
    const r = await o.agent.post('/api/settings/delete-backups').send({ confirm: 'WipeBusy Inc' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('run_active');
  });

  it('removes the whole company only with the right name and password, and leaves other companies alone', async () => {
    const o = await signUp('GoneCo');
    const other = await signUp('StaysCo');
    const mine = await backupWithFile(o);
    const theirs = await backupWithFile(other);
    const member = await addMember(o, 'ADMIN');
    expect((await member.agent.delete('/api/settings/tenant').send({ confirm: 'GoneCo Inc', password: 'a-long-test-password' })).status).toBe(403);

    expect((await o.agent.delete('/api/settings/tenant').send({ confirm: 'GoneCo', password: 'a-long-test-password' })).status).toBe(400);
    expect((await o.agent.delete('/api/settings/tenant').send({ confirm: 'GoneCo Inc', password: 'wrong-password-123' })).status).toBe(400);
    expect(await prisma.tenant.count({ where: { id: o.user.tenant.id } })).toBe(1);

    const ok = await o.agent.delete('/api/settings/tenant').send({ confirm: 'GoneCo Inc', password: 'a-long-test-password' });
    expect(ok.status).toBe(200);
    expect(await prisma.tenant.count({ where: { id: o.user.tenant.id } })).toBe(0);
    expect(await prisma.user.count({ where: { tenantId: o.user.tenant.id } })).toBe(0);
    expect(await prisma.backupRun.count({ where: { tenantId: o.user.tenant.id } })).toBe(0);
    expect(await getStorage().fileSize(mine.rel)).toBeNull();
    // The session is gone, and the other company is untouched.
    expect((await o.agent.get('/api/settings')).status).toBe(401);
    expect(await getStorage().fileSize(theirs.rel)).toBe(1);
    expect(await prisma.backupRun.count({ where: { tenantId: other.user.tenant.id } })).toBe(1);
    const tomb = await prisma.auditLog.findFirst({ where: { action: 'tenant.deleted', tenantId: null } });
    expect(tomb?.target).toBe(o.user.tenant.id);
  });
});

describe('auditor role', () => {
  it('can be invited and can read, but cannot change anything', async () => {
    const owner = await signUp('AuditCo');
    const aud = await addMember(owner, 'AUDITOR');
    expect((await aud.agent.get('/api/settings')).status).toBe(200);
    expect((await aud.agent.get('/api/team')).status).toBe(200);
    expect((await aud.agent.put('/api/settings').send(goodSettings)).status).toBe(403);
    expect((await aud.agent.post('/api/team/invites').send({ email: 'z@example.com', role: 'VIEWER' })).status).toBe(403);
    expect((await aud.agent.put('/api/settings/legal-hold').send({ enabled: true, reason: 'x' })).status).toBe(403);
    expect((await owner.agent.patch(`/api/team/users/${aud.id}`).send({ role: 'VIEWER' })).status).toBe(200);
    expect((await owner.agent.patch(`/api/team/users/${aud.id}`).send({ role: 'AUDITOR' })).status).toBe(200);
  });
});
