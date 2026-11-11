import { mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { config } from '../config.js';

/**
 * Where backup files live. Every path starts with the tenant id, so one customer's files
 * can never be reached from another customer's account.
 * (Local disk for now; the same layout maps directly to S3 / Azure Blob later.)
 */
export function runRelDir(tenantId: string, connectionId: string, runId: string) {
  return join('tenants', tenantId, 'orgs', connectionId, 'runs', runId);
}

export function absPath(rel: string) {
  return resolve(config.storageDir, rel);
}

export async function ensureDir(rel: string) {
  const abs = absPath(rel);
  await mkdir(abs, { recursive: true });
  return abs;
}

/** Resolves a stored relative path and refuses anything outside this tenant's folder. */
export function safeAbsPath(tenantId: string, rel: string): string {
  const abs = absPath(rel);
  const tenantRoot = resolve(config.storageDir, 'tenants', tenantId) + sep;
  if (!abs.startsWith(tenantRoot)) throw new Error('Path is outside the tenant folder');
  return abs;
}

export const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');
