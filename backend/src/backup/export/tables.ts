import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import ExcelJS from 'exceljs';

/**
 * Two ways to write the same tables: one Excel workbook with a sheet per table, or one CSV file
 * per table. The rest of the export code only talks to the `TableSink` shape.
 */

export type Cell = string | number | boolean | Date | null | { text: string; link: string };

export interface Col {
  header: string;
  /** How Excel should treat the column. Text is the default. */
  kind?: 'text' | 'number' | 'bool' | 'date' | 'datetime';
  width?: number;
}

export type Rows = Iterable<Cell[]> | AsyncIterable<Cell[]>;

export interface TableSink {
  /** Gives a table its final name up front (so an index page can link to it before it is written). Excel sheet names are shortened and made unique. */
  reserve(title: string): string;
  addTable(name: string, cols: Col[], rows: Rows): Promise<void>;
  close(): Promise<void>;
  /** Cells that were cut because Excel allows at most 32,767 characters in one cell. */
  readonly truncatedCells: number;
}

export const MAX_SHEET_ROWS = 1_048_575; // data rows per sheet (Excel allows 1,048,576 including the header)
export const MAX_CELL_CHARS = 32_000;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** A name that is safe as a file or folder name on Windows, macOS and Linux. */
export function fileSafe(s: string, max = 80): string {
  const cleaned = s.replace(/[\\/:*?"<>|\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return (cleaned || 'item').slice(0, max);
}

function sheetSafe(s: string): string {
  const cleaned = s.replace(/[\[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '');
  return (cleaned || 'Sheet').slice(0, 31);
}

/** Makes `name` unique among `taken` (case-insensitive) by adding " (2)", " (3)" ... within `max` characters. */
function uniqueName(name: string, taken: Set<string>, max: number): string {
  let candidate = name.slice(0, max);
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    candidate = name.slice(0, max - suffix.length) + suffix;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** Spreadsheet programs run text that starts with = + - @ as a formula. A leading ' makes it plain text. */
export function neutraliseFormula(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

const isoOrEmpty = (v: Date) => (Number.isNaN(v.getTime()) ? '' : v.toISOString());

// -------------------------------------------------------------------------------------------
// Excel
// -------------------------------------------------------------------------------------------

const HEADER_FILL = 'FF1F3A5F';
const NUM_FMT: Record<string, string> = { date: 'yyyy-mm-dd', datetime: 'yyyy-mm-dd hh:mm:ss' };

export class XlsxSink implements TableSink {
  truncatedCells = 0;
  private wb: ExcelJS.stream.xlsx.WorkbookWriter;
  private taken = new Set<string>();
  private reserved = new Map<string, string>();

  constructor(private file: string) {
    this.wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useStyles: true, useSharedStrings: false });
    this.wb.creator = 'MoreYeahs CloudBackup';
    this.wb.created = new Date();
  }

  reserve(title: string): string {
    const name = uniqueName(sheetSafe(title), this.taken, 31);
    this.reserved.set(title, name);
    return name;
  }

  private sheet(name: string, cols: Col[]) {
    const ws = this.wb.addWorksheet(name, {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { defaultColWidth: 16 },
    });
    cols.forEach((c, i) => {
      ws.getColumn(i + 1).width = Math.min(60, Math.max(10, c.width ?? Math.ceil(c.header.length * 1.2) + 4));
    });
    const head = ws.addRow(cols.map((c) => c.header));
    head.height = 22;
    head.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
    head.commit();
    return ws;
  }

  private value(c: Cell): ExcelJS.CellValue {
    if (c === null) return null;
    if (typeof c === 'string') {
      const s = c.replace(CONTROL, '');
      if (s.length > MAX_CELL_CHARS) {
        this.truncatedCells++;
        return `${s.slice(0, MAX_CELL_CHARS)}… [cut: Excel cells hold at most 32,767 characters]`;
      }
      return s;
    }
    if (c instanceof Date) return Number.isNaN(c.getTime()) ? null : c;
    if (typeof c === 'object') return { text: c.text, hyperlink: c.link };
    return c;
  }

  async addTable(title: string, cols: Col[], rows: Rows): Promise<void> {
    const first = this.reserved.get(title) ?? this.reserve(title);
    this.reserved.delete(title);
    let ws = this.sheet(first, cols);
    let n = 0;
    let part = 1;
    const finish = () => {
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, cols.length) } };
      ws.commit();
    };
    for await (const r of rows) {
      if (n === MAX_SHEET_ROWS) {
        finish();
        part++;
        ws = this.sheet(uniqueName(sheetSafe(`${title} (part ${part})`), this.taken, 31), cols);
        n = 0;
      }
      const row = ws.addRow(r.map((c) => this.value(c)));
      cols.forEach((c, i) => {
        const fmt = c.kind ? NUM_FMT[c.kind] : undefined;
        if (fmt && r[i] instanceof Date) row.getCell(i + 1).numFmt = fmt;
        const cell = r[i];
        if (cell && typeof cell === 'object' && !(cell instanceof Date)) row.getCell(i + 1).font = { color: { argb: 'FF0B5CAD' }, underline: true };
      });
      row.commit();
      n++;
    }
    finish();
  }

  async close() {
    await mkdir(dirname(this.file), { recursive: true }).catch(() => undefined);
    await this.wb.commit();
  }
}

// -------------------------------------------------------------------------------------------
// CSV
// -------------------------------------------------------------------------------------------

export function csvCell(v: Cell): string {
  if (v === null) return '';
  let s: string;
  if (v instanceof Date) s = isoOrEmpty(v);
  else if (typeof v === 'object') s = v.text;
  else s = String(v);
  s = neutraliseFormula(s.replace(CONTROL, ''));
  return /[",\r\n]/.test(s) || s.startsWith(' ') || s.endsWith(' ') ? `"${s.replace(/"/g, '""')}"` : s;
}

export class CsvSink implements TableSink {
  truncatedCells = 0;
  private taken = new Set<string>();
  private reserved = new Map<string, string>();

  constructor(private dir: string) {}

  reserve(title: string): string {
    const name = uniqueName(fileSafe(title, 100), this.taken, 100);
    this.reserved.set(title, name);
    return name;
  }

  async addTable(title: string, cols: Col[], rows: Rows): Promise<void> {
    const name = this.reserved.get(title) ?? this.reserve(title);
    this.reserved.delete(title);
    await mkdir(this.dir, { recursive: true });
    const out = createWriteStream(join(this.dir, `${name}.csv`));
    const write = (s: string) =>
      new Promise<void>((resolve, reject) => {
        out.once('error', reject);
        if (out.write(s)) {
          out.off('error', reject);
          resolve();
        } else {
          out.once('drain', () => {
            out.off('error', reject);
            resolve();
          });
        }
      });
    // The byte-order mark makes Excel read accented and non-Latin characters correctly.
    await write('﻿' + cols.map((c) => csvCell(c.header)).join(',') + '\r\n');
    let buf = '';
    for await (const r of rows) {
      buf += r.map(csvCell).join(',') + '\r\n';
      if (buf.length > 64 * 1024) {
        await write(buf);
        buf = '';
      }
    }
    if (buf) await write(buf);
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.end(resolve);
    });
  }

  async close() {
    /* nothing to finish: every table is its own file */
  }
}
