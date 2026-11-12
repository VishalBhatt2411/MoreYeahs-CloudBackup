import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bulkQueryRows } from '../src/salesforce/bulk.js';
import { soqlTooLongForUrl } from '../src/backup/exporters.js';

/** A tiny Bulk API 2.0 server that hands out its rows in several result pages, like Salesforce does. */
let server: Server;
let base = '';
const TOTAL = 4500;
const PAGE = 1000;
let deleted = 0;
let polls = 0;
let seenTokens: string[] = [];
let rejectFirstToken = false;
let jobState: 'complete' | 'failed' = 'complete';

function csvPage(from: number, to: number) {
  const lines = ['"Id","Name","Notes"'];
  for (let i = from; i < to; i++) lines.push(`"id${i}","Name ${i}","line one\nline ""two"", with comma"`);
  return lines.join('\n') + '\n';
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seenTokens.push(String(req.headers.authorization));
    if (rejectFirstToken && req.headers.authorization === 'Bearer old') {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify([{ errorCode: 'INVALID_SESSION_ID', message: 'expired' }]));
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/jobs/query')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'job1', state: 'UploadComplete' }));
    } else if (req.method === 'GET' && url.pathname.endsWith('/jobs/query/job1')) {
      polls++;
      const state = jobState === 'failed' ? 'Failed' : polls < 2 ? 'InProgress' : 'JobComplete';
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'job1', state, errorMessage: jobState === 'failed' ? 'too many rows' : undefined }));
    } else if (req.method === 'GET' && url.pathname.endsWith('/jobs/query/job1/results')) {
      const start = Number(url.searchParams.get('locator') ?? 0);
      const end = Math.min(start + PAGE, TOTAL);
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Sforce-NumberOfRecords': String(end - start),
        'Sforce-Locator': end >= TOTAL ? 'null' : String(end),
      }).end(csvPage(start, end));
    } else if (req.method === 'DELETE') {
      deleted++;
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('Bulk API 2.0 client', () => {
  it('reads every result page, not just the first one', async () => {
    polls = 0;
    deleted = 0;
    const pages: number[] = [];
    let ids = new Set<string>();
    for await (const rows of bulkQueryRows({
      http: { instanceUrl: base, apiVersion: '62.0', token: () => 'tok' },
      soql: 'SELECT Id, Name, Notes FROM Thing',
      pollIntervalMs: 5,
      pageSize: PAGE,
    })) {
      pages.push(rows.length);
      for (const r of rows) ids.add(r.Id!);
    }
    expect(pages).toEqual([1000, 1000, 1000, 1000, 500]);
    expect(ids.size).toBe(TOTAL);
    // job is cleaned up
    await new Promise((r) => setTimeout(r, 30));
    expect(deleted).toBe(1);
  });

  it('keeps quoted commas, quotes and line breaks inside a value', async () => {
    polls = 0;
    const first = (await bulkQueryRows({ http: { instanceUrl: base, apiVersion: '62.0', token: () => 't' }, soql: 'x', pollIntervalMs: 5 }).next()).value!;
    expect(first[0]!.Notes).toBe('line one\nline "two", with comma');
  });

  it('renews the login once when Salesforce answers 401, then carries on', async () => {
    polls = 0;
    seenTokens = [];
    rejectFirstToken = true;
    let n = 0;
    try {
      for await (const rows of bulkQueryRows({
        http: { instanceUrl: base, apiVersion: '62.0', token: () => 'old', refresh: async () => 'new' },
        soql: 'x',
        pollIntervalMs: 5,
      })) n += rows.length;
    } finally {
      rejectFirstToken = false;
    }
    expect(n).toBe(TOTAL);
    expect(seenTokens).toContain('Bearer new');
  });

  it('reports a failed job with its reason', async () => {
    polls = 0;
    jobState = 'failed';
    try {
      await expect(
        (async () => {
          for await (const _ of bulkQueryRows({ http: { instanceUrl: base, apiVersion: '62.0', token: () => 't' }, soql: 'x', pollIntervalMs: 5 })) void _;
        })(),
      ).rejects.toThrow(/BULK_JOB_FAILED.*too many rows/);
    } finally {
      jobState = 'complete';
    }
  });
});

describe('long queries', () => {
  it('flags a query too long for a GET address', () => {
    const wide = `SELECT ${Array.from({ length: 500 }, (_, i) => `Permissions${i}Field`).join(', ')} FROM PermissionSet`;
    expect(soqlTooLongForUrl(wide)).toBe(true);
    expect(soqlTooLongForUrl('SELECT Id, Name FROM Account')).toBe(false);
  });
});
