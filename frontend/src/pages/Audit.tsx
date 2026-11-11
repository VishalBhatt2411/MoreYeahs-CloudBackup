import { api, formatDate } from '../api';
import { Notice, PageHead, useLoad } from '../ui';

interface Entry {
  id: string;
  action: string;
  target: string | null;
  detail: string | null;
  createdAt: string;
  by: string;
}

export default function AuditPage() {
  const res = useLoad(() => api<{ entries: Entry[] }>('/audit'), []);
  const list = res.data?.entries ?? [];
  return (
    <>
      <PageHead eyebrow="SECURITY" title="Activity log" subtitle="Who did what in your workspace. The latest 200 actions." />
      {res.error && <Notice kind="error">{res.error}</Notice>}
      <div className="panel">
        {res.loading && !res.data ? (
          <div className="empty">Loading…</div>
        ) : list.length === 0 ? (
          <div className="empty">Nothing yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>WHEN</th><th>WHO</th><th>ACTION</th><th>DETAILS</th></tr></thead>
              <tbody>
                {list.map((e) => (
                  <tr key={e.id}>
                    <td>{formatDate(e.createdAt)}</td>
                    <td>{e.by}</td>
                    <td><code>{e.action}</code></td>
                    <td>{[e.target, e.detail].filter(Boolean).join(' · ') || '-'}</td>
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
