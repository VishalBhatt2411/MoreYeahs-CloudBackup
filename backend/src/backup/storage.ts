import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { config } from '../config.js';

/**
 * Where backup files live. Every path starts with the tenant id, so one customer's files
 * can never be reached from another customer's account.
 */
export function runRelDir(tenantId: string, connectionId: string, runId: string) {
  return join('tenants', tenantId, 'orgs', connectionId, 'runs', runId);
}

export const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');

/**
 * The rest of the app talks to storage only through this shape. Today there is one driver
 * (the server's disk). An object-storage driver (S3 and similar) can be added later by
 * implementing the same methods, with no change to the backup engine, retention or downloads.
 * Paths are always relative to the storage root and start with `tenants/<tenantId>/`.
 */
export interface StorageDriver {
  readonly name: string;
  /** Opens a file for writing (creates folders as needed). */
  openWrite(rel: string): Promise<Writable>;
  writeFile(rel: string, data: Buffer | string): Promise<void>;
  openRead(rel: string): Readable;
  /** Size in bytes, or null when there is no such file. */
  fileSize(rel: string): Promise<number | null>;
  /** Every file under a folder, as paths relative to that folder (forward slashes). */
  listFiles(relDir: string): Promise<string[]>;
  /** Deletes a folder and everything in it. Missing is fine. */
  removeTree(rel: string): Promise<void>;
}

/** Refuses any path that is not inside this tenant's own folder. Returns the cleaned path. */
export function guardTenantPath(tenantId: string, rel: string): string {
  const clean = posix.normalize(rel.replace(/\\/g, '/'));
  const prefix = `tenants/${tenantId}/`;
  if (!tenantId || clean.startsWith('/') || clean.split('/').includes('..') || !clean.startsWith(prefix)) {
    throw new Error('Path is outside the tenant folder');
  }
  return clean;
}

class LocalDiskStorage implements StorageDriver {
  readonly name = 'local';
  private abs(rel: string) {
    return resolve(config.storageDir, rel);
  }
  async openWrite(rel: string) {
    const abs = this.abs(rel);
    await mkdir(dirname(abs), { recursive: true });
    return createWriteStream(abs);
  }
  async writeFile(rel: string, data: Buffer | string) {
    const abs = this.abs(rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
  }
  openRead(rel: string) {
    return createReadStream(this.abs(rel));
  }
  async fileSize(rel: string) {
    const s = await stat(this.abs(rel)).catch(() => null);
    return s?.isFile() ? s.size : null;
  }
  async listFiles(relDir: string) {
    const root = this.abs(relDir);
    const out: string[] = [];
    const walk = async (dir: string, prefix: string) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.isDirectory()) await walk(join(dir, e.name), `${prefix}${e.name}/`);
        else if (e.isFile()) out.push(`${prefix}${e.name}`);
      }
    };
    await walk(root, '');
    return out.sort();
  }
  async removeTree(rel: string) {
    await rm(this.abs(rel), { recursive: true, force: true });
  }
}

let driver: StorageDriver | null = null;
export function getStorage(): StorageDriver {
  if (!driver) {
    // "s3" is reserved for later; config only accepts "local" today.
    driver = new LocalDiskStorage();
  }
  return driver;
}

/** Absolute path on the server's disk. Only the local driver has one; tests use it to look at files. */
export function absPath(rel: string) {
  return resolve(config.storageDir, rel);
}

/** Resolves a stored relative path on disk and refuses anything outside this tenant's folder. */
export function safeAbsPath(tenantId: string, rel: string): string {
  const abs = absPath(rel);
  const tenantRoot = resolve(config.storageDir, 'tenants', tenantId) + sep;
  if (!abs.startsWith(tenantRoot)) throw new Error('Path is outside the tenant folder');
  return abs;
}
