import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { HttpError, wrap } from '../lib/http.js';
import { loadUser, requireAuth, requireRole } from '../middleware/auth.js';
import {
  SalesforceAuthError,
  assertSalesforceUrl,
  buildAuthorizeUrl,
  exchangeCode,
  explainSfAuthError,
  fetchIdentity,
  loginUrlFor,
  makePkce,
  newState,
  requireAppCredentials,
} from '../salesforce/oauth.js';
import { fetchOrgName } from '../salesforce/rest.js';

export const oauthRouter = Router();

const STATE_MINUTES = 10;

/**
 * Step 1: the customer clicks "Connect Salesforce".
 * We remember (on the server) who asked, and the secret PKCE verifier, then send back
 * the Salesforce login address for the browser to open.
 */
oauthRouter.post(
  '/salesforce/start',
  requireAuth,
  requireRole('OWNER', 'ADMIN'),
  wrap(async (req, res) => {
    const body = z
      .object({
        environment: z.enum(['PRODUCTION', 'SANDBOX']),
        label: z.string().trim().min(1, 'Give this org a name').max(60),
      })
      .parse(req.body);
    const creds = await requireAppCredentials();
    const { verifier, challenge } = makePkce();
    const state = newState();
    await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await prisma.oAuthState.create({
      data: {
        state,
        tenantId: req.user!.tenantId,
        userId: req.user!.id,
        environment: body.environment,
        label: body.label,
        codeVerifierEnc: encrypt(verifier),
        expiresAt: new Date(Date.now() + STATE_MINUTES * 60_000),
      },
    });
    const authorizeUrl = buildAuthorizeUrl({ environment: body.environment, clientId: creds.clientId, state, challenge });
    res.json({ authorizeUrl });
  }),
);

function backToApp(res: import('express').Response, params: Record<string, string>) {
  const url = new URL(`${config.appUrl}/orgs`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v.slice(0, 300));
  res.redirect(url.toString());
}

/**
 * Step 2: Salesforce sends the customer back here with a one-time code.
 * We swap the code for tokens, store the refresh token encrypted, and show the org in the app.
 */
oauthRouter.get(
  '/salesforce/callback',
  wrap(async (req, res) => {
    const q = z
      .object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
      })
      .parse(req.query);

    const pending = q.state ? await prisma.oAuthState.findUnique({ where: { state: q.state } }) : null;
    if (pending) await prisma.oAuthState.delete({ where: { state: pending.state } }).catch(() => undefined); // one-time use

    if (q.error) {
      const e = new SalesforceAuthError(q.error, q.error_description ?? '');
      if (pending) await audit(pending.tenantId, pending.userId, 'org.connect.failed', null, `${q.error}`);
      return backToApp(res, { sf_error: explainSfAuthError(e) });
    }
    if (!pending || !q.code) {
      return backToApp(res, { sf_error: 'That Salesforce login link is not valid any more. Please click Connect again.' });
    }
    if (pending.expiresAt < new Date()) {
      return backToApp(res, { sf_error: 'The Salesforce login took too long. Please click Connect again.' });
    }
    const user = await loadUser(req);
    if (!user || user.id !== pending.userId) {
      return backToApp(res, { sf_error: 'Please sign in to CloudBackup and click Connect again.' });
    }

    try {
      const creds = await requireAppCredentials();
      const tokens = await exchangeCode({
        environment: pending.environment,
        code: q.code,
        verifier: decrypt(pending.codeVerifierEnc),
        creds,
      });
      if (!tokens.refresh_token) {
        throw new HttpError(
          400,
          'Salesforce did not give a long-lasting login (refresh token). In the Connected App, make sure the scope "Perform requests at any time (refresh_token, offline_access)" is selected.',
        );
      }
      const instanceUrl = assertSalesforceUrl(tokens.instance_url);
      const identity = await fetchIdentity(tokens.id, tokens.access_token);
      const orgName = await fetchOrgName(instanceUrl, tokens.access_token);

      const data = {
        label: pending.label,
        environment: pending.environment,
        loginUrl: loginUrlFor(pending.environment),
        instanceUrl,
        sfUserId: identity.user_id,
        username: identity.username,
        orgName,
        refreshTokenEnc: encrypt(tokens.refresh_token),
        status: 'ACTIVE' as const,
        lastError: null,
        connectedAt: new Date(),
        lastCheckedAt: new Date(),
      };
      const connection = await prisma.orgConnection.upsert({
        where: { tenantId_sfOrgId: { tenantId: pending.tenantId, sfOrgId: identity.organization_id } },
        create: { tenantId: pending.tenantId, sfOrgId: identity.organization_id, ...data },
        update: data,
      });
      await audit(pending.tenantId, pending.userId, 'org.connected', `${connection.label} (${identity.organization_id})`);
      return backToApp(res, { connected: connection.id });
    } catch (e) {
      const message =
        e instanceof SalesforceAuthError ? explainSfAuthError(e) : e instanceof HttpError ? e.message : 'Could not finish connecting to Salesforce.';
      if (!(e instanceof SalesforceAuthError) && !(e instanceof HttpError)) console.error('OAuth callback error:', e);
      await audit(pending.tenantId, pending.userId, 'org.connect.failed', null, message);
      return backToApp(res, { sf_error: message });
    }
  }),
);
