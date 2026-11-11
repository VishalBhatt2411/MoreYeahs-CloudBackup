import { Link } from 'react-router-dom';
import { api, formatBytes, formatDate, type Dashboard } from '../api';
import { Notice, PageHead, StatusPill, useLoad } from '../ui';

const KIND_LABEL: Record<Dashboard['attention'][number]['kind'], string> = {
  reconnect: 'Reconnect needed',
  failed: 'Backup failed',
  partial: 'Partial backup',
  overdue: 'Overdue',
  never: 'No backup yet',
};

export default function DashboardPage() {
  // Refresh by itself while something is running.
  const d = useLoad(() => api<Dashboard>('/dashboard'), [], { active: (x) => x.totals.running > 0, everyMs: 4000 });
  const data = d.data;

  return (
    <>
      <PageHead eyebrow="OVERVIEW" title="Dashboard" subtitle="How your Salesforce backups are doing right now." />
      {d.error && <Notice kind="error">{d.error}</Notice>}
      {!data && !d.error && <div className="empty">Loading…</div>}
      {data && (
        <>
          <div className="cards">
            <div className="card">
              <span>Connected orgs</span>
              <div className="big">{data.totals.connected}{data.totals.orgs !== data.totals.connected && <small className="of"> / {data.totals.orgs}</small>}</div>
            </div>
            <div className="card">
              <span>Running now</span>
              <div className="big">{data.totals.running}</div>
            </div>
            <div className="card">
              <span>Stored data</span>
              <div className="big">{formatBytes(data.totals.bytes)}</div>
            </div>
            <div className="card">
              <span>Next scheduled backup</span>
              <div className="big small-text">
                {data.nextScheduled ? formatDate(data.nextScheduled.at) : 'None'}
              </div>
              {data.nextScheduled && <div className="hint-line">{data.nextScheduled.orgLabel}</div>}
            </div>
          </div>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Needs attention</h2>
                <p>Problems that need a person to look at them.</p>
              </div>
            </div>
            {data.attention.length === 0 ? (
              <p className="all-good">Everything looks good.</p>
            ) : (
              <ul className="attention">
                {data.attention.map((a) => (
                  <li key={a.connectionId + a.kind}>
                    <span className={`pill ${a.kind === 'partial' || a.kind === 'overdue' || a.kind === 'reconnect' ? 'warning' : a.kind === 'never' ? 'grey' : 'bad'}`}>{KIND_LABEL[a.kind]}</span>
                    <div>
                      <strong>{a.orgLabel}</strong>
                      <div className="hint-line">{a.text}</div>
                    </div>
                    <Link to={a.runId ? `/runs/${a.runId}` : `/orgs/${a.connectionId}`}>Open</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Last 30 days</h2>
                <p>Backups by result.</p>
              </div>
            </div>
            <div className="stat-row">
              <div><b>{data.last30Days.SUCCEEDED}</b> <StatusPill status="SUCCEEDED" /></div>
              <div><b>{data.last30Days.PARTIAL}</b> <StatusPill status="PARTIAL" /></div>
              <div><b>{data.last30Days.FAILED}</b> <StatusPill status="FAILED" /></div>
              <div><b>{data.last30Days.RUNNING + data.last30Days.QUEUED}</b> <StatusPill status="RUNNING" /></div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Organizations</h2>
                <p>Last backup and schedule for each org.</p>
              </div>
              <Link className="btn secondary small" to="/orgs">Manage orgs</Link>
            </div>
            {data.orgs.length === 0 ? (
              <div className="empty">
                <h2>No orgs yet</h2>
                <p>Connect your first Salesforce org to start backing it up.</p>
                <Link className="btn primary" to="/orgs">Connect Salesforce</Link>
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>ORG</th><th>CONNECTION</th><th>LAST BACKUP</th><th>LAST GOOD</th><th>SCHEDULE</th><th>NEXT RUN</th></tr>
                  </thead>
                  <tbody>
                    {data.orgs.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <Link to={`/orgs/${o.id}`}><strong>{o.label}</strong></Link>
                          <div className="hint">{o.username} · {o.environment === 'SANDBOX' ? 'Sandbox' : 'Production'}</div>
                        </td>
                        <td><StatusPill status={o.status} /></td>
                        <td>
                          {o.lastRun ? (
                            <Link to={`/runs/${o.lastRun.id}`}><StatusPill status={o.lastRun.status} /></Link>
                          ) : (
                            '-'
                          )}
                        </td>
                        <td>{formatDate(o.lastGoodAt)}</td>
                        <td>{o.scheduleHours ? `Every ${o.scheduleHours} h` : 'Manual'}</td>
                        <td>{o.status === 'ACTIVE' && o.scheduleHours ? formatDate(o.nextRunAt) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Recent backups</h2>
                <p>
                  {data.retentionDays
                    ? `Backups older than ${data.retentionDays} days are removed automatically.`
                    : 'Backups are kept forever. You can set a retention period in Settings.'}{' '}
                  Times are in {data.timeZone}.
                </p>
              </div>
              <Link className="btn secondary small" to="/runs">All runs</Link>
            </div>
            {data.recentRuns.length === 0 ? (
              <div className="empty">No backups yet.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>ORG</th><th>STATUS</th><th>HOW</th><th>STARTED</th><th>FINISHED</th></tr>
                  </thead>
                  <tbody>
                    {data.recentRuns.map((r) => (
                      <tr key={r.id}>
                        <td><Link to={`/runs/${r.id}`}><strong>{r.orgLabel}</strong></Link><div className="hint">{r.orgUsername}</div></td>
                        <td><StatusPill status={r.status} /></td>
                        <td>{r.trigger.toLowerCase()}</td>
                        <td>{formatDate(r.createdAt)}</td>
                        <td>{formatDate(r.finishedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
