import { createApp } from './app.js';
import { recoverStaleRuns, startScheduler } from './backup/runner.js';
import { config } from './config.js';
import { prisma } from './db.js';

async function main() {
  await prisma.$connect();
  const stopped = await recoverStaleRuns();
  if (stopped > 0) console.warn(`Marked ${stopped} interrupted backup run(s) as failed.`);
  // Old one-time login records are no longer needed.
  await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  startScheduler();
  const app = createApp();
  app.listen(config.port, () => console.log(`CloudBackup API listening on http://localhost:${config.port}`));
}

main().catch((e) => {
  console.error('Could not start:', e instanceof Error ? e.message : e);
  process.exit(1);
});
