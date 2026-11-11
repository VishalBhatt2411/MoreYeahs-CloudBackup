import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { encrypt } from '../lib/crypto.js';
import { HttpError, wrap } from '../lib/http.js';
import { requireAuth, requirePlatformAdmin } from '../middleware/auth.js';
import {
  SalesforceAuthError,
  exchangeCode,
  explainSfAuthError,
  getAppCredentials,
  makePkce,
  probeAuthorize,
} from '../salesforce/oauth.js';

/** Anyone signed in can ask "is Salesforce connecting set up?" (never returns secrets). */
export const salesforceStatusRouter = Router();
salesforceStatusRouter.get(
  '/',
  requireAuth,
  wrap(async (_req, res) => {
    const row = await prisma.salesforceAppConfig.findUnique({ where: { id: 'default' }, select: { id: true } });
    res.json({ configured: !!row });
  }),
);

/** Platform-admin only: where the shared Salesforce Connected App details are entered. */
export const platformRouter = Router();
platformRouter.use(requireAuth, requirePlatformAdmin);

platformRouter.get(
  '/salesforce',
  wrap(async (_req, res) => {
    const row = await prisma.salesforceAppConfig.findUnique({ where: { id: 'default' } });
    res.json({
      configured: !!row,
      clientId: row?.clientId ?? null,
      // The secret is never sent back. We only say that one is saved.
      clientSecretSaved: !!row,
      updatedAt: row?.updatedAt ?? null,
      callbackUrl: config.oauthCallbackUrl,
      scopes: ['api', 'refresh_token', 'id'],
    });
  }),
);

const saveBody = z.object({
  clientId: z.string().trim().min(15, 'That Client ID looks too short').max(300),
  // Optional when updating only the Client ID. Required the first time.
  clientSecret: z.string().trim().min(10, 'That Client Secret looks too short').max(300).optional(),
});

platformRouter.put(
  '/salesforce',
  wrap(async (req, res) => {
    const body = saveBody.parse(req.body);
    const existing = await prisma.salesforceAppConfig.findUnique({ where: { id: 'default' } });
    if (!existing && !body.clientSecret) throw new HttpError(400, 'Client Secret is required the first time.');
    const clientSecretEnc = body.clientSecret ? encrypt(body.clientSecret) : existing!.clientSecretEnc;
    await prisma.salesforceAppConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default', clientId: body.clientId, clientSecretEnc, updatedById: req.user!.id },
      update: { clientId: body.clientId, clientSecretEnc, updatedById: req.user!.id },
    });
    await audit(null, req.user!.id, 'platform.salesforce.saved', 'Salesforce Connected App');
    res.json({ ok: true });
  }),
);

/**
 * Checks the saved Client ID / Secret without logging in as anyone:
 * we send Salesforce a deliberately fake login code. Salesforce first checks the app
 * details, so the *kind* of error tells us if the app details are right.
 */
platformRouter.post(
  '/salesforce/test',
  wrap(async (_req, res) => {
    const creds = await getAppCredentials();
    if (!creds) throw new HttpError(409, 'Save the Client ID and Secret first.');
    // Check 1: does Salesforce accept this Client ID and our callback address?
    const probe = await probeAuthorize({ environment: 'PRODUCTION', clientId: creds.clientId });
    if (probe) {
      res.json({ ok: false, message: explainSfAuthError(probe), code: probe.sfError });
      return;
    }
    // Check 2: does it accept the Client Secret?
    const { verifier } = makePkce();
    try {
      await exchangeCode({ environment: 'PRODUCTION', code: 'cloudbackup-connection-test', verifier, creds });
      res.json({ ok: true, message: 'Salesforce accepted the app details.' });
    } catch (e) {
      if (e instanceof SalesforceAuthError) {
        if (e.sfError === 'invalid_grant') {
          // The fake code was (correctly) refused, which means the app details were recognised.
          res.json({ ok: true, message: 'Salesforce recognised the Client ID and Secret.' });
          return;
        }
        res.json({ ok: false, message: explainSfAuthError(e), code: e.sfError });
        return;
      }
      res.json({ ok: false, message: 'Could not reach Salesforce. Check the server internet connection.' });
    }
  }),
);
