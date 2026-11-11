// Creates backend/.env for local development if it does not exist yet.
// It generates fresh random server secrets. Nothing is printed.
// These are SERVER secrets (they protect login cookies and stored tokens).
// They are NOT Salesforce credentials - those are entered inside the app by the platform admin.
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend', '.env');
if (existsSync(target)) {
  console.log('backend/.env already exists - leaving it as it is.');
} else {
  const lines = [
    'NODE_ENV=development',
    'PORT=4000',
    'DATABASE_URL=postgresql://cloudbackup:cloudbackup@localhost:54329/cloudbackup',
    'APP_URL=http://localhost:5173',
    `JWT_SECRET=${randomBytes(48).toString('hex')}`,
    `TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`,
    'STORAGE_DIR=./.storage',
    '',
  ];
  writeFileSync(target, lines.join('\n'));
  console.log('Created backend/.env with fresh random secrets.');
}
