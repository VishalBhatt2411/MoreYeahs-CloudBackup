import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, formatBytes, formatDate, type Connection } from '../api';
import { canExport, useAuth } from '../auth';
import { Notice, PageHead, StatusPill, useLoad } from '../ui';

interface Snapshot { id: string; connectionId: string; orgLabel: string; status: string; mode: string; createdAt: string; finishedAt: string | null }
interface ObjectRow { name: string; status: string; rowCount: number | null; bytes: number | null; mode: string | null }
interface Page { object: string; columns: string[]; records: Record<string, unknown>[]; offset: number; limit: number; hasMore: boolean; total: number | null }

const PAGE = 50;

const cell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/** Look into a finished backup without downloading it: pick a backup, an object, then page through its records. */
export default function ExplorerPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const connectionId = params.get('org') ?? '';
  const runId = params.get('run') ?? '';
  const objectName = params.get('object') ?? '';
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');

  const set = (next: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) (v ? p.set(k, v) : p.delete(k));
    setParams(p, { replace: true });
  };

  const orgs = useLoad(() => api<{ connections: Connection[] }>('/connections'), []);
  const connections = orgs.data?.connections ?? [];
  // Choose the first org by default so the page is useful straight away.
  useEffect(() => {
    if (!connectionId && connections.length > 0) set({ org: connections[0].id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections.length]);

  const snaps = useLoad(
    () => (connectionId ? api<{ snapshots: Snapshot[] }>(`/explorer/snapshots?connectionId=${encodeURIComponent(connectionId)}`) : Promise.resolve({ snapshots: [] as Snapshot[] })),
    [connectionId],
  );
  const snapshots = snaps.data?.snapshots ?? [];
  useEffect(() => {
    if (snaps.data && connectionId && !snapshots.some((s) => s.id === runId)) set({ run: snapshots[0]?.id ?? '', object: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snaps.data]);

  const objects = useLoad(
    () => (runId ? api<{ objects: ObjectRow[] }>(`/explorer/runs/${encodeURIComponent(runId)}/objects`) : Promise.resolve({ objects: [] as ObjectRow[] })),
    [runId],
  );
  const objList = objects.data?.objects ?? [];

  const page = useLoad(
    () =>
      runId && objectName
        ? api<Page>(`/explorer/runs/${encodeURIComponent(runId)}/objects/${encodeURIComponent(objectName)}/records?offset=${offset}&limit=${PAGE}${q ? `&q=${encodeURIComponent(q)}` : ''}`)
        : Promise.resolve(null),
    [runId, objectName, offset, q],
  );
  const data = page.data;

  const pickObject = (name: string) => {
    setOffset(0);
    setSearch('');
    setQ('');
    set({ object: name });
  };

  const csvHref = runId && objectName ? `/api/explorer/runs/${encodeURIComponent(runId)}/objects/${encodeURIComponent(objectName)}/export.csv${q ? `?q=${encodeURIComponent(q)}` : ''}` : '';
  const snap = snapshots.find((s) => s.id === runId);

  return (
    <>
      <PageHead eyebrow="BACKUP" title="Data explorer" subtitle="Browse and search the records inside a finished backup, without downloading it." />
      {orgs.error && <Notice kind="error">{orgs.error}</Notice>}
      {!orgs.loading && connections.length === 0 && (
        <div className="panel"><div className="empty"><h2>No organizations yet</h2><p><Link to="/orgs">Connect a Salesforce org</Link> and run a backup first.</p></div></div>
      )}
      {connections.length > 0 && (
        <div className="panel">
          <div className="row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
            <div className="field" style={{ minWidth: 200 }}>
              <label htmlFor="ex-org">Organization</label>
              <select id="ex-org" value={connectionId} onChange={(e) => { setOffset(0); set({ org: e.target.value, run: '', object: '' }); }}>
                {connections.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
            <div className="field" style={{ minWidth: 260 }}>
              <label htmlFor="ex-run">Backup</label>
              <select id="ex-run" value={runId} disabled={snapshots.length === 0} onChange={(e) => { setOffset(0); set({ run: e.target.value, object: '' }); }}>
                {snapshots.length === 0 && <option value="">No finished backups</option>}
                {snapshots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {formatDate(s.finishedAt ?? s.createdAt)} · {s.status === 'SUCCEEDED' ? 'complete' : s.status.toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
            {snap && <div style={{ paddingBottom: 8 }}><StatusPill status={snap.status} /> <span className="hint">{snap.mode === 'INCREMENTAL' ? 'Incremental (full snapshot rebuilt from changes)' : 'Full copy'}</span></div>}
          </div>
          {snaps.error && <Notice kind="error">{snaps.error}</Notice>}
          {!snaps.loading && snapshots.length === 0 && <p className="hint">This org has no finished backup yet, so there is nothing to browse.</p>}
        </div>
      )}

      {runId && (
        <div className="panel">
          <h2>Objects in this backup</h2>
          {objects.error && <Notice kind="error">{objects.error}</Notice>}
          {objects.loading && !objects.data ? (
            <div className="empty">Loading…</div>
          ) : objList.length === 0 ? (
            <p className="hint">No record objects were stored in this backup.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>OBJECT</th><th>STATUS</th><th>ROWS</th><th>SIZE</th><th></th></tr></thead>
                <tbody>
                  {objList.map((o) => (
                    <tr key={o.name} style={o.name === objectName ? { background: 'var(--accent-soft, rgba(0,120,212,.08))' } : undefined}>
                      <td><strong>{o.name}</strong></td>
                      <td><StatusPill status={o.status} /></td>
                      <td>{o.rowCount ?? '-'}</td>
                      <td>{formatBytes(o.bytes)}</td>
                      <td><button className="btn secondary small" onClick={() => pickObject(o.name)}>{o.name === objectName ? 'Viewing' : 'View records'}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {runId && objectName && (
        <div className="panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>{objectName}</h2>
            <form
              style={{ display: 'flex', gap: 8 }}
              onSubmit={(e) => { e.preventDefault(); setOffset(0); setQ(search.trim()); }}
            >
              <input aria-label="Search records" placeholder="Search text in any field" value={search} onChange={(e) => setSearch(e.target.value)} />
              <button className="btn secondary">Search</button>
              {q && <button type="button" className="btn secondary" onClick={() => { setSearch(''); setQ(''); setOffset(0); }}>Clear</button>}
              {canExport(user) ? (
                <a className="btn secondary" href={csvHref} download>Download CSV</a>
              ) : (
                <span className="hint" title="Auditors can view but not export">Export is off for auditors</span>
              )}
            </form>
          </div>
          {page.error && <Notice kind="error">{page.error}</Notice>}
          {page.loading && !data ? (
            <div className="empty">Loading…</div>
          ) : data && data.records.length === 0 ? (
            <p className="hint">{q ? 'No record matches that search.' : 'This object has no records in this backup.'}</p>
          ) : data ? (
            <>
              <div className="table-wrap" style={{ maxHeight: 520, overflow: 'auto' }}>
                <table>
                  <thead><tr>{data.columns.map((c) => <th key={c}>{c.toUpperCase()}</th>)}</tr></thead>
                  <tbody>
                    {data.records.map((r, i) => (
                      <tr key={`${data.offset}-${i}`}>{data.columns.map((c) => <td key={c} style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cell(r[c])}>{cell(r[c])}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
                <button className="btn secondary small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
                <span className="hint">
                  Rows {data.offset + 1}–{data.offset + data.records.length}
                  {data.total !== null ? ` of ${data.total}` : q ? ' (search results)' : ''}
                </span>
                <button className="btn secondary small" disabled={!data.hasMore} onClick={() => setOffset(offset + PAGE)}>Next</button>
              </div>
            </>
          ) : null}
        </div>
      )}
    </>
  );
}
