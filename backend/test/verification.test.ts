import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app, makePlatformAdmin, resetDb, signUp } from './helpers.js';
import { prisma } from '../src/db.js';

// A pretend mail server: remembers every message, and can be told to refuse.
const mail = vi.hoisted(() => ({ sent: [] as Record<string, any>[], fail: false }));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (m: Record<string, any>) => {
        if (mail.fail) throw Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 });
        mail.sent.push(m);
        return { messageId: 'x' };
      },
    }),
  },
}));

const smtp = { host: 'smtp.example.com', port: 587, secure: false, username: 'mailer', password: 'mail-pass-123', fromEmail: 'alerts@example.com', fromName: 'CloudBackup' };
const PASSWORD = 'a-long-test-password';

beforeAll(resetDb);
beforeEach(() => {
  mail.sent.length = 0;
  mail.fail = false;
});

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function withMail() {
  await resetDb();
  const admin = await makePlatformAdmin();
  expect((await admin.agent.put('/api/platform/email').send(smtp)).status).toBe(200);
  mail.sent.length = 0;
  return admin;
}

let n = 0;
async function register(label: string) {
  const email = `verify${++n}-${Date.now()}@example.com`;
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/register').send({ workspaceName: `${label} Inc`, name: label, email, password: PASSWORD });
  return { agent, email, res };
}

const tokenFrom = (m: Record<string, any>) => /\/verify\/([0-9a-f]{64})/.exec(String(m.text))![1]!;

describe('email verification at sign-up', () => {
  it('holds the account until the emailed link is opened', async () => {
    await withMail();
    const { agent, email, res } = await register('Verify');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ verificationRequired: true, email });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await agent.get('/api/auth/me')).status).toBe(401);

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe(email);
    expect(mail.sent[0]!.subject).toMatch(/confirm/i);
    const token = tokenFrom(mail.sent[0]!);

    // The right password is not enough yet, and the answer says why.
    const early = await agent.post('/api/auth/login').send({ email, password: PASSWORD });
    expect(early.status).toBe(403);
    expect(early.body.code).toBe('email_not_verified');
    // A wrong password does not reveal that the account exists but is unconfirmed.
    expect((await agent.post('/api/auth/login').send({ email, password: 'wrong-password-123' })).status).toBe(401);

    // Only the hash of the token is stored.
    const rows = await prisma.emailVerification.findMany({ where: { user: { email } } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);

    const ok = await request(app).post('/api/auth/verify-email').send({ token });
    expect(ok.status).toBe(200);
    // The link alone gives no session.
    expect(ok.headers['set-cookie']).toBeUndefined();

    const login = await agent.post('/api/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    expect((await prisma.auditLog.findMany({ where: { userId: login.body.user.id } })).map((a) => a.action)).toEqual(
      expect.arrayContaining(['auth.verify.sent', 'auth.verified']),
    );
  });

  it('works once, and an expired or made-up link is refused', async () => {
    await withMail();
    const a = await register('Once');
    const token = tokenFrom(mail.sent[0]!);
    expect((await request(app).post('/api/auth/verify-email').send({ token })).status).toBe(200);
    const again = await request(app).post('/api/auth/verify-email').send({ token });
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('verify_invalid');
    expect((await request(app).post('/api/auth/verify-email').send({ token: 'f'.repeat(64) })).status).toBe(404);

    const b = await register('Expired');
    const expired = tokenFrom(mail.sent[1]!);
    await prisma.emailVerification.updateMany({ where: { user: { email: b.email } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).post('/api/auth/verify-email').send({ token: expired })).status).toBe(404);
    expect((await b.agent.post('/api/auth/login').send({ email: b.email, password: PASSWORD })).status).toBe(403);
    expect(a.email).not.toBe(b.email);
  });

  it('can send a new link, at most one a minute, and never reveals which emails exist', async () => {
    await withMail();
    const { email } = await register('Resend');
    const old = tokenFrom(mail.sent[0]!);
    const ask = (e: string) => request(app).post('/api/auth/resend-verification').send({ email: e });

    // Right after sign-up the cooldown still applies.
    expect((await ask(email)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(mail.sent).toHaveLength(1);

    await prisma.emailVerification.updateMany({ where: { user: { email } }, data: { createdAt: new Date(Date.now() - 5 * 60 * 1000) } });
    const known = await ask(email);
    const unknown = await ask('nobody-here@example.com');
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    await waitFor(async () => mail.sent.length > 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[1]!.to).toBe(email);

    // Either link confirms the account.
    const fresh = tokenFrom(mail.sent[1]!);
    expect(fresh).not.toBe(old);
    expect((await request(app).post('/api/auth/verify-email').send({ token: fresh })).status).toBe(200);

    // A confirmed account gets nothing more.
    await prisma.emailVerification.updateMany({ where: { user: { email } }, data: { createdAt: new Date(Date.now() - 5 * 60 * 1000) } });
    await ask(email);
    await new Promise((r) => setTimeout(r, 200));
    expect(mail.sent).toHaveLength(2);
    expect((await ask('not-an-email')).status).toBe(400);
  });

  it('does not block sign-up when email is not set up, nor the platform admin', async () => {
    await resetDb();
    const none = await register('NoMailYet');
    expect(none.res.status).toBe(201);
    expect(none.res.body.verificationRequired).toBeUndefined();
    expect((await none.agent.get('/api/auth/me')).status).toBe(200);
    const ask = await request(app).post('/api/auth/resend-verification').send({ email: none.email });
    expect(ask.status).toBe(409);
    expect(ask.body.code).toBe('email_not_configured');

    // The first account on a fresh install is the platform admin and is never made to wait for mail.
    await resetDb();
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const first = await register('First');
    expect(first.res.body.verificationRequired).toBeUndefined();
    expect(first.res.body.user.isPlatformAdmin).toBe(true);
  });

  it('still creates the account when the mail server refuses, and the person can ask again', async () => {
    await withMail();
    mail.fail = true;
    const { email, res } = await register('MailDown');
    expect(res.status).toBe(201);
    expect(res.body.verificationRequired).toBe(true);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    mail.fail = false;
    await prisma.emailVerification.deleteMany({ where: { user: { email } } });
    await request(app).post('/api/auth/resend-verification').send({ email });
    const msg = await waitFor(async () => mail.sent[0]);
    expect((await request(app).post('/api/auth/verify-email').send({ token: tokenFrom(msg) })).status).toBe(200);
  });

  it('choosing a new password by reset also confirms the email', async () => {
    await withMail();
    const { email, agent } = await register('ResetConfirms');
    mail.sent.length = 0;
    await request(app).post('/api/auth/forgot-password').send({ email });
    const msg = await waitFor(async () => mail.sent[0]);
    const token = /\/reset\/([0-9a-f]{64})/.exec(String(msg.text))![1]!;
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: 'brand-new-password-9' })).status).toBe(200);
    expect((await agent.post('/api/auth/login').send({ email, password: 'brand-new-password-9' })).status).toBe(200);
  });
});

async function addMember(owner: Awaited<ReturnType<typeof signUp>>, role: 'ADMIN' | 'VIEWER' | 'AUDITOR', label: string) {
  const email = `member-${label.toLowerCase()}-${++n}-${Date.now()}@example.com`;
  const inv = await owner.agent.post('/api/team/invites').send({ email, role });
  expect(inv.status).toBe(201);
  const agent = request.agent(app);
  const acc = await agent.post('/api/auth/accept-invite').send({ token: String(inv.body.link).split('/join/')[1], name: label, password: PASSWORD });
  expect(acc.status).toBeLessThan(300);
  return { agent, email, id: acc.body.user.id as string };
}

describe('owner-started password reset for a team member', () => {
  async function setup(label: string) {
    await withMail();
    const owner = await signUp(label);
    mail.sent.length = 0;
    return owner;
  }

  it('emails the member a reset link and records it; the old password keeps working until it is used', async () => {
    const owner = await setup('OwnerReset');
    const member = await addMember(owner, 'VIEWER', 'Vee');
    mail.sent.length = 0;
    const r = await owner.agent.post(`/api/team/users/${member.id}/reset-password`);
    expect(r.status).toBe(200);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe(member.email);
    const token = /\/reset\/([0-9a-f]{64})/.exec(String(mail.sent[0]!.text))![1]!;
    expect((await request(app).post('/api/auth/login').send({ email: member.email, password: PASSWORD })).status).toBe(200);

    expect((await request(app).post('/api/auth/reset-password').send({ token, password: 'brand-new-password-9' })).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email: member.email, password: 'brand-new-password-9' })).status).toBe(200);
    const log = (await prisma.auditLog.findMany({ where: { tenantId: owner.user.tenant.id } })).map((l) => l.action);
    expect(log).toContain('team.reset.sent');
  });

  it('is for the owner only, and only for an active person in the same company', async () => {
    const owner = await setup('OnlyOwner');
    const admin = await addMember(owner, 'ADMIN', 'Adi');
    const viewer = await addMember(owner, 'VIEWER', 'Vee');
    mail.sent.length = 0;
    expect((await admin.agent.post(`/api/team/users/${viewer.id}/reset-password`)).status).toBe(403);
    expect((await viewer.agent.post(`/api/team/users/${admin.id}/reset-password`)).status).toBe(403);

    expect((await owner.agent.post(`/api/team/users/${owner.user.id}/reset-password`)).status).toBe(400);
    expect((await owner.agent.post('/api/team/users/does-not-exist/reset-password')).status).toBe(404);
    // Someone in another company cannot be reached.
    const other = await signUp('OtherCo');
    mail.sent.length = 0; // signing up sent its own confirmation email
    expect((await owner.agent.post(`/api/team/users/${other.user.id}/reset-password`)).status).toBe(404);

    await prisma.user.update({ where: { id: viewer.id }, data: { active: false } });
    expect((await owner.agent.post(`/api/team/users/${viewer.id}/reset-password`)).status).toBe(400);
    expect(mail.sent).toHaveLength(0);
  });

  it('says plainly when email is off, and when the mail server refuses', async () => {
    const owner = await setup('MailOff');
    const member = await addMember(owner, 'VIEWER', 'Vee');
    mail.sent.length = 0;
    mail.fail = true;
    const bad = await owner.agent.post(`/api/team/users/${member.id}/reset-password`);
    expect(bad.status).toBe(502);
    expect(bad.body.error).toMatch(/user name or password/i);

    mail.fail = false;
    await prisma.emailConfig.deleteMany();
    const off = await owner.agent.post(`/api/team/users/${member.id}/reset-password`);
    expect(off.status).toBe(409);
    expect(off.body.code).toBe('email_not_configured');
  });
});
