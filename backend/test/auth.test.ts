import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, resetDb, resetDbEmpty, signUp } from './helpers.js';
import { prisma } from '../src/db.js';

beforeAll(resetDb);

describe('first account is the platform admin', () => {
  it('makes only the very first account the platform admin', async () => {
    await resetDbEmpty();
    const first = await signUp('First');
    const second = await signUp('Second');
    expect((await first.agent.get('/api/auth/me')).body.user.isPlatformAdmin).toBe(true);
    expect((await second.agent.get('/api/auth/me')).body.user.isPlatformAdmin).toBe(false);
    // and the admin can reach the platform screen, the customer cannot
    expect((await first.agent.get('/api/platform/salesforce')).status).toBe(200);
    expect((await second.agent.get('/api/platform/salesforce')).status).toBe(403);
  });

  it('still gives only one admin when two people sign up at the same moment', async () => {
    await resetDbEmpty();
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        request(app)
          .post('/api/auth/register')
          .send({ workspaceName: `Race ${n} Co`, name: `R${n}`, email: `race${n}-${Date.now()}@example.com`, password: 'a-long-test-password' }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(results.filter((r) => r.body.user.isPlatformAdmin).length).toBe(1);
    await resetDb(); // back to a normal state for the other tests
  });
});

describe('sign up and sign in', () => {
  it('creates a workspace and logs the owner in', async () => {
    const { agent, email } = await signUp('Alpha');
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.user.role).toBe('OWNER');
    expect(me.body.user.isPlatformAdmin).toBe(false);
  });

  it('never stores the password in plain text', async () => {
    const { email } = await signUp('Beta');
    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(row.passwordHash).not.toContain('a-long-test-password');
    expect(row.passwordHash.startsWith('$2')).toBe(true);
  });

  it('refuses a duplicate email', async () => {
    const { email } = await signUp('Gamma');
    const res = await request(app)
      .post('/api/auth/register')
      .send({ workspaceName: 'Other Co', name: 'X', email, password: 'another-long-password' });
    expect(res.status).toBe(409);
  });

  it('refuses a short password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ workspaceName: 'Short Co', name: 'X', email: 'short@example.com', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('logs in with the right password only', async () => {
    const { email } = await signUp('Delta');
    const bad = await request(app).post('/api/auth/login').send({ email, password: 'wrong-password-123' });
    expect(bad.status).toBe(401);
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password-123' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe(bad.body.error); // same message: does not reveal which emails exist
    const agent = request.agent(app);
    const ok = await agent.post('/api/auth/login').send({ email, password: 'a-long-test-password' });
    expect(ok.status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
  });

  it('logout ends the session', async () => {
    const { agent } = await signUp('Epsilon');
    await agent.post('/api/auth/logout').expect(200);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('protects private routes and blocks other-site posts', async () => {
    expect((await request(app).get('/api/connections')).status).toBe(401);
    expect((await request(app).get('/api/runs')).status).toBe(401);
    const { agent } = await signUp('Zeta');
    const res = await agent.post('/api/auth/logout').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });
});
