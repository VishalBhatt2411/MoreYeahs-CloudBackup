import { Link } from 'react-router-dom';
import { api, formatDate, type Run } from '../api';
import { Notice, PageHead, StatusPill, useLoad } from '../ui';

export const isActiveRun = (r: { status: string }) => r.status === 'QUEUED' || r.status === 'RUNNING';

export default function RunsPage() {
  const runs = useLoad(() => api<{ runs: Run[] }>('/runs'), [], { active: (d) => d.runs.some(isActiveRun) });
  const list = runs.data?.runs ?? [];
  return (
    <>
      <PageHead eyebrow="BACKUP" title="Backup runs" subtitle="Every backup, newest first. Status is only Succeeded when every item was copied and checked." />
      {runs.error && <Notice kind="error">{runs.error}</Notice>}
      <div className="panel">
        {runs.loading && !runs.data ? (
          <div className="empty">Loading…</div>
        ) : list.length === 0 ? (
          <div className="empty">
            <h2>No backups yet</h2>
            <p>Open an org and click "Start backup".</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>ORG</th><th>STATUS</th><th>STARTED</th><th>FINISHED</th><th>HOW</th><th></th></tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id}>
                    <td><strong>{r.orgLabel}</strong><div className="hint">{r.orgUsername}</div></td>
                    <td><StatusPill status={r.status} />{r.message && <div className="hint">{r.message}</div>}</td>
                    <td>{formatDate(r.startedAt ?? r.createdAt)}</td>
                    <td>{formatDate(r.finishedAt)}</td>
                    <td>{r.trigger === 'schedule' ? 'Scheduled' : 'Manual'}</td>
                    <td><Link to={`/runs/${r.id}`}>Details</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
