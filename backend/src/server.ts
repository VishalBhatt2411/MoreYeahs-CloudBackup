import { createApp } from './app.js';
import { startScheduler, startWorker } from './backup/runner.js';
import { config } from './config.js';
import { prisma } from './db.js';

async function main() {
  await prisma.$connect();
  // Old one-time login records are no longer needed.
  await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  if (config.workerMode === 'embedded') {
    // Backups run inside this server. Interrupted ones are picked up again by the worker.
    startWorker();
    startScheduler();
  } else {
    console.log('WORKER_MODE=external: run "npm run worker" as a separate process to perform backups.');
  }
  const app = createApp();
  app.listen(config.port, () => console.log(`CloudBackup API listening on http://localhost:${config.port}`));
}

main().catch((e) => {
  console.error('Could not start:', e instanceof Error ? e.message : e);
  process.exit(1);
});
