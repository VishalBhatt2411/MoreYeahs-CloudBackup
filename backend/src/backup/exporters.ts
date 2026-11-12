import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { config } from '../config.js';
import type { FieldInfo, SfGateway } from '../salesforce/gateway.js';
import { SKIPPED_FIELD_TYPES } from './coverage.js';
import { countGzLinesRel, gzLines, sha256OfRel, SnapshotWriter } from './snapshot.js';
import { getStorage, safeName } from './storage.js';

export { countGzLines } from './snapshot.js';

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
  /** How this object was copied. Metadata items leave it empty. */
  mode?: 'FULL' | 'INCREMENTAL';
  changedCount?: number;
  deletedCount?: number;
  /** Newest change time seen in the copy. The next incremental copy starts from here. */
  watermark?: Date | null;
}

/** What the last good copy of an object left behind (see ObjectCheckpoint). */
export interface Baseline {
  watermark: Date | null;
  lastFilePath: string;
  lastFullAt: Date;
  needsFull: boolean;
}

export interface ExportCtx {
  /** Folder of this run, relative to the storage root. */
  relDir: string;
  /** True when the run may copy only what changed. */
  wantIncremental: boolean;
  baseline: Baseline | null;
  /** The name people see for the object (for example "Account" or "Project Task"). Saved next to the copy. */
  objectLabel?: string;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Salesforce checks can be a little late: look back this far before the saved change time. */
const OVERLAP_MS = 120_000;
/** More changed rows than this are not merged in memory; a full copy is made instead. */
export const MAX_DELTA_ROWS = 50_000;

/** SOQL date-time literal, whole seconds, rounded down (so the boundary row is read again, never missed). */
function soqlTime(d: Date) {
  return new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function stampMs(row: Record<string, unknown>): number | null {
  const v = row['SystemModstamp'];
  if (typeof v !== 'string') return null;
  const t = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(t) ? t : null;
}

/** Salesforce rejects GET addresses much beyond 8 KB with "431 Request Header Fields Too Large". Stay well under. */
const MAX_QUERY_URL_CHARS = 4500;
export function soqlTooLongForUrl(soql: string): boolean {
  // Leave room for the incremental "WHERE SystemModstamp >= ..." clause.
  return encodeURIComponent(soql).length + 120 > MAX_QUERY_URL_CHARS;
}

/** Rows are written with Id first, so the id can be read without parsing the whole line. */
function idOfLine(line: string): string | null {
  if (line.startsWith('{"Id":"')) {
    const end = line.indexOf('"', 7);
    if (end > 7) return line.slice(7, end);
  }
  try {
    const id = (JSON.parse(line) as { Id?: unknown }).Id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

function stripAttributes(rec: Record<string, unknown>): Record<string, unknown> {
  const { attributes: _attributes, ...row } = rec;
  return row;
}

interface Written {
  rowCount: number;
  expected: number | undefined;
  maxStamp: number | null;
  sha256: string;
  bytes: number;
}

/** Re-reads what landed in storage and compares it with what was written and what Salesforce said. */
async function verifyAndBuild(
  relFile: string,
  w: Written,
  notes: string[],
  extra: Pick<ItemResult, 'mode' | 'changedCount' | 'deletedCount' | 'watermark'>,
): Promise<ItemResult> {
  const storage = getStorage();
  const onDisk = await sha256OfRel(relFile);
  const size = (await storage.fileSize(relFile)) ?? -1;
  const rowsOnDisk = await countGzLinesRel(relFile);
  const file: FileEntry = { path: relFile, sha256: w.sha256, bytes: size };
  const note = notes.join(' | ') || undefined;
  const base = { expectedCount: w.expected, rowCount: w.rowCount, filePath: relFile, files: [file], mode: extra.mode, note };

  if (onDisk !== w.sha256 || size !== w.bytes) {
    return { ...base, status: 'FAILED', error: 'Checksum check failed: the saved file does not match what was written.' };
  }
  if (rowsOnDisk !== w.rowCount) {
    return { ...base, status: 'FAILED', error: `Row check failed: wrote ${w.rowCount} rows but the file holds ${rowsOnDisk}.` };
  }
  const good = { ...base, bytes: size, sha256: w.sha256, changedCount: extra.changedCount, deletedCount: extra.deletedCount, watermark: extra.watermark };
  if (w.expected !== undefined && w.expected !== w.rowCount) {
    return { ...good, status: 'PARTIAL', error: `Salesforce said ${w.expected} rows but we received ${w.rowCount}.` };
  }
  return { ...good, status: 'SUCCEEDED', expectedCount: w.expected ?? 0 };
}

async function writeFull(
  gw: SfGateway,
  relFile: string,
  soql: string,
  useBulk: boolean,
  count: number | null,
  fieldTypes: Record<string, string>,
): Promise<Written> {
  const w = await SnapshotWriter.open(relFile);
  let expected: number | undefined = useBulk && count !== null ? count : undefined;
  let maxStamp: number | null = null;
  try {
    const pages = useBulk
      ? gw.bulkQueryPages(soql, { fieldTypes, expectedRows: count ?? undefined })
      : gw.queryPages(soql);
    for await (const page of pages) {
      expected ??= page.totalSize;
      for (const rec of page.records) {
        const row = stripAttributes(rec);
        const t = stampMs(row);
        if (t !== null && (maxStamp === null || t > maxStamp)) maxStamp = t;
        await w.write(row);
      }
    }
  } catch (e) {
    w.abort();
    throw e;
  }
  const closed = await w.close();
  return { rowCount: closed.rows, expected, maxStamp, sha256: closed.sha256, bytes: closed.bytes };
}

/** Why an incremental copy cannot be used for this object right now (null = it can). */
async function incrementalBlocker(ctx: ExportCtx, names: string[], hasStamp: boolean): Promise<string | null> {
  const b = ctx.baseline;
  if (!b) return 'first copy of this object';
  if (b.needsFull) return 'a full copy was needed';
  if (!hasStamp || !b.watermark) return 'this object has no change timestamp';
  if (Date.now() - b.lastFullAt.getTime() > config.fullRefreshDays * 86_400_000) return 'periodic full refresh';
  if ((await getStorage().fileSize(b.lastFilePath)) === null) return 'the previous copy is no longer stored';
  // The saved rows must have the same fields as the object has now, or the merge would mix shapes.
  let first: string | undefined;
  for await (const line of gzLines(b.lastFilePath)) {
    first = line;
    break;
  }
  if (first !== undefined) {
    let keys: string[] = [];
    try {
      keys = Object.keys(JSON.parse(first) as object);
    } catch {
      return 'the previous copy could not be read';
    }
    if (keys.length !== names.length || !names.every((n) => keys.includes(n))) return 'the fields of this object changed';
  }
  return null;
}

/** Where the field list (names, labels, types) of an object's copy is kept. */
export const schemaRelPath = (relDir: string, objectName: string) => join(relDir, 'schema', `${safeName(objectName)}.json`);

/**
 * Saves the object's field list next to its copy. The Excel / CSV download uses it to show
 * readable column headings ("Billing City" instead of BillingCity) and to format dates and numbers.
 * Failing to write it must never fail the backup itself, so errors are swallowed.
 */
async function writeSchema(relDir: string, objectName: string, fields: FieldInfo[], objectLabel?: string) {
  try {
    const body = { object: objectName, label: objectLabel ?? objectName, fields: fields.map((f) => ({ name: f.name, label: f.label ?? f.name, type: f.type })) };
    await getStorage().writeFile(schemaRelPath(relDir, objectName), JSON.stringify(body));
  } catch {
    /* labels are a nicety */
  }
}

/**
 * Copies one object into a compressed JSON-lines file (one record per line), then proves the
 * copy is good: the file's checksum is re-read from storage, the rows are counted again and
 * compared with what Salesforce says the object holds.
 *
 * With `wantIncremental`, only records changed since the last good copy are fetched and merged
 * into that copy (deleted records are dropped). The result is still a complete, standalone
 * snapshot. If anything does not add up (counts differ, fields changed, too many changes), it
 * falls back to a full copy, never to a guess.
 */
export async function exportObject(gw: SfGateway, objectName: string, ctx: ExportCtx): Promise<ItemResult> {
  const fields: FieldInfo[] = await gw.describeFields(objectName);
  const kept = fields.filter((f) => !SKIPPED_FIELD_TYPES.has(f.type));
  const skipped = fields.filter((f) => SKIPPED_FIELD_TYPES.has(f.type)).map((f) => f.name);
  if (kept.length === 0) {
    return { status: 'FAILED', files: [], error: 'No readable fields were found for this object.' };
  }
  const names = kept.map((f) => f.name);
  names.sort((a, b) => (a === 'Id' ? -1 : b === 'Id' ? 1 : 0));
  const fieldTypes = Object.fromEntries(kept.map((f) => [f.name, f.type]));
  await writeSchema(ctx.relDir, objectName, kept, ctx.objectLabel);
  const hasStamp = names.includes('SystemModstamp');
  const hasIsDeleted = fields.some((f) => f.name === 'IsDeleted');
  const soql = `SELECT ${names.join(', ')} FROM ${objectName}`;
  const relFile = join(ctx.relDir, 'objects', `${safeName(objectName)}.jsonl.gz`);

  const notes: string[] = [];
  if (skipped.length) notes.push(`Not copied (binary or compound fields): ${skipped.join(', ')}`);

  // ---- Incremental: copy only what changed, merge it into the last good copy. ----
  if (ctx.wantIncremental) {
    let reason = (soqlTooLongForUrl(soql) ? 'the object has too many fields for an incremental query' : null) ?? await incrementalBlocker(ctx, names, hasStamp).catch((e) => `the previous copy could not be read (${msg(e)})`);
    if (!reason) {
      const r = await tryIncremental(gw, objectName, ctx, names, soql, relFile, hasIsDeleted, notes);
      if ('result' in r) return r.result;
      reason = r.reason;
    }
    notes.push(`Full copy made (${reason}).`);
  }

  // ---- Full copy. Large objects go through Bulk API 2.0, the rest through the standard API. ----
  const count = await gw.countRows(objectName).catch(() => null);
  // A query for an object with hundreds of fields is too long for a GET address (Salesforce answers
  // 431), so those go through Bulk API 2.0, which takes the query in the request body.
  const wide = soqlTooLongForUrl(soql);
  const useBulk = wide || (count !== null && count >= config.bulkThresholdRows);

  const copyAll = async (q: string): Promise<Written> => {
    if (!useBulk) return writeFull(gw, relFile, q, false, count, fieldTypes);
    let w: Written;
    let bulkOk = false;
    try {
      w = await writeFull(gw, relFile, q, true, count, fieldTypes);
      notes.push(`Copied with Bulk API 2.0 (${w.rowCount} rows${wide ? '; the object has too many fields for the standard API' : ''}).`);
      bulkOk = true;
    } catch (e) {
      if (wide) throw e;
      notes.push(`Bulk API 2.0 failed (${msg(e).slice(0, 200)}); copied with the standard API instead.`);
      w = await writeFull(gw, relFile, q, false, count, fieldTypes);
    }
    // Never settle for a short Bulk copy when the standard API can still do the job.
    if (bulkOk && !wide && count !== null && w.rowCount !== count) {
      notes.push(`Bulk API 2.0 returned ${w.rowCount} of ${count} rows; copied again with the standard API.`);
      w = await writeFull(gw, relFile, q, false, count, fieldTypes);
    }
    return w;
  };

  let written = await copyAll(soql);

  // Some objects (found live: PermissionSetTabSetting) silently drop rows whenever the derived
  // "Name" field is selected. If the copy is short, try once more without it. The rows keep every
  // other field, and the note says plainly what was left out. Still short -> PARTIAL, as always.
  if (count !== null && written.rowCount < count && names.includes('Name') && names.length > 1) {
    const without = names.filter((n) => n !== 'Name');
    const retry = await copyAll(`SELECT ${without.join(', ')} FROM ${objectName}`);
    if (retry.rowCount === count) {
      notes.push(`Selecting the Name field made Salesforce return only ${written.rowCount} of ${count} rows, so Name was left out to keep every record.`);
      written = retry;
    } else if (retry.rowCount > written.rowCount) {
      notes.push(`Selecting the Name field returned only ${written.rowCount} of ${count} rows; without it ${retry.rowCount} came back, still short.`);
      written = retry;
    } else {
      // The retry was no better and replaced the file; redo the original so the file matches what is reported.
      written = await copyAll(soql);
    }
  }
  return verifyAndBuild(relFile, written, notes, {
    mode: 'FULL',
    watermark: hasStamp && written.maxStamp !== null ? new Date(written.maxStamp) : null,
  });
}

async function tryIncremental(
  gw: SfGateway,
  objectName: string,
  ctx: ExportCtx,
  names: string[],
  soql: string,
  relFile: string,
  hasIsDeleted: boolean,
  notes: string[],
): Promise<{ result: ItemResult } | { reason: string }> {
  const baseline = ctx.baseline!;
  const since = soqlTime(new Date(baseline.watermark!.getTime() - OVERLAP_MS));
  let maxStamp = baseline.watermark!.getTime();

  const changed = new Map<string, string>(); // id -> serialised row
  for await (const page of gw.queryPages(`${soql} WHERE SystemModstamp >= ${since}`)) {
    for (const rec of page.records) {
      const row = stripAttributes(rec);
      if (changed.size >= MAX_DELTA_ROWS) return { reason: 'too many records changed' };
      changed.set(String(row['Id']), JSON.stringify(row));
      const t = stampMs(row);
      if (t !== null && t > maxStamp) maxStamp = t;
    }
  }

  // Deleted (and merged-away) records are only visible to a query that includes the recycle bin.
  const deleted = new Set<string>();
  if (hasIsDeleted) {
    const delSoql = `SELECT Id FROM ${objectName} WHERE IsDeleted = true AND SystemModstamp >= ${since}`;
    for await (const page of gw.queryPages(delSoql, { includeDeleted: true })) {
      for (const rec of page.records) deleted.add(String((rec as Record<string, unknown>)['Id']));
    }
  }

  const w = await SnapshotWriter.open(relFile);
  let removed = 0;
  try {
    for await (const line of gzLines(baseline.lastFilePath)) {
      if (!line) continue;
      const id = idOfLine(line);
      if (id !== null && changed.has(id)) continue; // replaced by the newer version below
      if (id !== null && deleted.has(id)) {
        removed++;
        continue;
      }
      await w.writeLine(line);
    }
    for (const line of changed.values()) await w.writeLine(line);
  } catch (e) {
    w.abort();
    throw e;
  }
  const closed = await w.close();

  // Reconcile with Salesforce: after the merge the copy must hold exactly as many rows as the org does.
  const expected = await gw.countRows(objectName);
  if (expected !== closed.rows) {
    return { reason: `row count did not match Salesforce after merging (${closed.rows} vs ${expected}); records may have been purged` };
  }
  const added = changed.size;
  notes.push(`Incremental: ${added} records new or changed, ${removed} deleted since the previous copy.`);
  const result = await verifyAndBuild(
    relFile,
    { rowCount: closed.rows, expected, maxStamp, sha256: closed.sha256, bytes: closed.bytes },
    notes,
    { mode: 'INCREMENTAL', changedCount: added, deletedCount: removed, watermark: new Date(maxStamp) },
  );
  return { result };
}

const CHUNK = 400;

/** Types Salesforce hands back one file per bundle member, named "Type/Bundle/file". */
const FILE_PER_MEMBER_TYPES = new Set(['LightningComponentBundle', 'AuraDefinitionBundle', 'ExperienceBundle', 'DigitalExperienceBundle', 'WaveTemplateBundle']);

/**
 * Did this requested component come back? Salesforce does not always name it the way we asked:
 *  - Settings come back as "<Name>Settings/<Name>" (AccountSettings/Account);
 *  - bundles (Lightning web components...) come back as one entry per file;
 *  - folders come back under the base type (Report/MyFolder), not ReportFolder/MyFolder.
 */
export function wasRetrieved(m: { type: string; fullName: string }, got: Set<string>, baseType: string): boolean {
  const key = `${m.type}/${m.fullName}`;
  if (got.has(key)) return true;
  if (m.type === 'Settings' && got.has(`${m.fullName}Settings/${m.fullName}`)) return true;
  if (FILE_PER_MEMBER_TYPES.has(m.type)) {
    const prefix = `${m.type}/${m.fullName}/`;
    for (const g of got) if (g.startsWith(prefix)) return true;
  }
  if (m.type !== baseType && got.has(`${baseType}/${m.fullName}`)) return true;
  return false;
}

/**
 * Things Salesforce lists but will not hand over by name. Only applied to components that really
 * did not come back, and always recorded in the item note, so nothing is hidden.
 */
export function unretrievableReason(m: { type: string; fullName: string }, warnings: string[]): string | null {
  if (m.type === 'InstalledPackage') return 'installed package entries cannot be retrieved (the package itself is not org setup)';
  if (m.fullName === 'unfiled$public') return 'built-in public folder that Salesforce does not return';
  if (m.type === 'Layout' && /^[A-Za-z0-9]+__/.test(m.fullName)) return 'page layout of an object that belongs to an installed package';
  if (warnings.some((w) => w.includes(`Not a registered filter type: ${m.fullName}`))) return 'Salesforce says this is not a retrievable object';
  return null;
}

/** Salesforce itself refuses to list a few types in some orgs (for example ContentWorkspace). */
function listingUnsupported(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /INVALID_FIELD/.test(text) && /ManageableState/i.test(text);
}

/**
 * Copies one type of metadata (e.g. all Apex classes) as zip files straight from the
 * Salesforce Metadata API, then checks that every component we asked for came back.
 * Metadata is always copied in full.
 */
export async function exportMetadataType(
  gw: SfGateway,
  type: string,
  inFolder: boolean,
  runRelDir: string,
): Promise<ItemResult> {
  let all: Awaited<ReturnType<SfGateway['listMetadata']>>;
  try {
    all = await gw.listMetadata(type, inFolder);
  } catch (e) {
    if (!listingUnsupported(e)) throw e;
    return { status: 'SUCCEEDED', rowCount: 0, expectedCount: 0, files: [], note: 'Salesforce cannot list this type in this org (it rejects its own listing query), so nothing could be copied.' };
  }
  const retrievable = all.filter((m) => m.manageableState !== 'installed');
  const installedCount = all.length - retrievable.length;
  const baseNote = installedCount ? `${installedCount} components from installed managed packages are not copied (Salesforce does not allow it).` : undefined;
  if (retrievable.length === 0) {
    return { status: 'SUCCEEDED', rowCount: 0, expectedCount: 0, files: [], note: baseNote ?? 'No components of this type in the org.' };
  }

  const storage = getStorage();
  const dirRel = join(runRelDir, 'metadata', safeName(type));
  const files: FileEntry[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];
  const skipped: string[] = [];
  let found = 0;

  for (let i = 0; i < retrievable.length; i += CHUNK) {
    const chunk = retrievable.slice(i, i + CHUNK);
    const request: Record<string, string[]> = {};
    // Folders must be asked for as members of the base type (Report: [folder]), not as ReportFolder.
    for (const m of chunk) (request[inFolder ? type : m.type] ??= []).push(m.fullName);
    const result = await gw.retrieveMetadata(request);
    const got = new Set(result.found);
    for (const m of chunk) {
      if (wasRetrieved(m, got, type)) {
        found++;
        continue;
      }
      const why = unretrievableReason(m, result.warnings);
      if (why) skipped.push(`${m.type}/${m.fullName} (${why})`);
      else missing.push(`${m.type}/${m.fullName}`);
    }
    warnings.push(...result.warnings);
    const rel = join(dirRel, `part-${String(i / CHUNK + 1).padStart(3, '0')}.zip`);
    await storage.writeFile(rel, result.zip);
    const sha = await sha256OfRel(rel);
    const expectedSha = createHash('sha256').update(result.zip).digest('hex');
    if (sha !== expectedSha) {
      return { status: 'FAILED', files, error: 'Checksum check failed: a saved metadata file does not match what was received.' };
    }
    files.push({ path: rel, sha256: sha, bytes: result.zip.length });
  }

  const combined = createHash('sha256').update(files.map((f) => f.sha256).join('')).digest('hex');
  const bytes = files.reduce((s, f) => s + f.bytes, 0);
  const skippedNote = skipped.length
    ? `${skipped.length} not copied because Salesforce does not return them: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', ...' : ''}.`
    : undefined;
  const noteParts = [baseNote, skippedNote, warnings.length ? `Salesforce messages: ${warnings.slice(0, 3).join(' ; ')}` : undefined].filter(Boolean);
  const expectedTotal = retrievable.length - skipped.length;
  const base = {
    expectedCount: expectedTotal,
    rowCount: found,
    bytes,
    sha256: combined,
    filePath: dirRel,
    files,
    note: noteParts.join(' | ') || undefined,
  };
  if (missing.length > 0) {
    return { status: 'PARTIAL', ...base, error: `${missing.length} of ${expectedTotal} components did not come back (for example ${missing.slice(0, 3).join(', ')}).` };
  }
  return { status: 'SUCCEEDED', ...base };
}
