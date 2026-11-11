import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { createGunzip, createGzip, type Gzip } from 'node:zlib';
import { getStorage } from './storage.js';

/** SHA-256 of a stored file, read back from storage. */
export async function sha256OfRel(rel: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of getStorage().openRead(rel)) h.update(chunk as Buffer);
  return h.digest('hex');
}

async function countLinesIn(source: Readable): Promise<number> {
  let n = 0;
  for await (const chunk of source.pipe(createGunzip())) {
    const buf = chunk as Buffer;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  }
  return n;
}

/**
 * Counts rows by counting real newline bytes (each row is one line ending in "\n").
 * Not readline: it also splits on U+2028/U+2029, which JSON.stringify leaves as-is inside
 * text (e.g. page markup), so it would count extra rows that are not there.
 * `file` is an absolute path on disk.
 */
export function countGzLines(file: string): Promise<number> {
  return countLinesIn(createReadStream(file));
}

/** Same count, for a file kept in storage (relative path). */
export function countGzLinesRel(rel: string): Promise<number> {
  return countLinesIn(getStorage().openRead(rel));
}

/**
 * Reads a compressed JSON-lines file one line at a time (memory stays flat for any size).
 * Lines are split on real newline bytes only, for the same reason as above.
 */
export async function* gzLines(rel: string): AsyncGenerator<string> {
  let pending: Buffer[] = [];
  for await (const chunk of getStorage().openRead(rel).pipe(createGunzip())) {
    let buf = chunk as Buffer;
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        pending.push(buf);
        break;
      }
      pending.push(buf.subarray(0, nl));
      yield Buffer.concat(pending).toString('utf8');
      pending = [];
      buf = buf.subarray(nl + 1);
    }
  }
  if (pending.length) {
    const rest = Buffer.concat(pending).toString('utf8');
    if (rest) yield rest;
  }
}

/** Writes one JSON object per line into a gzip file in storage, tracking its checksum and size as it goes. */
export class SnapshotWriter {
  private gzip: Gzip;
  private out!: Writable;
  private hash = createHash('sha256');
  bytes = 0;
  rows = 0;

  private constructor() {
    this.gzip = createGzip();
  }

  static async open(rel: string): Promise<SnapshotWriter> {
    const w = new SnapshotWriter();
    w.out = await getStorage().openWrite(rel);
    w.gzip.on('data', (c: Buffer) => {
      w.hash.update(c);
      w.bytes += c.length;
    });
    w.gzip.pipe(w.out);
    return w;
  }

  /** One row, given as an object. */
  async write(row: Record<string, unknown>) {
    await this.writeLine(JSON.stringify(row));
  }

  /** One row, already serialised (used to copy unchanged rows without re-encoding them). */
  async writeLine(line: string) {
    this.rows++;
    if (!this.gzip.write(line + '\n')) await once(this.gzip, 'drain');
  }

  async close(): Promise<{ sha256: string; bytes: number; rows: number }> {
    this.gzip.end();
    await once(this.out, 'finish');
    return { sha256: this.hash.digest('hex'), bytes: this.bytes, rows: this.rows };
  }

  abort() {
    this.gzip.destroy();
    this.out.destroy();
  }
}
