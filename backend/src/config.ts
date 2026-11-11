import 'dotenv/config';
import { resolve } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),
  STORAGE_DIR: z.string().default('./.storage'),
  // Optional: only used for automated tests or special Salesforce domains.
  SF_LOGIN_URL_PRODUCTION: z.string().url().default('https://login.salesforce.com'),
  SF_LOGIN_URL_SANDBOX: z.string().url().default('https://test.salesforce.com'),
  BCRYPT_COST: z.coerce.number().default(12),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  console.error(
    `\nThe server cannot start because some settings are missing or wrong:\n${lines.join('\n')}\n\n` +
      `Tip: for local development run "npm run setup" in the project folder.\n`,
  );
  process.exit(1);
}

const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  appUrl: env.APP_URL.replace(/\/+$/, ''),
  jwtSecret: env.JWT_SECRET,
  encryptionKey: Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'hex'),
  storageDir: resolve(env.STORAGE_DIR),
  loginUrls: {
    PRODUCTION: env.SF_LOGIN_URL_PRODUCTION.replace(/\/+$/, ''),
    SANDBOX: env.SF_LOGIN_URL_SANDBOX.replace(/\/+$/, ''),
  },
  bcryptCost: env.BCRYPT_COST,
  /** Address Salesforce sends the user back to after login. Must match the Connected App. */
  oauthCallbackUrl: `${env.APP_URL.replace(/\/+$/, '')}/api/oauth/salesforce/callback`,
} as const;
