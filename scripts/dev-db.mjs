// Starts a private PostgreSQL for local development / tests (no Docker needed).
// It uses its own port (54329) and its own data folder (.pgdata), so it never
// touches any PostgreSQL already installed on the computer (port 5432).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, '.pgdata');
const port = Number(process.env.DEV_DB_PORT || 54329);

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'cloudbackup',
  password: 'cloudbackup',
  port,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});

if (!existsSync(join(dataDir, 'PG_VERSION'))) {
  console.log('First run: creating the local database files...');
  await pg.initialise();
}
await pg.start();
for (const name of ['cloudbackup', 'cloudbackup_test']) {
  try {
    await pg.createDatabase(name);
    console.log(`Created database "${name}"`);
  } catch {
    /* already exists */
  }
}
console.log(`Local database is running on port ${port}. Press Ctrl+C to stop it.`);

const stop = async () => {
  try {
    await pg.stop();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
