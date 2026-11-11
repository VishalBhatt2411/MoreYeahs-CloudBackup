import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app, makeConnection, makePlatformAdmin, resetDb, signUp } from './helpers.js';
import { prisma } from '../src/db.js';
import { sendRunAlert } from '../src/backup/alerts.js';
import { waitForRun } from '../src/backup/runner.js';
import { setGatewayFactory } from '../src/salesforce/gateway.js';

// A pretend mail server: remembers every message, and can be told to refuse.
const mail = vi.hoisted(() => ({ sent: [] as Record<string, any>[], fail: null as null | { code?: string; message: string; responseCode?: number } }));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (m: Record<string, any>) => {
        if (mail.fail) throw Object.assign(new Error(mail.fail.message), mail.fail);
        mail.sent.push(m);
        return { messageId: 'x' };
      },
    }),
  },
}));

const smtp = { host: 'smtp.example.com', port: 587, secure: false, username: 'mailer', password: 'mail-pass-123', fromEmail: 'alerts@example.com', fromName: 'CloudBackup' };

beforeAll(resetDb);
beforeEach(() => {
  mail.sent.length = 0;
  mail.fail = null;
});
afterEach(() => setGatewayFactory(null));

async function configureMail(admin: Awaited<ReturnType<typeof makePlatformAdmin>>) {
  const r = await admin.agent.put('/api/platform/email').send(smtp);
  expect(r.status).toBe(200);
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A run that fails because Salesforce no longer accepts the login. */
async function failingRun(s: Awaited<ReturnType<typeof signUp>>) {
  const conn = await makeConnection(s.user.tenant.id, { label: 'Prod Org' });
  setGatewayFactory(async () => {
    throw new Error('invalid_grant: expired access/refresh token');
  });
  const res = await s.agent.post(`/api/connections/${conn.id}/runs`).send({});
  expect(res.status).toBe(202);
  const run = await waitForRun(res.body.run.id);
  return { run, conn };
}

describe('email settings (platform admin)', () => {
  it('only the platform admin can see or change them, and the password is never shown', async () => {
    await resetDb();
    const customer = await signUp('NotAdmin');
    expect((await customer.agent.get('/api/platform/email')).status).toBe(403);
    expect((await customer.agent.put('/api/platform/email').send(smtp)).status).toBe(403);

    const admin = await makePlatformAdmin();
    expect((await admin.agent.get('/api/platform/email')).body.configured).toBe(false);
    expect((await admin.agent.put('/api/platform/email').send({ ...smtp, host: '' })).status).toBe(400);
    expect((await admin.agent.put('/api/platform/email').send({ ...smtp, fromEmail: 'nope' })).status).toBe(400);
    // A user name without a password is refused the first time.
    expect((await admin.agent.put('/api/platform/email').send({ ...smtp, password: undefined })).status).toBe(400);

    await configureMail(admin);
    const read = await admin.agent.get('/api/platform/email');
    expect(read.body).toMatchObject({ configured: true, host: 'smtp.example.com', port: 587, username: 'mailer', passwordSaved: true });
    expect(JSON.stringify(read.body)).not.toContain('mail-pass-123');
    const row = await prisma.emailConfig.findUniqueOrThrow({ where: { id: 'default' } });
    expect(row.passwordEnc).toBeTruthy();
    expect(row.passwordEnc).not.toContain('mail-pass-123');

    // Saving again without a password keeps the saved one.
    expect((await admin.agent.put('/api/platform/email').send({ ...smtp, password: undefined, port: 465, secure: true })).status).toBe(200);
    expect((await admin.agent.get('/api/platform/email')).body.passwordSaved).toBe(true);
  });

  it('the test button sends to the admin, and explains a refusal', async () => {
    await resetDb();
    const admin = await makePlatformAdmin();
    expect((await admin.agent.post('/api/platform/email/test')).status).toBe(409);
    await configureMail(admin);

    const ok = await admin.agent.post('/api/platform/email/test');
    expect(ok.body.ok).toBe(true);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe(admin.email);

    mail.fail = { code: 'EAUTH', message: 'Invalid login', responseCode: 535 };
    const bad = await admin.agent.post('/api/platform/email/test');
    expect(bad.body.ok).toBe(false);
    expect(bad.body.message).toMatch(/user name or password/i);
  });
});

describe('failure alerts', () => {
  it('emails the owner when a backup fails, once, with the reason and a link', async () => {
    await resetDb();
    await configureMail(await makePlatformAdmin());
    const s = await signUp('AlertCo');
    const { run } = await failingRun(s);
    expect(run.status).toBe('FAILED');

    const log = await waitFor(() => prisma.alertLog.findUnique({ where: { runId: run.id } }).then((l) => (l && l.status !== 'PENDING' ? l : null)));
    expect(log.status).toBe('SENT');
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toEqual([s.email]);
    expect(mail.sent[0]!.subject).toMatch(/Reconnect needed: Prod Org/);
    expect(mail.sent[0]!.text).toMatch(/reconnect/i);

    // Asking again for the same run does not send a second email.
    await sendRunAlert(run.id);
    expect(mail.sent).toHaveLength(1);
    expect((await s.agent.get('/api/settings')).body.recentAlerts[0]).toMatchObject({ runId: run.id, status: 'SENT' });
  });

  it('goes to the alert address when one is set, and not at all when alerts are off', async () => {
    await resetDb();
    await configureMail(await makePlatformAdmin());
    const s = await signUp('Routing');
    const base = { name: 'Routing Inc', timeZone: 'UTC', retentionDays: null, defaultScheduleHours: null, sessionHours: 24 };
    expect((await s.agent.put('/api/settings').send({ ...base, alertOnFailure: true, alertEmail: 'ops@example.com' })).status).toBe(200);
    const first = await failingRun(s);
    await waitFor(() => prisma.alertLog.findUnique({ where: { runId: first.run.id } }).then((l) => (l && l.status === 'SENT' ? l : null)));
    expect(mail.sent[0]!.to).toEqual(['ops@example.com']);

    mail.sent.length = 0;
    expect((await s.agent.put('/api/settings').send({ ...base, alertOnFailure: false, alertEmail: 'ops@example.com' })).status).toBe(200);
    await prisma.orgConnection.update({ where: { id: first.conn.id }, data: { status: 'ACTIVE' } });
    const res = await s.agent.post(`/api/connections/${first.conn.id}/runs`).send({});
    const run2 = await waitForRun(res.body.run.id);
    expect(run2.status).toBe('FAILED');
    await new Promise((r) => setTimeout(r, 300));
    expect(mail.sent).toHaveLength(0);
    expect(await prisma.alertLog.findUnique({ where: { runId: run2.id } })).toBeNull();
  });

  it('does nothing (and does not break) when email is not set up', async () => {
    await resetDb();
    const s = await signUp('NoMail');
    const { run } = await failingRun(s);
    expect(run.status).toBe('FAILED');
    await new Promise((r) => setTimeout(r, 300));
    expect(mail.sent).toHaveLength(0);
    expect(await prisma.alertLog.count({ where: { runId: run.id } })).toBe(0);
  });

  it('records a mail failure honestly and the backup result stays FAILED', async () => {
    await resetDb();
    await configureMail(await makePlatformAdmin());
    mail.fail = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' };
    const s = await signUp('BadMail');
    const { run } = await failingRun(s);
    const log = await waitFor(() => prisma.alertLog.findUnique({ where: { runId: run.id } }).then((l) => (l && l.status !== 'PENDING' ? l : null)));
    expect(log.status).toBe('FAILED');
    expect(log.detail).toMatch(/refused the connection/i);
    expect((await prisma.backupRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('FAILED');
  });

  it('the owner can send a test alert; others cannot; it needs mail set up', async () => {
    await resetDb();
    const s = await signUp('TestAlert');
    expect((await s.agent.post('/api/settings/test-alert')).status).toBe(409);
    await configureMail(await makePlatformAdmin());
    const ok = await s.agent.post('/api/settings/test-alert');
    expect(ok.body.ok).toBe(true);
    expect(mail.sent[0]!.to).toEqual([s.email]);

    const inv = await s.agent.post('/api/team/invites').send({ email: 'viewer@example.com', role: 'VIEWER' });
    const viewer = request.agent(app);
    await viewer.post('/api/auth/accept-invite').send({ token: String(inv.body.link).split('/join/')[1], name: 'V', password: 'a-long-test-password' });
    expect((await viewer.post('/api/settings/test-alert')).status).toBe(403);
  });
});

describe('invitation email', () => {
  it('emails the link when mail is set up, and still returns it', async () => {
    await resetDb();
    const owner = await signUp('InviteMail');
    const before = await owner.agent.post('/api/team/invites').send({ email: 'one@example.com', role: 'ADMIN' });
    expect(before.body.emailed).toBe(false);
    expect(before.body.link).toContain('/join/');

    await configureMail(await makePlatformAdmin());
    const r = await owner.agent.post('/api/team/invites').send({ email: 'two@example.com', role: 'VIEWER' });
    expect(r.status).toBe(201);
    expect(r.body.emailed).toBe(true);
    expect(mail.sent[0]!.to).toBe('two@example.com');
    expect(mail.sent[0]!.text).toContain(r.body.link);

    mail.fail = { code: 'EAUTH', message: 'bad login', responseCode: 535 };
    const bad = await owner.agent.post('/api/team/invites').send({ email: 'three@example.com', role: 'VIEWER' });
    expect(bad.status).toBe(201);
    expect(bad.body.emailed).toBe(false);
    expect(bad.body.emailError).toMatch(/user name or password/i);
    expect(bad.body.link).toContain('/join/');
  });
});
