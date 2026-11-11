import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errText, formatBytes, formatDate, type RunDetail as RunDetailT } from '../api';
import { canExport, useAuth } from '../auth';
import { Notice, PageHead, StatusPill, useLoad } from '../ui';
import { isActiveRun } from './Runs';

export default function RunDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const exportOk = canExport(user);
  const [dlError, setDlError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'problems'>('all');
  const res = useLoad(() => api<{ run: RunDetailT }>(`/runs/${id}`), [id], { active: (d) => isActiveRun(d.run) });
  const run = res.data?.run;

  async function download(itemId?: string) {
    setDlError(null);
    try {
      const r = await api<{ url: string }>(`/runs/${id}/download-link`, { method: 'POST', body: itemId ? { itemId } : {} });
      window.location.assign(r.url);
    } catch (e) {
      setDlError(errText(e));
    }
  }

  if (res.error && !run) return <Notice kind="error">{res.error}</Notice>;
  if (!run) return <div className="empty">Loading…</div>;

  const s = run.summary;
  const items = filter === 'problems' ? run.items.filter((i) => i.status === 'FAILED' || i.status === 'PARTIAL') : run.items;
  const hasFiles = run.items.some((i) => i.downloadable);

  return (
    <>
      <PageHead
        eyebrow="BACKUP RUN"
        title={run.orgLabel ?? 'Backup run'}
        subtitle={<><StatusPill status={run.status} /> {run.orgUsername} · started {formatDate(run.startedAt ?? run.createdAt)}{run.finishedAt ? ` · finished ${formatDate(run.finishedAt)}` : ''} · {run.mode === 'INCREMENTAL' ? 'incremental' : 'full copy'}{run.attempts && run.attempts > 1 ? ` · attempt ${run.attempts}` : ''}</>}
        actions={
          <>
            <Link className="btn secondary" to={`/orgs/${run.connectionId}`}>Open org</Link>
            <Link className="btn secondary" to={`/explorer?org=${run.connectionId}&run=${run.id}`}>Browse records</Link>
            {exportOk && <button className="btn primary" disabled={!hasFiles || isActiveRun(run)} onClick={() => void download()}>Download everything (.zip)</button>}
          </>
        }
      />
      {dlError && <Notice kind="error">{dlError}</Notice>}
      {run.message && <Notice kind={run.status === 'SUCCEEDED' ? 'ok' : run.status === 'PARTIAL' ? 'warn' : run.status === 'FAILED' ? 'error' : undefined}>{run.message}</Notice>}
      {isActiveRun(run) && <Notice>This backup is running. This page updates by itself.</Notice>}

      <div className="cards">
        <div className="card"><span>Items</span><div className="big">{s.total}</div></div>
        <div className="card"><span>Succeeded</span><div className="big">{s.succeeded}</div></div>
        <div className="card"><span>Partial / failed</span><div className="big">{s.partial + s.failed}</div></div>
        <div className="card"><span>Records · size</span><div className="big">{s.rows.toLocaleString()} · {formatBytes(s.bytes)}</div></div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>What was copied</h2>
            <p>"Expected" is what Salesforce said exists. "Saved" is what we stored. They must match for an item to count as succeeded. The checksum (SHA-256) is for the saved file.</p>
          </div>
          <div className="head-actions">
            <button className={`btn small ${filter === 'all' ? 'primary' : 'secondary'}`} onClick={() => setFilter('all')}>All</button>
            <button className={`btn small ${filter === 'problems' ? 'primary' : 'secondary'}`} onClick={() => setFilter('problems')}>Problems only</button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>ITEM</th><th>TYPE</th><th>STATUS</th><th>EXPECTED</th><th>SAVED</th><th>SIZE</th><th>CHECKSUM</th><th></th></tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={8} className="empty">{filter === 'problems' ? 'No problems. ' : 'Nothing here yet.'}</td></tr>
              )}
              {items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <strong>{i.name}</strong>
                    {i.error && <div className="err">{i.error}</div>}
                    {i.note && <div className="hint">{i.note}</div>}
                    {i.mode === 'INCREMENTAL' && (
                      <div className="hint">Incremental: {(i.changedCount ?? 0).toLocaleString()} changed, {(i.deletedCount ?? 0).toLocaleString()} deleted since the last backup</div>
                    )}
                  </td>
                  <td>{i.kind === 'OBJECT' ? 'Records' : 'Metadata'}</td>
                  <td><StatusPill status={i.status} /></td>
                  <td>{i.expectedCount ?? '-'}</td>
                  <td>{i.rowCount ?? '-'}</td>
                  <td>{formatBytes(i.bytes)}</td>
                  <td className="mono">{i.sha256 ? `${i.sha256.slice(0, 12)}…` : '-'}</td>
                  <td>{i.downloadable && exportOk && <button className="link" onClick={() => void download(i.id)}>Download</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
