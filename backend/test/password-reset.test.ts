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
const NEW_PASSWORD = 'brand-new-password-9';

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

async function setup(label: string) {
  await resetDb();
  const admin = await makePlatformAdmin();
  expect((await admin.agent.put('/api/platform/email').send(smtp)).status).toBe(200);
  const s = await signUp(label);
  return s;
}

const tokenFrom = (m: Record<string, any>) => /\/reset\/([0-9a-f]{64})/.exec(String(m.text))![1]!;

async function ask(email: string) {
  return request(app).post('/api/auth/forgot-password').send({ email });
}

describe('forgot password', () => {
  it('emails a one-time link and lets the person choose a new password', async () => {
    const s = await setup('Forgot');
    const r = await ask(s.email);
    expect(r.status).toBe(200);
    const msg = await waitFor(async () => mail.sent[0]);
    expect(msg.to).toBe(s.email);
    expect(msg.subject).toMatch(/reset/i);
    const token = tokenFrom(msg);

    // Only the hash is stored.
    const rows = await prisma.passwordReset.findMany({ where: { userId: s.user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(JSON.stringify(rows)).not.toContain(token);

    expect((await request(app).get(`/api/auth/reset/${token}`)).body.email).toBe(s.email);
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: 'short' })).status).toBe(400);

    const done = await request(app).post('/api/auth/reset-password').send({ token, password: NEW_PASSWORD });
    expect(done.status).toBe(200);

    // New password works, the old one does not.
    expect((await request(app).post('/api/auth/login').send({ email: s.email, password: NEW_PASSWORD })).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email: s.email, password: 'a-long-test-password' })).status).toBe(401);

    // The link works once.
    const again = await request(app).post('/api/auth/reset-password').send({ token, password: 'another-new-password-1' });
    expect(again.status).toBe(404);
    expect((await request(app).get(`/api/auth/reset/${token}`)).status).toBe(404);
    expect((await prisma.auditLog.findMany({ where: { userId: s.user.id } })).map((a) => a.action)).toEqual(
      expect.arrayContaining(['auth.password.reset.requested', 'auth.password.reset']),
    );
  });

  it('does not reveal whether an email has an account', async () => {
    const s = await setup('Enum');
    const known = await ask(s.email);
    const unknown = await ask('nobody-here@example.com');
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    await waitFor(async () => mail.sent.length > 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe(s.email);
    expect((await ask('not-an-email')).status).toBe(400);
  });

  it('signs out logins that existed before the reset', async () => {
    const s = await setup('Signout');
    expect((await s.agent.get('/api/auth/me')).status).toBe(200);
    await ask(s.email);
    const token = tokenFrom(await waitFor(async () => mail.sent[0]));
    // Make sure the reset lands in a later second than the login.
    await new Promise((r) => setTimeout(r, 1100));
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: NEW_PASSWORD })).status).toBe(200);
    expect((await s.agent.get('/api/auth/me')).status).toBe(401);
    // A login made after the reset works.
    const fresh = request.agent(app);
    expect((await fresh.post('/api/auth/login').send({ email: s.email, password: NEW_PASSWORD })).status).toBe(200);
    expect((await fresh.get('/api/auth/me')).status).toBe(200);
  });

  it('refuses an expired link, and a newer reset ends the older links', async () => {
    const s = await setup('Expire');
    await ask(s.email);
    const token = tokenFrom(await waitFor(async () => mail.sent[0]));
    await prisma.passwordReset.updateMany({ where: { userId: s.user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).get(`/api/auth/reset/${token}`)).status).toBe(404);
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: NEW_PASSWORD })).status).toBe(404);

    // Two links asked for: using one kills the other.
    await prisma.passwordReset.deleteMany({ where: { userId: s.user.id } });
    await ask(s.email);
    const first = tokenFrom(await waitFor(async () => mail.sent[1]));
    await prisma.passwordReset.updateMany({ where: { userId: s.user.id }, data: { createdAt: new Date(Date.now() - 5 * 60 * 1000) } });
    await ask(s.email);
    const second = tokenFrom(await waitFor(async () => mail.sent[2]));
    expect(second).not.toBe(first);
    expect((await request(app).post('/api/auth/reset-password').send({ token: second, password: NEW_PASSWORD })).status).toBe(200);
    expect((await request(app).post('/api/auth/reset-password').send({ token: first, password: 'other-password-123' })).status).toBe(404);
  });

  it('sends at most one email a minute for the same account', async () => {
    const s = await setup('Cooldown');
    await ask(s.email);
    await waitFor(async () => mail.sent.length > 0);
    await ask(s.email);
    await ask(s.email);
    await new Promise((r) => setTimeout(r, 300));
    expect(mail.sent).toHaveLength(1);
    expect(await prisma.passwordReset.count({ where: { userId: s.user.id } })).toBe(1);
  });

  it('sends nothing to a switched-off account, and its old link stops working', async () => {
    const s = await setup('Off');
    await ask(s.email);
    const token = tokenFrom(await waitFor(async () => mail.sent[0]));
    await prisma.user.update({ where: { id: s.user.id }, data: { active: false } });
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: NEW_PASSWORD })).status).toBe(404);
    mail.sent.length = 0;
    await prisma.passwordReset.deleteMany({ where: { userId: s.user.id } });
    expect((await ask(s.email)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(mail.sent).toHaveLength(0);
  });

  it('says so plainly when email is not set up, and survives a mail failure', async () => {
    await resetDb();
    const s = await signUp('NoMail');
    const none = await ask(s.email);
    expect(none.status).toBe(409);
    expect(none.body.error).toMatch(/not set up/i);
    expect(none.body.code).toBe('email_not_configured');

    const admin = await makePlatformAdmin();
    await admin.agent.put('/api/platform/email').send(smtp);
    mail.fail = true;
    const r = await ask(s.email);
    // Still the same answer as for any request: the failure is not shown to the asker.
    expect(r.status).toBe(200);
    await new Promise((x) => setTimeout(x, 300));
    expect(mail.sent).toHaveLength(0);
  });
});
