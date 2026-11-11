import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

export default function setup() {
  const url = 'postgresql://cloudbackup:cloudbackup@localhost:54329/cloudbackup_test';
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, DATABASE_URL: url } });
  rmSync('./.test-storage', { recursive: true, force: true });
}
