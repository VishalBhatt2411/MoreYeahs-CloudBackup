import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { errorHandler } from './lib/http.js';
import { sameOriginOnly } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { connectionsRouter } from './routes/connections.js';
import { dashboardRouter } from './routes/dashboard.js';
import { oauthRouter } from './routes/oauth.js';
import { platformRouter, salesforceStatusRouter } from './routes/platform.js';
import { auditRouter, downloadsRouter, runsRouter } from './routes/runs.js';
import { settingsRouter, teamRouter } from './routes/settings.js';
import { requireAuth, requirePlatformAdmin } from './middleware/auth.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.isProd) app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  app.use('/api', sameOriginOnly);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/salesforce/status', requireAuth, salesforceStatusRouter);
  app.use('/api/platform', requireAuth, requirePlatformAdmin, platformRouter);
  app.use('/api/oauth', oauthRouter);
  app.use('/api/connections', connectionsRouter);
  app.use('/api/runs', runsRouter);
  app.use('/api/downloads', downloadsRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/team', teamRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  // In production the built website is served by this same server.
  const dist = join(process.cwd(), '..', 'frontend', 'dist');
  if (existsSync(join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
