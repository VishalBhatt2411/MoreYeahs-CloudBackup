import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import type { SfGateway } from '../salesforce/gateway.js';
import { SKIPPED_FIELD_TYPES } from './coverage.js';
import { absPath, ensureDir, safeName } from './storage.js';

export interface FileEntry {
  path: string; // relative to storage root
  sha256: string;
  bytes: number;
}

export interface ItemResult {
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  expectedCount?: number;
  rowCount?: number;
  bytes?: number;
  sha256?: string;
  filePath?: string;
  files: FileEntry[];
  note?: string;
  error?: string;
}

async function sha256OfFile(abs: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
  return h.digest('hex');
}

async function countGzLines(abs: string): Promise<number> {
  const rl = createInterface({ input: createReadStream(abs).pipe(createGunzip()), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) if (line.length > 0) n++;
  return n;
}

/**
 * Copies every record of one object into a compressed JSON-lines file (one record per line),
 * then proves the copy is good: the file's checksum is re-read from disk and the rows are
 * counted again and compared with what Salesforce said it would return.
 */
export async function exportObject(gw: SfGateway, objectName: string, runRelDir: string): Promise<ItemResult> {
  const fields = await gw.describeFields(objectName);
  const kept = fields.filter((f) => !SKIPPED_FIELD_TYPES.has(f.type));
  const skipped = fields.filter((f) => SKIPPED_FIELD_TYPES.has(f.type)).map((f) => f.name);
  if (kept.length === 0) {
    return { status: 'FAILED', files: [], error: 'No readable fields were found for this object.' };
  }
  const names = kept.map((f) => f.name);
  names.sort((a, b) => (a === 'Id' ? -1 : b === 'Id' ? 1 : 0));
  const soql = `SELECT ${names.join(', ')} FROM ${objectName}`;

  const relFile = join(runRelDir, 'objects', `${safeName(objectName)}.jsonl.gz`);
  await ensureDir(join(runRelDir, 'objects'));
  const abs = absPath(relFile);

  const out = createWriteStream(abs);
  const gzip = createGzip();
  const hash = createHash('sha256');
  let bytes = 0;
  gzip.on('data', (c: Buffer) => {
    hash.update(c);
    bytes += c.length;
  });
  gzip.pipe(out);

  let rowCount = 0;
  let expected: number | undefined;
  try {
    for await (const page of gw.queryPages(soql)) {
      expected ??= page.totalSize;
      for (const rec of page.records) {
        const { attributes: _attributes, ...row } = rec as Record<string, unknown>;
        rowCount++;
        if (!gzip.write(JSON.stringify(row) + '\n')) await once(gzip, 'drain');
      }
    }
  } catch (e) {
    gzip.destroy();
    out.destroy();
    throw e;
  }
  gzip.end();
  await once(out, 'finish');
  const sha256 = hash.digest('hex');

  // Verify what actually landed on disk.
  const onDisk = await sha256OfFile(abs);
  const size = (await stat(abs)).size;
  const rowsOnDisk = await countGzLines(abs);
  const notes: string[] = [];
  if (skipped.length) notes.push(`Not copied (binary or compound fields): ${skipped.join(', ')}`);
  const file: FileEntry = { path: relFile, sha256, bytes: size };

  if (onDisk !== sha256 || size !== bytes) {
    return { status: 'FAILED', expectedCount: expected, rowCount, files: [file], filePath: relFile, error: 'Checksum check failed: the saved file does not match what was written.' };
  }
  if (rowsOnDisk !== rowCount) {
    return { status: 'FAILED', expectedCount: expected, rowCount, files: [file], filePath: relFile, error: `Row check failed: wrote ${rowCount} rows but the file holds ${rowsOnDisk}.` };
  }
  if (expected !== undefined && expected !== rowCount) {
    return {
      status: 'PARTIAL',
      expectedCount: expected,
      rowCount,
      bytes: size,
      sha256,
      filePath: relFile,
      files: [file],
      note: notes.join(' | ') || undefined,
      error: `Salesforce said ${expected} rows but we received ${rowCount}.`,
    };
  }
  return {
    status: 'SUCCEEDED',
    expectedCount: expected ?? 0,
    rowCount,
    bytes: size,
    sha256,
    filePath: relFile,
    files: [file],
    note: notes.join(' | ') || undefined,
  };
}

const CHUNK = 400;

/**
 * Copies one type of metadata (e.g. all Apex classes) as zip files straight from the
 * Salesforce Metadata API, then checks that every component we asked for came back.
 */
export async function exportMetadataType(
  gw: SfGateway,
  type: string,
  inFolder: boolean,
  runRelDir: string,
): Promise<ItemResult> {
  const all = await gw.listMetadata(type, inFolder);
  const retrievable = all.filter((m) => m.manageableState !== 'installed');
  const installedCount = all.length - retrievable.length;
  const baseNote = installedCount ? `${installedCount} components from installed managed packages are not copied (Salesforce does not allow it).` : undefined;
  if (retrievable.length === 0) {
    return { status: 'SUCCEEDED', rowCount: 0, expectedCount: 0, files: [], note: baseNote ?? 'No components of this type in the org.' };
  }

  const dirRel = join(runRelDir, 'metadata', safeName(type));
  await ensureDir(dirRel);
  const files: FileEntry[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];
  let found = 0;

  for (let i = 0; i < retrievable.length; i += CHUNK) {
    const chunk = retrievable.slice(i, i + CHUNK);
    const request: Record<string, string[]> = {};
    for (const m of chunk) (request[m.type] ??= []).push(m.fullName);
    const result = await gw.retrieveMetadata(request);
    const got = new Set(result.found);
    for (const m of chunk) {
      if (got.has(`${m.type}/${m.fullName}`)) found++;
      else missing.push(`${m.type}/${m.fullName}`);
    }
    warnings.push(...result.warnings);
    const rel = join(dirRel, `part-${String(i / CHUNK + 1).padStart(3, '0')}.zip`);
    await writeFile(absPath(rel), result.zip);
    const sha = await sha256OfFile(absPath(rel));
    const expectedSha = createHash('sha256').update(result.zip).digest('hex');
    if (sha !== expectedSha) {
      return { status: 'FAILED', files, error: 'Checksum check failed: a saved metadata file does not match what was received.' };
    }
    files.push({ path: rel, sha256: sha, bytes: result.zip.length });
  }

  const combined = createHash('sha256').update(files.map((f) => f.sha256).join('')).digest('hex');
  const bytes = files.reduce((s, f) => s + f.bytes, 0);
  const noteParts = [baseNote, warnings.length ? `Salesforce messages: ${warnings.slice(0, 3).join(' ; ')}` : undefined].filter(Boolean);
  const base = {
    expectedCount: retrievable.length,
    rowCount: found,
    bytes,
    sha256: combined,
    filePath: dirRel,
    files,
    note: noteParts.join(' | ') || undefined,
  };
  if (missing.length > 0) {
    return { status: 'PARTIAL', ...base, error: `${missing.length} of ${retrievable.length} components did not come back (for example ${missing.slice(0, 3).join(', ')}).` };
  }
  return { status: 'SUCCEEDED', ...base };
}
