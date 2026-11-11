import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  app,
  CLIENT_ID,
  CLIENT_SECRET,
  fakeSf,
  makeConnection,
  makePlatformAdmin,
  resetDb,
  saveAppCredentials,
  signUp,
  startFakeSalesforce,
} from './helpers.js';
import { realGatewayFactory } from '../src/salesforce/gateway.js';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { SalesforceAuthError, explainSfAuthError } from '../src/salesforce/oauth.js';
import { decrypt, encrypt } from '../src/lib/crypto.js';

let sf: Server;
beforeAll(async () => {
  await resetDb();
  sf = await startFakeSalesforce();
});
afterAll(() => new Promise<void>((r) => sf.close(() => r())));

type Agent = ReturnType<typeof request.agent>;

describe('platform admin: saving the Salesforce app details', () => {
  it('only the platform admin can open or change them', async () => {
    const { agent } = await signUp('Customer');
    expect((await agent.get('/api/platform/salesforce')).status).toBe(403);
    expect((await agent.put('/api/platform/salesforce').send({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })).status).toBe(403);
  });

  it('saves encrypted, never returns the secret, and can be tested', async () => {
    const { agent } = await makePlatformAdmin();
    const before = await agent.get('/api/platform/salesforce');
    expect(before.body.configured).toBe(false);
    expect(before.body.callbackUrl).toBe('http://localhost:5173/api/oauth/salesforce/callback');

    const saved = await agent.put('/api/platform/salesforce').send({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(saved.status).toBe(200);

    const after = await agent.get('/api/platform/salesforce');
    expect(after.body.configured).toBe(true);
    expect(after.body.clientId).toBe(CLIENT_ID);
    expect(JSON.stringify(after.body)).not.toContain(CLIENT_SECRET);

    const row = await prisma.salesforceAppConfig.findUniqueOrThrow({ where: { id: 'default' } });
    expect(row.clientSecretEnc).not.toContain(CLIENT_SECRET);
    expect(decrypt(row.clientSecretEnc)).toBe(CLIENT_SECRET);

    expect((await agent.post('/api/platform/salesforce/test')).body.ok).toBe(true);

    // Changing only the Client ID keeps the saved secret.
    await agent.put('/api/platform/salesforce').send({ clientId: 'bad-client-id-0000000' });
    const bad = await agent.post('/api/platform/salesforce/test');
    expect(bad.body.ok).toBe(false);
    expect(bad.body.message).toMatch(/Client ID/);
    await agent.put('/api/platform/salesforce').send({ clientId: CLIENT_ID });
    expect((await agent.post('/api/platform/salesforce/test')).body.ok).toBe(true);
  });

  it('the test names the exact callback address when Salesforce has a different one saved', async () => {
    const { agent } = await makePlatformAdmin();
    await agent.put('/api/platform/salesforce').send({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    fakeSf.savedCallbackUrl = 'https://login.salesforce.com/services/oauth2/success';
    try {
      const r = await agent.post('/api/platform/salesforce/test');
      expect(r.body.ok).toBe(false);
      expect(r.body.code).toBe('redirect_uri_mismatch');
      expect(r.body.message).toContain('http://localhost:5173/api/oauth/salesforce/callback');
    } finally {
      fakeSf.savedCallbackUrl = config.oauthCallbackUrl;
    }
    expect((await agent.post('/api/platform/salesforce/test')).body.ok).toBe(true);
  });

  it('explains the vague "retry your request" reply from Salesforce', () => {
    const msg = explainSfAuthError(new SalesforceAuthError('unknown_error', 'retry your request'));
    expect(msg).toMatch(/10 minutes/);
  });

  it('customers can see whether connecting is set up, but nothing more', async () => {
    const { agent } = await signUp('Customer2');
    const r = await agent.get('/api/salesforce/status');
    expect(r.body).toEqual({ configured: true });
  });
});

describe('customer connects a Salesforce org (login flow)', () => {
  async function begin(agent: Agent) {
    const start = await agent.post('/api/oauth/salesforce/start').send({ environment: 'SANDBOX', label: 'My sandbox' });
    expect(start.status).toBe(200);
    const url = new URL(start.body.authorizeUrl);
    return { url, state: url.searchParams.get('state')! };
  }

  it('sends the customer to the Salesforce login with PKCE and a one-time state', async () => {
    await saveAppCredentials();
    const { agent } = await signUp('Connect1');
    const { url } = await begin(agent);
    expect(url.pathname).toBe('/services/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/api/oauth/salesforce/callback');
    expect(url.searchParams.get('scope')).toContain('refresh_token');
    expect(url.searchParams.get('client_secret')).toBeNull();
  });

  it('saves the org with an encrypted refresh token, and the state works only once', async () => {
    const { agent, user } = await signUp('Connect2');
    const { state } = await begin(agent);
    const cb = await agent.get('/api/oauth/salesforce/callback').query({ code: 'good-code', state });
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toMatch(/\/orgs\?connected=/);

    const rows = await prisma.orgConnection.findMany({ where: { tenantId: user.tenant.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe('owner@example.com.dev');
    expect(rows[0].orgName).toBe('Fake Org Inc');
    expect(rows[0].status).toBe('ACTIVE');
    expect(rows[0].refreshTokenEnc).not.toContain('fake-refresh-from-code');
    expect(decrypt(rows[0].refreshTokenEnc)).toBe('fake-refresh-from-code');

    const list = await agent.get('/api/connections');
    expect(list.body.connections).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('refresh');

    const again = await agent.get('/api/oauth/salesforce/callback').query({ code: 'good-code', state });
    expect(again.headers.location).toMatch(/sf_error=/);
    expect(await prisma.orgConnection.count({ where: { tenantId: user.tenant.id } })).toBe(1);
  });

  it('rejects a callback from a different signed-in user', async () => {
    const a = await signUp('Victim');
    const b = await signUp('Attacker');
    const { state } = await begin(a.agent);
    const cb = await b.agent.get('/api/oauth/salesforce/callback').query({ code: 'good-code', state });
    expect(cb.headers.location).toMatch(/sf_error=/);
    expect(await prisma.orgConnection.count({ where: { tenantId: a.user.tenant.id } })).toBe(0);
    expect(await prisma.orgConnection.count({ where: { tenantId: b.user.tenant.id } })).toBe(0);
  });

  it('rejects an unknown state and shows Salesforce errors in plain English', async () => {
    const { agent } = await signUp('Connect3');
    const bad = await agent.get('/api/oauth/salesforce/callback').query({ code: 'good-code', state: 'made-up' });
    expect(bad.headers.location).toMatch(/sf_error=/);
    const { state } = await begin(agent);
    const denied = await agent
      .get('/api/oauth/salesforce/callback')
      .query({ error: 'access_denied', error_description: 'end-user denied authorization', state });
    expect(denied.headers.location).toMatch(/sf_error=/);
  });

  it('a read-only user cannot start a connection', async () => {
    const owner = await signUp('Connect4');
    const viewerEmail = `viewer-${Date.now()}@example.com`;
    const ownerRow = await prisma.user.findFirstOrThrow({ where: { id: owner.user.id } });
    await prisma.user.create({
      data: { email: viewerEmail, name: 'Viewer', passwordHash: ownerRow.passwordHash, role: 'VIEWER', tenantId: owner.user.tenant.id, emailVerifiedAt: new Date() },
    });
    const v = request.agent(app);
    await v.post('/api/auth/login').send({ email: viewerEmail, password: 'a-long-test-password' }).expect(200);
    expect((await v.post('/api/oauth/salesforce/start').send({ environment: 'SANDBOX', label: 'x' })).status).toBe(403);
  });

  it('health check, disconnect and reconnect-needed states', async () => {
    const { agent, user } = await signUp('Connect5');
    const { state } = await begin(agent);
    await agent.get('/api/oauth/salesforce/callback').query({ code: 'good-code', state });
    const conn = (await agent.get('/api/connections')).body.connections[0];

    expect((await agent.post(`/api/connections/${conn.id}/check`)).body.ok).toBe(true);

    // The refresh token gets revoked in Salesforce.
    await prisma.orgConnection.update({ where: { id: conn.id }, data: { refreshTokenEnc: encrypt('revoked-token') } });
    const bad = await agent.post(`/api/connections/${conn.id}/check`);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.connection.status).toBe('NEEDS_RECONNECT');

    expect((await agent.delete(`/api/connections/${conn.id}`)).status).toBe(200);
    const row = await prisma.orgConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(row.status).toBe('DISCONNECTED');
    expect(row.refreshTokenEnc).toBe('');
    const log = await prisma.auditLog.findMany({ where: { tenantId: user.tenant.id } });
    expect(log.map((a) => a.action)).toEqual(expect.arrayContaining(['org.connected', 'org.disconnect']));
  });

  it('keeps working when Salesforce rotates the refresh token on every renewal', async () => {
    await saveAppCredentials();
    const { agent, user } = await signUp('Rotation');
    fakeSf.rotate = true;
    fakeSf.currentRefresh = 'rotating-0';
    fakeSf.rotations = 0;
    try {
      const c = await makeConnection(user.tenant.id, { refreshTokenEnc: encrypt('rotating-0') });
      // Before the fix the second renewal failed: the old token had been cancelled.
      for (let i = 0; i < 3; i++) {
        expect((await agent.post(`/api/connections/${c.id}/check`)).body.ok).toBe(true);
      }
      // The backup's own login renewal uses the newest token too.
      await realGatewayFactory(await prisma.orgConnection.findUniqueOrThrow({ where: { id: c.id } }));
      await realGatewayFactory(await prisma.orgConnection.findUniqueOrThrow({ where: { id: c.id } }));
      const row = await prisma.orgConnection.findUniqueOrThrow({ where: { id: c.id } });
      expect(decrypt(row.refreshTokenEnc)).toBe(fakeSf.currentRefresh);
      expect(fakeSf.rotations).toBe(5);
    } finally {
      fakeSf.rotate = false;
    }
  });
});
