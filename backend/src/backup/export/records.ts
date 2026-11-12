import { humanizeApiName } from '../categories.js';
import { schemaRelPath } from '../exporters.js';
import { gzLines } from '../snapshot.js';
import { getStorage } from '../storage.js';
import type { Cell, Col } from './tables.js';

/** What the backup remembered about an object's fields while copying it (see exporters.writeSchema). */
export interface ObjectSchema {
  object: string;
  label: string;
  fields: { name: string; label: string; type: string }[];
}

export async function loadSchema(relDir: string, objectName: string): Promise<ObjectSchema | null> {
  const rel = schemaRelPath(relDir, objectName);
  if ((await getStorage().fileSize(rel)) === null) return null;
  try {
    const chunks: Buffer[] = [];
    for await (const c of getStorage().openRead(rel)) chunks.push(c as Buffer);
    const j = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<ObjectSchema>;
    if (!j || !Array.isArray(j.fields)) return null;
    return { object: j.object ?? objectName, label: j.label ?? objectName, fields: j.fields };
  } catch {
    return null;
  }
}

/** Column types Excel should store as real numbers. */
const NUMBER_TYPES = new Set(['int', 'double', 'currency', 'percent', 'long']);

const FIELD_TYPE_WORDS: Record<string, string> = {
  id: 'Record ID', reference: 'Link to another record', string: 'Text', textarea: 'Long text', picklist: 'Picklist', multipicklist: 'Multi-select picklist',
  boolean: 'Checkbox', int: 'Whole number', double: 'Number', long: 'Whole number', currency: 'Currency', percent: 'Percent', date: 'Date', datetime: 'Date and time',
  time: 'Time', email: 'Email', phone: 'Phone', url: 'Web address', encryptedstring: 'Encrypted text', combobox: 'Combo box', address: 'Address', location: 'Location',
  base64: 'File content', anyType: 'Any type', complexvalue: 'Complex value',
};
export const fieldTypeWords = (t: string) => FIELD_TYPE_WORDS[t] ?? t;

export interface Columns {
  /** The record key behind each column, in order. */
  keys: string[];
  cols: Col[];
  types: string[];
}

/**
 * Works out the columns of an object's sheet: "Id" first, readable headings (the label people see in
 * Salesforce, or the API name if asked), and a type for each so dates and numbers land as real
 * dates and numbers. A label used twice gets its API name added so no two columns look alike.
 */
export function buildColumns(schema: ObjectSchema | null, rowKeys: string[], headers: 'label' | 'api'): Columns {
  const known = new Map((schema?.fields ?? []).map((f) => [f.name, f]));
  const present = new Set(rowKeys);
  // Schema order when we have it (that is the order the data was asked for), else the order in the data.
  const ordered = schema ? schema.fields.map((f) => f.name).filter((n) => present.size === 0 || present.has(n)) : [];
  for (const k of rowKeys) if (k !== 'attributes' && !ordered.includes(k)) ordered.push(k);
  const keys = ordered.sort((a, b) => (a === 'Id' ? -1 : b === 'Id' ? 1 : 0));

  const labelOf = (k: string) => (headers === 'api' ? k : known.get(k)?.label || humanizeApiName(k));
  const count = new Map<string, number>();
  for (const k of keys) count.set(labelOf(k).toLowerCase(), (count.get(labelOf(k).toLowerCase()) ?? 0) + 1);

  const types: string[] = [];
  const cols = keys.map((k) => {
    const label = labelOf(k);
    const t = known.get(k)?.type ?? 'string';
    types.push(t);
    const header = headers === 'label' && (count.get(label.toLowerCase()) ?? 0) > 1 ? `${label} (${k})` : label;
    const kind: Col['kind'] = t === 'date' ? 'date' : t === 'datetime' ? 'datetime' : NUMBER_TYPES.has(t) ? 'number' : t === 'boolean' ? 'bool' : 'text';
    return { header, kind, width: t === 'id' || t === 'reference' ? 20 : t === 'textarea' ? 40 : undefined } satisfies Col;
  });
  return { keys, cols, types };
}

/** Salesforce writes +0000; JavaScript wants +00:00. */
function parseSfDate(s: string): Date | null {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toCell(v: unknown, type: string): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'string') {
    if (type === 'date' || type === 'datetime') return parseSfDate(v) ?? v;
    if (NUMBER_TYPES.has(type) && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return v;
  }
  return JSON.stringify(v);
}

/** The first record of an object's copy, to learn its columns. Null when the object has no records. */
export async function peekKeys(rel: string): Promise<string[]> {
  for await (const line of gzLines(rel)) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      return Object.keys(row);
    } catch {
      /* try the next line */
    }
  }
  return [];
}

/** Streams an object's copy as spreadsheet rows. Memory use stays flat however many records there are. */
export async function* recordRows(rel: string, columns: Columns): AsyncGenerator<Cell[]> {
  for await (const line of gzLines(rel)) {
    if (!line) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    yield columns.keys.map((k, i) => toCell(row[k], columns.types[i]));
  }
}
