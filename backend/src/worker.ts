import { startScheduler, startWorker } from './backup/runner.js';
import { prisma } from './db.js';

/**
 * A separate process that performs backups (use with WORKER_MODE=external on the API server).
 * It reads the same queue in the database, so several workers can run side by side safely.
 */
async function main() {
  await prisma.$connect();
  const stopWorker = startWorker();
  const stopScheduler = startScheduler();
  console.log('CloudBackup worker started. Waiting for backups...');
  const quit = async () => {
    stopScheduler();
    stopWorker();
    // Anything still running keeps its claim until it expires, then another worker resumes it.
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}

main().catch((e) => {
  console.error('Worker could not start:', e instanceof Error ? e.message : e);
  process.exit(1);
});
