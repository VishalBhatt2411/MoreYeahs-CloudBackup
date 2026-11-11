import { createHash, randomBytes } from 'node:crypto';
import type { Environment } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { decrypt } from '../lib/crypto.js';
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
}): Promise<{ accessToken: string; instanceUrl: string }> {
  const r = await postForm(`${args.loginUrl}/services/oauth2/token`, {
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: args.creds.clientId,
    client_secret: args.creds.clientSecret,
  });
  if (!r.ok) {
    throw new SalesforceAuthError(String(r.json.error ?? r.status), String(r.json.error_description ?? 'Token refresh failed'));
  }
  return { accessToken: String(r.json.access_token), instanceUrl: String(r.json.instance_url) };
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
  switch (e.sfError) {
    case 'invalid_client_id':
      return 'Salesforce does not recognise the Client ID. Check it in Admin > Salesforce integration. A brand-new Connected App can take up to 10 minutes to start working.';
    case 'invalid_client':
      return 'Salesforce rejected the Client Secret. Re-enter it in Admin > Salesforce integration.';
    case 'redirect_uri_mismatch':
      return 'The callback address in the Salesforce Connected App does not match this app. Copy the exact callback address shown in Admin > Salesforce integration.';
    case 'invalid_grant':
      return 'The Salesforce login expired or was already used. Please click Connect again.';
    case 'invalid_app_access':
    case 'OAUTH_APPROVAL_ERROR_GENERIC':
      return 'This Salesforce org has not approved the CloudBackup app. A Salesforce admin must install the app (or set "Admin approved users are pre-authorized") and try again.';
    default:
      return `Salesforce said: ${e.sfDescription || e.sfError}`;
  }
}
