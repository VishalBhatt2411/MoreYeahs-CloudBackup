import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { CATEGORIES, categoryById, categoryOfItem, humanizeApiName, metadataTypeLabel, type Category } from '../categories.js';
import { getStorage, guardTenantPath, runRelDir } from '../storage.js';
import { convertMetadataZip, TableAcc } from './metadata.js';
import { buildColumns, fieldTypeWords, loadSchema, peekKeys, recordRows } from './records.js';
import { CsvSink, fileSafe, XlsxSink, type Cell, type Col, type Rows, type TableSink } from './tables.js';

/**
 * Builds the readable copy of a backup: Excel workbooks (or CSV files) split by kind of data,
 * with an index page, plain-language headings and a guide to every column. Nothing here changes
 * the saved backup: it only reads it.
 */

export type Format = 'xlsx' | 'csv';

export interface ExportItem {
  id: string;
  kind: 'METADATA' | 'OBJECT';
  name: string;
  status: string;
  expectedCount: number | null;
  rowCount: number | null;
  filePath: string | null;
  note: string | null;
  error: string | null;
  mode: string | null;
  changedCount: number | null;
  deletedCount: number | null;
}

export interface ExportRun {
  id: string;
  tenantId: string;
  connectionId: string;
  status: string;
  mode: string;
  createdAt: Date;
  finishedAt: Date | null;
  message: string | null;
}

export interface ExportRequest {
  run: ExportRun;
  orgLabel: string;
  orgUsername: string;
  items: ExportItem[];
  format: Format;
  /** Column headings: the labels people see in Salesforce, or the technical API names. */
  headers: 'label' | 'api';
  /** Only this section (a category id such as "data.business" or "meta.apex"). */
  category?: string;
  /** Only this one object or configuration type. */
  itemId?: string;
  outDir: string;
}

export interface ExportResult {
  /** The folder that holds everything that was built. */
  rootDir: string;
  /** Name for the folder inside a zip download. */
  rootName: string;
  /** Every file built, relative to rootDir. */
  files: string[];
  /** Cells shortened because Excel cannot hold more than 32,767 characters in one. */
  truncatedCells: number;
}

const SHEETS_PER_WORKBOOK = 58; // plus the index sheet and the field guide = 60

interface TableDef {
  title: string;
  cols: Col[];
  rows: Rows;
  /** The index page's cells after the sheet name. */
  index: Cell[];
}

interface Target {
  format: Format;
  dir: string;
  /** Workbook file name without ".xlsx" (Excel only). */
  name: string;
}

const col = (header: string, width?: number, kind?: Col['kind']): Col => ({ header, width, kind });

/** Writes one workbook (or one folder of CSVs) with an index first. */
async function writePart(t: Target, indexCols: Col[], defs: TableDef[], extraIndex: Cell[][], counters: { cut: number }) {
  await mkdir(t.dir, { recursive: true });
  const xlsx = t.format === 'xlsx';
  const sink: TableSink = xlsx ? new XlsxSink(join(t.dir, `${fileSafe(t.name, 120)}.xlsx`)) : new CsvSink(t.dir);
  const indexTitle = xlsx ? 'Index' : '_Index';
  sink.reserve(indexTitle);
  const names = defs.map((d) => sink.reserve(d.title));
  const rows: Cell[][] = defs.map((d, i) => [xlsx ? { text: names[i], link: `#'${names[i].replace(/'/g, "''")}'!A1` } : names[i], ...d.index]);
  rows.push(...extraIndex);
  await sink.addTable(indexTitle, [col(xlsx ? 'Sheet (click to open)' : 'File', 34), ...indexCols], rows);
  for (const d of defs) await sink.addTable(d.title, d.cols, d.rows);
  await sink.close();
  counters.cut += sink.truncatedCells;
}

/** Splits into workbook-sized groups (Excel only; CSV has no sheet limit). */
function chunk<T>(list: T[], size: number, format: Format): T[][] {
  if (format === 'csv' || list.length <= size) return [list];
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const partName = (base: string, n: number, of: number) => (of > 1 ? `${base} (part ${n} of ${of})` : base);

function uniqueTitle(label: string, api: string, used: Set<string>): string {
  let title = label;
  if (used.has(title.toLowerCase())) title = `${label} (${api})`;
  used.add(title.toLowerCase());
  return title;
}

async function readAll(rel: string): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for await (const c of getStorage().openRead(rel)) parts.push(c as Buffer);
  return new Uint8Array(Buffer.concat(parts));
}

// -------------------------------------------------------------------------------------------
// Records (object data)
// -------------------------------------------------------------------------------------------

async function buildRecordSection(req: ExportRequest, cat: Category, items: ExportItem[], dir: string, counters: { cut: number }) {
  const relDir = runRelDir(req.run.tenantId, req.run.connectionId, req.run.id);
  const used = new Set<string>(['index', '_index', 'field guide']);
  const defs: Array<{ def: TableDef; guide: Cell[][] }> = [];
  const extra: Cell[][] = [];

  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
  for (const item of sorted) {
    const schema = await loadSchema(relDir, item.name);
    const label = schema?.label || humanizeApiName(item.name);
    const saved = (item.status === 'SUCCEEDED' || item.status === 'PARTIAL') && item.filePath;
    if (!saved) {
      extra.push([label, item.name, null, `Not copied: ${item.error ?? item.note ?? item.status}`]);
      continue;
    }
    const rel = guardTenantPath(req.run.tenantId, item.filePath!);
    const keys = await peekKeys(rel);
    if (keys.length === 0) {
      extra.push([label, item.name, 0, 'No records in this object']);
      continue;
    }
    const columns = buildColumns(schema, keys, req.headers);
    const title = uniqueTitle(label, item.name, used);
    const notes = [
      item.status === 'PARTIAL' ? 'Partly copied - see the run details' : '',
      item.mode === 'INCREMENTAL' ? `Up to date copy (${item.changedCount ?? 0} changed, ${item.deletedCount ?? 0} deleted since the last backup)` : '',
    ].filter(Boolean).join('. ');
    const guide: Cell[][] = columns.keys.map((k, i) => [label, item.name, columns.cols[i].header, k, fieldTypeWords(columns.types[i])]);
    defs.push({
      def: { title, cols: columns.cols, rows: recordRows(rel, columns), index: [item.name, item.rowCount ?? 0, notes] },
      guide,
    });
  }

  const indexCols = [col('API name', 26), col('Records', 12, 'number'), col('Notes', 50)];
  const groups = chunk(defs, SHEETS_PER_WORKBOOK, req.format);
  for (let g = 0; g < groups.length; g++) {
    const guideRows = groups[g].flatMap((d) => d.guide);
    const guideDef: TableDef = {
      title: 'Field Guide',
      cols: [col('Object', 24), col('Column heading', 30), col('API name', 28), col('What it holds', 24)],
      rows: guideRows.map((r) => [r[0], r[2], r[3], r[4]]),
      index: [null, guideRows.length, 'Every column in this workbook: its heading, technical name and kind of value'],
    };
    const tableDefs = [guideDef, ...groups[g].map((d) => d.def)];
    await writePart(
      { format: req.format, dir, name: partName(fileSafe(cat.label), g + 1, groups.length) },
      indexCols,
      tableDefs,
      g === 0 ? extra : [],
      counters,
    );
  }
  // Only empty or skipped objects: still write an index so the person can see why.
  if (groups.length === 1 && groups[0].length === 0 && extra.length) {
    await writePart({ format: req.format, dir, name: fileSafe(cat.label) }, indexCols, [], extra, counters);
  }
}

// -------------------------------------------------------------------------------------------
// Configuration (metadata)
// -------------------------------------------------------------------------------------------

const SOURCE_FILE_CAP = 20_000;

function safeSegments(rel: string): string[] {
  return rel
    .split('/')
    .map((s) => s.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').trim())
    .filter((s) => s && s !== '.' && s !== '..');
}

async function buildConfigSection(req: ExportRequest, cat: Category, items: ExportItem[], dir: string, counters: { cut: number }) {
  const storage = getStorage();
  const acc = new TableAcc();
  const typeRows: Cell[][] = [];
  let sourceFiles = 0;
  const onSource = (rel: string, data: Uint8Array) => {
    if (sourceFiles >= SOURCE_FILE_CAP) return;
    const parts = safeSegments(rel);
    if (parts.length === 0) return;
    const target = join(dir, ...parts);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    sourceFiles++;
  };

  for (const item of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
    const label = metadataTypeLabel(item.name);
    let components = 0;
    let unreadable = 0;
    if (item.filePath) {
      const folder = guardTenantPath(req.run.tenantId, item.filePath);
      const zips = (await storage.listFiles(folder)).filter((f) => f.toLowerCase().endsWith('.zip')).sort();
      for (const z of zips) {
        const r = convertMetadataZip(await readAll(posix.join(folder, z)), label, acc, onSource);
        components += r.components;
        unreadable += r.unreadable;
      }
    }
    const note = [item.error, item.note, unreadable ? `${unreadable} file(s) could not be read` : ''].filter(Boolean).join('. ');
    typeRows.push([label, item.name, components, item.status === 'SUCCEEDED' ? 'Saved' : item.status === 'PARTIAL' ? 'Partly saved' : item.status === 'FAILED' ? 'Not saved' : item.status, note]);
  }

  const defs: TableDef[] = [
    {
      title: 'Types Saved',
      cols: [col('Configuration type', 30), col('Salesforce name', 28), col('Components', 12, 'number'), col('Status', 14), col('Notes', 50)],
      rows: typeRows,
      index: [typeRows.length, 'One row for each kind of configuration in this section'],
    },
    ...[...acc.tables.entries()].map(([title, t]) => ({
      title,
      cols: t.cols,
      rows: t.rows,
      index: [t.rows.length, t.capped ? 'Only the first 250,000 rows are shown here. The raw archive has everything.' : ''] as Cell[],
    })),
  ];
  const groups = chunk(defs, SHEETS_PER_WORKBOOK + 1, req.format);
  for (let g = 0; g < groups.length; g++) {
    await writePart(
      { format: req.format, dir, name: partName(fileSafe(cat.label), g + 1, groups.length) },
      [col('Rows', 10, 'number'), col('What it shows', 60)],
      groups[g],
      [],
      counters,
    );
  }
}

// -------------------------------------------------------------------------------------------
// Summary and README
// -------------------------------------------------------------------------------------------

interface Manifest {
  apiVersion?: string;
  org?: { name?: string; username?: string; environment?: string };
  notCopied?: Array<{ name: string; label?: string; reason: string }>;
  limits?: string[];
}

async function readManifest(relDir: string): Promise<Manifest | null> {
  const rel = posix.join(relDir.replace(/\\/g, '/'), 'manifest.json');
  if ((await getStorage().fileSize(rel)) === null) return null;
  try {
    return JSON.parse(Buffer.from(await readAll(rel)).toString('utf8')) as Manifest;
  } catch {
    return null;
  }
}

const utc = (d: Date | null) => (d ? d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '');
const statusWords = (s: string) => (s === 'SUCCEEDED' ? 'Saved' : s === 'PARTIAL' ? 'Partly saved' : s === 'FAILED' ? 'Not saved' : s === 'SKIPPED' ? 'Skipped' : s);

async function buildSummary(req: ExportRequest, rootDir: string, counters: { cut: number }) {
  const relDir = runRelDir(req.run.tenantId, req.run.connectionId, req.run.id);
  const manifest = await readManifest(relDir);
  const objects = req.items.filter((i) => i.kind === 'OBJECT');
  const meta = req.items.filter((i) => i.kind === 'METADATA');
  const totalRows = objects.reduce((a, i) => a + (i.rowCount ?? 0), 0);

  const overview: Cell[][] = [
    ['Organization', req.orgLabel],
    ['Salesforce username', req.orgUsername],
    ['Environment', manifest?.org?.environment ?? ''],
    ['Backup finished', utc(req.run.finishedAt ?? req.run.createdAt)],
    ['Backup type', req.run.mode === 'INCREMENTAL' ? 'Incremental (a complete copy, refreshed with only what changed)' : 'Full copy'],
    ['Result', req.run.message ?? statusWords(req.run.status)],
    ['Salesforce API version', manifest?.apiVersion ?? ''],
    ['Objects with record data', objects.length],
    ['Total records saved', totalRows],
    ['Configuration types saved', meta.length],
    ['Times are shown in', 'UTC (Coordinated Universal Time)'],
    ['Backup reference', req.run.id],
  ];

  const everything: Cell[][] = [...req.items]
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'OBJECT' ? -1 : 1))
    .map((i) => {
      const cat = categoryById(categoryOfItem(i.kind, i.name));
      return [
        i.kind === 'OBJECT' ? 'Records' : 'Configuration',
        cat?.label ?? '',
        i.kind === 'OBJECT' ? humanizeApiName(i.name) : metadataTypeLabel(i.name),
        i.name,
        i.kind === 'OBJECT' ? i.rowCount ?? 0 : null,
        statusWords(i.status),
        [i.error, i.note].filter(Boolean).join('. '),
      ];
    });

  const defs: TableDef[] = [
    { title: 'Overview', cols: [col('', 30), col('', 70)].map((c, i) => ({ ...c, header: i === 0 ? 'About this backup' : '' })), rows: overview, index: [overview.length, 'Which org, when, and what the backup holds'] },
    {
      title: 'All Items',
      cols: [col('Section', 14), col('Category', 30), col('Name', 30), col('Salesforce name', 28), col('Records', 12, 'number'), col('Status', 14), col('Notes', 50)],
      rows: everything,
      index: [everything.length, 'Every object and configuration type in this backup and how it went'],
    },
  ];
  if (manifest?.notCopied?.length) {
    defs.push({
      title: 'Not Copied',
      cols: [col('Object', 30), col('Salesforce name', 28), col('Why not', 80)],
      rows: manifest.notCopied.map((e) => [e.label || humanizeApiName(e.name), e.name, e.reason]),
      index: [manifest.notCopied.length, 'Objects left out and the reason for each'],
    });
  }
  if (manifest?.limits?.length) {
    defs.push({ title: 'Good to Know', cols: [col('Limits of this backup', 120)], rows: manifest.limits.map((l) => [l]), index: [manifest.limits.length, 'What a backup does not include'] });
  }

  const target: Target = { format: req.format, dir: req.format === 'xlsx' ? rootDir : join(rootDir, '00 Summary'), name: '00 Summary' };
  await writePart(target, [col('Rows', 10, 'number'), col('What it shows', 70)], defs, [], counters);
}

function readme(req: ExportRequest, rootName: string, hasRecords: boolean, hasConfig: boolean): string {
  const f = req.format === 'xlsx' ? 'Excel workbook' : 'CSV file';
  const lines = [
    `${rootName}`,
    '='.repeat(rootName.length),
    '',
    `Organization: ${req.orgLabel} (${req.orgUsername})`,
    `Backup finished: ${utc(req.run.finishedAt ?? req.run.createdAt)}`,
    '',
    'WHAT IS IN THIS FOLDER',
    '',
    `00 Summary      The overview: which org, when, how it went, every item and what could not be copied.`,
  ];
  if (hasRecords) lines.push('1 Records       The data stored in your objects (accounts, contacts, cases ...), grouped by kind of data. One sheet per object.');
  if (hasConfig) lines.push('2 Configuration How the org is set up: security, code, automation, layouts, settings ... grouped by topic, written as plain tables.');
  lines.push(
    '',
    'HOW TO READ IT',
    '',
    `- Each section holds ${f}s. ${req.format === 'xlsx' ? 'The first sheet, "Index", lists every sheet and links to it. "Field Guide" explains every column.' : 'The file "_Index.csv" lists the other files.'}`,
    '- Column headings use the names people see in Salesforce. Dates are in UTC.',
    '- An empty cell means the field had no value in Salesforce.',
    '- Configuration tables show the main settings in plain words. The original Salesforce files (the "raw archive") hold every detail and are what a restore would use.',
    '- Apex code and Visualforce pages are saved as readable text files in a "Source code" folder next to their tables.',
    '',
    'WHAT A BACKUP DOES NOT INCLUDE',
    '',
    '- Files and attachment contents, and binary fields.',
    '- Metadata from installed managed packages (Salesforce does not provide it).',
    '',
    'Created by MoreYeahs CloudBackup.',
    '',
  );
  return lines.join('\r\n');
}

// -------------------------------------------------------------------------------------------
// Entry point
// -------------------------------------------------------------------------------------------

async function listTree(root: string, sub = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, sub), { withFileTypes: true })) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listTree(root, rel)));
    else out.push(rel);
  }
  return out.sort();
}

export async function buildExport(req: ExportRequest): Promise<ExportResult> {
  const counters = { cut: 0 };
  const day = (req.run.finishedAt ?? req.run.createdAt).toISOString().slice(0, 10);
  const rootName = `${fileSafe(req.orgLabel, 50)} backup ${day}`;
  const flat = !!(req.category || req.itemId);
  const rootDir = join(req.outDir, rootName);
  await mkdir(rootDir, { recursive: true });

  let items = req.items;
  if (req.itemId) items = items.filter((i) => i.id === req.itemId);
  if (req.category) items = items.filter((i) => categoryOfItem(i.kind, i.name) === req.category);

  const byCat = new Map<string, ExportItem[]>();
  for (const i of items) {
    const id = categoryOfItem(i.kind, i.name);
    byCat.set(id, [...(byCat.get(id) ?? []), i]);
  }

  let hasRecords = false;
  let hasConfig = false;
  for (const cat of CATEGORIES) {
    const list = byCat.get(cat.id);
    if (!list?.length) continue;
    const isData = cat.kind === 'data';
    if (isData) hasRecords = true;
    else hasConfig = true;
    const dir = flat ? rootDir : join(rootDir, isData ? '1 Records' : '2 Configuration', `${cat.order} ${fileSafe(cat.label, 60)}`);
    if (isData) await buildRecordSection(req, cat, list, dir, counters);
    else await buildConfigSection(req, cat, list, dir, counters);
  }

  if (!flat) {
    await buildSummary({ ...req, items }, rootDir, counters);
    await writeFile(join(rootDir, 'README.txt'), readme(req, rootName, hasRecords, hasConfig), 'utf8');
  }
  return { rootDir, rootName, files: await listTree(rootDir), truncatedCells: counters.cut };
}
