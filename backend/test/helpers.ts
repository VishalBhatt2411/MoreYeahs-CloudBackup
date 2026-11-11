import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { encrypt } from '../src/lib/crypto.js';

export const app = createApp();
export const CLIENT_ID = '3MVG9validclientid1234567890';
export const CLIENT_SECRET = 'valid-secret-abcdefghij-0123456789';

/** Empties every table. The next account to register becomes the platform admin. */
export async function resetDbEmpty() {
  await prisma.auditLog.deleteMany();
  await prisma.oAuthState.deleteMany();
  await prisma.backupItem.deleteMany();
  await prisma.backupRun.deleteMany();
  await prisma.orgConnection.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
  await prisma.salesforceAppConfig.deleteMany();
}

/**
 * Empties every table, then adds one platform admin, like a running install.
 * So accounts made by signUp() are normal customers.
 */
export async function resetDb() {
  await resetDbEmpty();
  await prisma.tenant.create({
    data: {
      name: 'Platform owner',
      users: { create: { email: 'platform-seed@example.com', name: 'Seed', passwordHash: 'x', role: 'OWNER', isPlatformAdmin: true } },
    },
  });
}

let counter = 0;
/** Registers a new customer (own workspace) and returns a logged-in agent. */
export async function signUp(label = 'Acme') {
  const agent = request.agent(app);
  const email = `user${++counter}-${Date.now()}@example.com`;
  const res = await agent
    .post('/api/auth/register')
    .send({ workspaceName: `${label} Inc`, name: label, email, password: 'a-long-test-password' });
  if (res.status !== 201 && res.status !== 200) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, email, user: res.body.user as { id: string; tenant: { id: string } } };
}

export async function makePlatformAdmin() {
  const s = await signUp('Platform');
  await prisma.user.update({ where: { id: s.user.id }, data: { isPlatformAdmin: true } });
  return s;
}

export async function saveAppCredentials() {
  await prisma.salesforceAppConfig.upsert({
    where: { id: 'default' },
    create: { id: 'default', clientId: CLIENT_ID, clientSecretEnc: encrypt(CLIENT_SECRET) },
    update: { clientId: CLIENT_ID, clientSecretEnc: encrypt(CLIENT_SECRET) },
  });
}

export async function makeConnection(tenantId: string, overrides: Record<string, unknown> = {}) {
  return prisma.orgConnection.create({
    data: {
      tenantId,
      label: 'Test org',
      environment: 'SANDBOX',
      loginUrl: 'http://localhost:54399',
      instanceUrl: 'http://localhost:54399',
      sfOrgId: `00D${Math.random().toString(36).slice(2, 14)}`,
      sfUserId: '005000000000001AAA',
      username: 'admin@example.com',
      orgName: 'Test org',
      refreshTokenEnc: encrypt('fake-refresh-token'),
      ...overrides,
    },
  });
}

/** A tiny pretend Salesforce login server. */
export function startFakeSalesforce(port = 54399): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url.pathname === '/services/oauth2/token') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const p = new URLSearchParams(raw);
        if (p.get('client_id') !== CLIENT_ID) return send(400, { error: 'invalid_client_id', error_description: 'client identifier invalid' });
        if (p.get('client_secret') !== CLIENT_SECRET) return send(400, { error: 'invalid_client', error_description: 'invalid client credentials' });
        if (p.get('grant_type') === 'refresh_token') {
          if (p.get('refresh_token') === 'revoked-token') return send(400, { error: 'invalid_grant', error_description: 'expired access/refresh token' });
          return send(200, { access_token: 'fake-access', instance_url: `http://localhost:${port}` });
        }
        if (p.get('code') === 'good-code') {
          if (!p.get('code_verifier')) return send(400, { error: 'invalid_grant', error_description: 'missing code verifier' });
          return send(200, {
            access_token: 'fake-access',
            refresh_token: 'fake-refresh-from-code',
            instance_url: `http://localhost:${port}`,
            id: `http://localhost:${port}/id/00DAAAAAAAAAAAA/005BBBBBBBBBBBB`,
          });
        }
        return send(400, { error: 'invalid_grant', error_description: 'authentication failure' });
      });
      return;
    }
    if (url.pathname === '/id/00DAAAAAAAAAAAA/005BBBBBBBBBBBB') {
      return send(200, { organization_id: '00DAAAAAAAAAAAA', user_id: '005BBBBBBBBBBBB', username: 'owner@example.com.dev' });
    }
    if (url.pathname === '/services/data/') return send(200, [{ version: '60.0' }, { version: '62.0' }]);
    if (url.pathname.endsWith('/query')) return send(200, { records: [{ Name: 'Fake Org Inc' }] });
    if (url.pathname === '/services/oauth2/revoke') return send(200, {});
    send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
