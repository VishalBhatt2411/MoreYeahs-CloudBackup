import { createHash, randomBytes } from 'node:crypto';
import type { Environment } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';

/**
 * The shared "MoreYeahs CloudBackup" Connected App.
 * Its Client ID / Secret are entered once by the platform admin inside the app and kept
 * encrypted in the database. Customers never see or type them.
 */
export interface AppCredentials {
  clientId: string;
  clientSecret: string;
}

export async function getAppCredentials(): Promise<AppCredentials | null> {
  const row = await prisma.salesforceAppConfig.findUnique({ where: { id: 'default' } });
  if (!row) return null;
  return { clientId: row.clientId, clientSecret: decrypt(row.clientSecretEnc) };
}

export async function requireAppCredentials(): Promise<AppCredentials> {
  const creds = await getAppCredentials();
  if (!creds) {
    throw new HttpError(
      409,
      'Salesforce connection is not set up yet. Ask the platform administrator to add the Salesforce app details first.',
      'sf_not_configured',
    );
  }
  return creds;
}

export const loginUrlFor = (environment: Environment) => config.loginUrls[environment];

export function makePkce() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function newState() {
  return randomBytes(24).toString('base64url');
}

export function buildAuthorizeUrl(args: {
  environment: Environment;
  clientId: string;
  state: string;
  challenge: string;
}) {
  const url = new URL(`${loginUrlFor(args.environment)}/services/oauth2/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', args.clientId);
  url.searchParams.set('redirect_uri', config.oauthCallbackUrl);
  url.searchParams.set('scope', 'api refresh_token id');
  url.searchParams.set('state', args.state);
  url.searchParams.set('code_challenge', args.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Always show the Salesforce login screen, so the customer picks the right org on purpose.
  url.searchParams.set('prompt', 'login');
  return url.toString();
}

/**
 * Asks Salesforce's login page (no login, nothing secret) whether it accepts this Client ID
 * and callback address. Salesforce answers a bad one with HTTP 400 and a body like
 * "error=redirect_uri_mismatch&error_description=...". Anything else means "no problem found".
 */
export async function probeAuthorize(args: {
  environment: Environment;
  clientId: string;
}): Promise<SalesforceAuthError | null> {
  const { challenge } = makePkce();
  const url = buildAuthorizeUrl({ environment: args.environment, clientId: args.clientId, state: 'connection-test', challenge });
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    if (res.status !== 400) return null;
    const body = (await res.text()).trim().slice(0, 500);
    if (!body.startsWith('error=')) return null;
    const p = new URLSearchParams(body);
    return new SalesforceAuthError(p.get('error') ?? 'unknown_error', p.get('error_description') ?? '');
  } catch {
    return null; // cannot reach it: the next check reports that
  }
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  instance_url: string;
  id: string;
}

export class SalesforceAuthError extends Error {
  constructor(
    public sfError: string,
    public sfDescription: string,
  ) {
    super(`${sfError}: ${sfDescription}`);
  }
}

async function postForm(url: string, params: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { ok: res.ok, status: res.status, json, text };
}

export async function exchangeCode(args: {
  environment: Environment;
  code: string;
  verifier: string;
  creds: AppCredentials;
}): Promise<TokenResponse> {
  const r = await postForm(`${loginUrlFor(args.environment)}/services/oauth2/token`, {
    grant_type: 'authorization_code',
    code: args.code,
    client_id: args.creds.clientId,
    client_secret: args.creds.clientSecret,
    redirect_uri: config.oauthCallbackUrl,
    code_verifier: args.verifier,
  });
  if (!r.ok) {
    throw new SalesforceAuthError(String(r.json.error ?? r.status), String(r.json.error_description ?? 'Token request failed'));
  }
  return r.json as unknown as TokenResponse;
}

export async function refreshAccessToken(args: {
  loginUrl: string;
  refreshToken: string;
  creds: AppCredentials;
}): Promise<{ accessToken: string; instanceUrl: string; refreshToken?: string }> {
  const r = await postForm(`${args.loginUrl}/services/oauth2/token`, {
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: args.creds.clientId,
    client_secret: args.creds.clientSecret,
  });
  if (!r.ok) {
    throw new SalesforceAuthError(String(r.json.error ?? r.status), String(r.json.error_description ?? 'Token refresh failed'));
  }
  return {
    accessToken: String(r.json.access_token),
    instanceUrl: String(r.json.instance_url),
    // Present when the Connected App uses refresh token rotation: the old one is now dead.
    refreshToken: typeof r.json.refresh_token === 'string' ? r.json.refresh_token : undefined,
  };
}

const refreshing = new Map<string, Promise<{ accessToken: string; instanceUrl: string }>>();

/**
 * Gets a fresh access token for a saved org login, and keeps the newest refresh token.
 * Needed because with "refresh token rotation" Salesforce cancels the old refresh token
 * each time. Calls for the same org are merged so two never race each other.
 */
export function refreshOrgLogin(
  connection: { id: string; loginUrl: string; refreshTokenEnc: string },
  creds: AppCredentials,
): Promise<{ accessToken: string; instanceUrl: string }> {
  const running = refreshing.get(connection.id);
  if (running) return running;
  const job = (async () => {
    // Read the newest saved token, since the object we were handed may be out of date.
    const latest = await prisma.orgConnection.findUnique({ where: { id: connection.id }, select: { refreshTokenEnc: true } });
    const t = await refreshAccessToken({
      loginUrl: connection.loginUrl,
      refreshToken: decrypt(latest?.refreshTokenEnc || connection.refreshTokenEnc),
      creds,
    });
    if (t.refreshToken) {
      await prisma.orgConnection.update({ where: { id: connection.id }, data: { refreshTokenEnc: encrypt(t.refreshToken) } });
    }
    return { accessToken: t.accessToken, instanceUrl: t.instanceUrl };
  })().finally(() => refreshing.delete(connection.id));
  refreshing.set(connection.id, job);
  return job;
}

export async function revokeToken(args: { loginUrl: string; token: string }): Promise<void> {
  try {
    await postForm(`${args.loginUrl}/services/oauth2/revoke`, { token: args.token });
  } catch {
    /* best effort */
  }
}

/** Only talk to real Salesforce addresses (or localhost while testing). */
export function assertSalesforceUrl(raw: string) {
  const u = new URL(raw);
  const host = u.hostname.toLowerCase();
  const ok =
    (u.protocol === 'https:' && /(\.|^)(salesforce\.com|force\.com|salesforce\.mil|sfcrmapps\.cn|salesforce-setup\.com)$/.test(host)) ||
    (config.isTest && (host === 'localhost' || host === '127.0.0.1'));
  if (!ok) throw new HttpError(400, 'Salesforce returned an unexpected address, so we stopped for safety.');
  return u.origin;
}

export interface Identity {
  organization_id: string;
  user_id: string;
  username: string;
  display_name?: string;
}

export async function fetchIdentity(idUrl: string, accessToken: string): Promise<Identity> {
  assertSalesforceUrl(idUrl);
  const res = await fetch(idUrl, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new HttpError(502, 'Could not read the Salesforce user details.');
  return (await res.json()) as Identity;
}

/** Turns Salesforce error codes into plain-English guidance. */
export function explainSfAuthError(e: SalesforceAuthError): string {
  // Salesforce's own catch-all. In practice it means the Connected App is not fully active yet.
  if (e.sfError === 'unknown_error' || /retry your request/i.test(e.sfDescription)) {
    return (
      'Salesforce could not process the request ("retry your request"). This usually means the Connected App ' +
      'is still being activated. Wait about 10 minutes after saving it and test again. ' +
      'If it keeps happening, re-copy the Consumer Key and Consumer Secret from "Manage Consumer Details" and save them here again.'
    );
  }
  switch (e.sfError) {
    case 'invalid_client_id':
      return 'Salesforce does not recognise the Client ID. Check it in Platform setup. A brand-new Connected App can take up to 10 minutes to start working.';
    case 'invalid_client':
      return 'Salesforce rejected the Client Secret. Re-enter it in Platform setup.';
    case 'redirect_uri_mismatch':
      return `The Callback URL saved in your Salesforce Connected App is not the one this app uses. In Salesforce, open the Connected App and set its Callback URL to exactly: ${config.oauthCallbackUrl} (no spaces, no extra line). Save, wait a minute or two, then test again.`;
    case 'invalid_grant':
      return 'The Salesforce login expired or was already used. Please click Connect again.';
    case 'invalid_app_access':
    case 'OAUTH_APPROVAL_ERROR_GENERIC':
      return 'This Salesforce org has not approved the CloudBackup app. A Salesforce admin must install the app (or set "Admin approved users are pre-authorized") and try again.';
    default:
      return `Salesforce said: ${e.sfDescription || e.sfError}`;
  }
}
