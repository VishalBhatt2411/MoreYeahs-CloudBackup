import { parse } from 'csv-parse/sync';

/**
 * Our own Bulk API 2.0 query client.
 *
 * Why not jsforce's `bulk2.query`? In jsforce 3.13 every result page of a large job is piped into
 * the same stream, and the stream is closed after the first page. A 58,071-row job came back with
 * 8,387 rows. Here each result page is fetched one after the other (following `Sforce-Locator`),
 * parsed on its own, and handed on. The caller still compares the total with Salesforce's count.
 */
export interface BulkHttp {
  instanceUrl: string;
  apiVersion: string;
  /** The current access token. */
  token: () => string;
  /** Called after a 401. Returns a fresh access token, or throws. */
  refresh?: () => Promise<string>;
  /** Replaceable for tests. */
  fetchImpl?: typeof fetch;
}

export interface BulkQueryRun {
  http: BulkHttp;
  soql: string;
  scanAll?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Rows per result page asked of Salesforce. */
  pageSize?: number;
  /** Called after every page (rows so far). */
  onProgress?: (rowsSoFar: number) => void;
}

interface Reply {
  status: number;
  headers: Headers;
  text: string;
}

async function call(http: BulkHttp, method: string, path: string, body?: unknown, accept = 'application/json'): Promise<Reply> {
  const f = http.fetchImpl ?? fetch;
  const url = new URL(`services/data/v${http.apiVersion}/jobs/query${path}`, http.instanceUrl).toString();
  const attempt = async (token: string) =>
    f(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  let res = await attempt(http.token());
  if (res.status === 401 && http.refresh) res = await attempt(await http.refresh());
  const text = await res.text();
  if (!res.ok && method !== 'DELETE') {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as Array<{ errorCode?: string; message?: string }> | { errorCode?: string; message?: string };
      const first = Array.isArray(j) ? j[0] : j;
      if (first?.message) detail = `${first.errorCode ?? res.status}: ${first.message}`;
    } catch {
      /* keep the raw text */
    }
    throw new Error(`BULK_HTTP_${res.status}: ${detail}`);
  }
  return { status: res.status, headers: res.headers, text };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a Bulk API 2.0 query job and yields its rows page by page (all values are text). */
export async function* bulkQueryRows(run: BulkQueryRun): AsyncGenerator<Record<string, string>[]> {
  const { http } = run;
  const created = JSON.parse(
    (
      await call(http, 'POST', '', {
        operation: run.scanAll ? 'queryAll' : 'query',
        query: run.soql,
        contentType: 'CSV',
        columnDelimiter: 'COMMA',
        lineEnding: 'LF',
      })
    ).text,
  ) as { id: string };
  const jobId = created.id;

  try {
    const deadline = Date.now() + (run.timeoutMs ?? 60 * 60 * 1000);
    const interval = run.pollIntervalMs ?? 5000;
    for (;;) {
      const info = JSON.parse((await call(http, 'GET', `/${jobId}`)).text) as { state: string; errorMessage?: string; numberRecordsProcessed?: number };
      if (info.state === 'JobComplete') break;
      if (info.state === 'Failed' || info.state === 'Aborted') {
        throw new Error(`BULK_JOB_FAILED: ${info.state}${info.errorMessage ? ` - ${info.errorMessage}` : ''}`);
      }
      if (Date.now() > deadline) throw new Error('BULK_JOB_TIMEOUT: the Bulk API job did not finish in time');
      await sleep(interval);
    }

    let locator: string | null = null;
    let total = 0;
    for (;;) {
      const qs = new URLSearchParams({ maxRecords: String(run.pageSize ?? 20000) });
      if (locator) qs.set('locator', locator);
      const page = await call(http, 'GET', `/${jobId}/results?${qs.toString()}`, undefined, 'text/csv');
      // Every page is a complete CSV with its own header line.
      const rows = parse(page.text, { columns: true, skip_empty_lines: true, relax_quotes: false, bom: true }) as Record<string, string>[];
      total += rows.length;
      const said = Number(page.headers.get('sforce-numberofrecords'));
      if (Number.isFinite(said) && page.headers.has('sforce-numberofrecords') && said !== rows.length) {
        throw new Error(`BULK_PAGE_MISMATCH: Salesforce said this page has ${said} rows but ${rows.length} were read`);
      }
      if (rows.length > 0) yield rows;
      run.onProgress?.(total);
      const next = page.headers.get('sforce-locator');
      if (!next || next === 'null') break;
      locator = next;
    }
  } finally {
    // Free the job on Salesforce's side; ignore any problem doing so.
    call(http, 'DELETE', `/${jobId}`).catch(() => undefined);
  }
}
