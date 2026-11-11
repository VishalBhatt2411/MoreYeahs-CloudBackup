import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errText, formatDate, type Connection } from '../api';
import { canManage, useAuth } from '../auth';
import { Notice, PageHead, StatusPill, useLoad, useToast } from '../ui';

interface Coverage {
  apiVersion: string;
  objects: { name: string; label: string; custom: boolean }[];
  excludedObjects: { name: string; reason: string }[];
  metadataTypes: string[];
}

const SCHEDULES = [
  { value: '', label: 'Off (manual only)' },
  { value: '6', label: 'Every 6 hours' },
  { value: '12', label: 'Every 12 hours' },
  { value: '24', label: 'Every day' },
  { value: '168', label: 'Every week' },
];

export default function OrgDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const manage = canManage(user);

  const org = useLoad(() => api<{ connection: Connection }>(`/connections/${id}`), [id]);
  const c = org.data?.connection;

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);

  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [pickObjects, setPickObjects] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  async function act<T>(name: string, fn: () => Promise<T>) {
    setError(null);
    setBusy(name);
    try {
      return await fn();
    } catch (e) {
      setError(errText(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function loadCoverage() {
    setCoverageError(null);
    await act('coverage', async () => {
      try {
        setCoverage(await api<Coverage>(`/connections/${id}/coverage`));
      } catch (e) {
        setCoverageError(errText(e));
      }
    });
  }

  async function startBackup() {
    const body: { includeMetadata: boolean; objects?: string[] } = { includeMetadata };
    if (pickObjects) body.objects = [...chosen];
    const r = await act('run', () => api<{ run: { id: string } }>(`/connections/${id}/runs`, { method: 'POST', body }));
    if (r) navigate(`/runs/${r.run.id}`);
  }

  async function check() {
    const r = await act('check', () => api<{ ok: boolean; connection: Connection }>(`/connections/${id}/check`, { method: 'POST', body: {} }));
    if (r) {
      org.setData({ connection: r.connection });
      toast.show(r.ok ? 'Connection is working.' : 'Salesforce no longer accepts this login. Please reconnect.');
    }
  }

  async function setSchedule(v: string) {
    const r = await act('schedule', () => api<{ connection: Connection }>(`/connections/${id}/schedule`, { method: 'PUT', body: { scheduleHours: v ? Number(v) : null } }));
    if (r) {
      org.setData({ connection: r.connection });
      toast.show(v ? 'Automatic backups saved.' : 'Automatic backups turned off.');
    }
  }

  async function disconnect() {
    if (!window.confirm('Disconnect this org? Backups you already took are kept. You can connect again later.')) return;
    const r = await act('disconnect', () => api(`/connections/${id}`, { method: 'DELETE' }));
    if (r) navigate('/orgs');
  }

  const visibleObjects = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (coverage?.objects ?? []).filter((o) => !q || o.name.toLowerCase().includes(q) || o.label.toLowerCase().includes(q));
  }, [coverage, filter]);

  if (org.error && !c) return <Notice kind="error">{org.error}</Notice>;
  if (!c) return <div className="empty">Loading…</div>;

  const active = c.status === 'ACTIVE';

  return (
    <>
      <PageHead
        eyebrow="ORGANIZATION"
        title={c.label}
        subtitle={<><StatusPill status={c.status} /> {c.username} · {c.environment === 'SANDBOX' ? 'Sandbox' : 'Production'} · connected {formatDate(c.connectedAt)}</>}
        actions={
          <>
            <Link className="btn secondary" to="/orgs">All orgs</Link>
            {manage && c.status !== 'DISCONNECTED' && <button className="btn secondary" disabled={!!busy} onClick={() => void check()}>{busy === 'check' ? 'Checking…' : 'Check connection'}</button>}
          </>
        }
      />
      {error && <Notice kind="error">{error}</Notice>}
      {c.lastError && c.status !== 'ACTIVE' && <Notice kind="warn">{c.lastError}</Notice>}
      {c.status === 'NEEDS_RECONNECT' && manage && (
        <Notice kind="warn">Go to <Link to="/orgs">Organizations</Link> and use "Connect Salesforce" again with the same org to refresh the login.</Notice>
      )}
      {c.status === 'DISCONNECTED' && <Notice>This org is disconnected. Old backups are still available under <Link to="/runs">Backup runs</Link>.</Notice>}

      {active && (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>Start a backup</h2>
              <p>Copies metadata (settings, code, layouts) and record data. Nothing is ever written back to Salesforce.</p>
            </div>
          </div>
          {!manage ? (
            <Notice>View-only access. Owners and admins can start backups.</Notice>
          ) : (
            <>
              <div className="field">
                <label><input type="checkbox" checked={includeMetadata} onChange={(e) => setIncludeMetadata(e.target.checked)} /> Include metadata</label>
              </div>
              <div className="field">
                <label><input type="checkbox" checked={pickObjects} onChange={(e) => { setPickObjects(e.target.checked); if (e.target.checked && !coverage) void loadCoverage(); }} /> Choose which objects to back up (default: all that can be copied)</label>
              </div>
              {pickObjects && (
                <div className="field">
                  {coverageError && <Notice kind="error">{coverageError}</Notice>}
                  {!coverage && !coverageError && <small>Loading object list…</small>}
                  {coverage && (
                    <>
                      <input placeholder="Search objects" value={filter} onChange={(e) => setFilter(e.target.value)} />
                      <div className="row">
                        <small>{chosen.size} selected</small>
                        <span>
                          <button className="link" onClick={() => setChosen(new Set(visibleObjects.map((o) => o.name)))}>Select shown</button>{' · '}
                          <button className="link" onClick={() => setChosen(new Set())}>Clear</button>
                        </span>
                      </div>
                      <div className="list-cols" style={{ maxHeight: 220, overflow: 'auto' }}>
                        {visibleObjects.map((o) => (
                          <div key={o.name}>
                            <label>
                              <input
                                type="checkbox"
                                checked={chosen.has(o.name)}
                                onChange={(e) => {
                                  const next = new Set(chosen);
                                  if (e.target.checked) next.add(o.name);
                                  else next.delete(o.name);
                                  setChosen(next);
                                }}
                              />{' '}
                              {o.name}
                            </label>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              <button
                className="btn primary"
                disabled={!!busy || (!includeMetadata && pickObjects && chosen.size === 0)}
                onClick={() => void startBackup()}
              >
                {busy === 'run' ? 'Starting…' : 'Start backup'}
              </button>
            </>
          )}
        </div>
      )}

      {active && manage && (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>Automatic backups</h2>
              <p>{c.scheduleHours ? `Next one: ${formatDate(c.nextRunAt)}` : 'Not scheduled.'}</p>
            </div>
          </div>
          <div className="field" style={{ maxWidth: 280 }}>
            <select value={c.scheduleHours ? String(c.scheduleHours) : ''} disabled={!!busy} onChange={(e) => void setSchedule(e.target.value)}>
              {SCHEDULES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              {c.scheduleHours && !SCHEDULES.some((s) => s.value === String(c.scheduleHours)) && <option value={String(c.scheduleHours)}>Every {c.scheduleHours} hours</option>}
            </select>
          </div>
        </div>
      )}

      {active && (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>What a backup covers</h2>
              <p>See which objects and metadata types are copied, and which are left out and why.</p>
            </div>
            <button className="btn secondary small" disabled={!!busy} onClick={() => void loadCoverage()}>{busy === 'coverage' ? 'Loading…' : coverage ? 'Refresh' : 'Show coverage'}</button>
          </div>
          {coverageError && <Notice kind="error">{coverageError}</Notice>}
          {coverage && (
            <>
              <p>API version {coverage.apiVersion}. <b>{coverage.objects.length}</b> objects and <b>{coverage.metadataTypes.length}</b> metadata types can be copied.</p>
              <details>
                <summary>Objects included ({coverage.objects.length})</summary>
                <div className="list-cols">{coverage.objects.map((o) => <div key={o.name}>{o.name}</div>)}</div>
              </details>
              <details>
                <summary>Objects not copied ({coverage.excludedObjects.length})</summary>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>OBJECT</th><th>WHY</th></tr></thead>
                    <tbody>{coverage.excludedObjects.map((o) => <tr key={o.name}><td>{o.name}</td><td>{o.reason}</td></tr>)}</tbody>
                  </table>
                </div>
              </details>
              <details>
                <summary>Metadata types ({coverage.metadataTypes.length})</summary>
                <div className="list-cols">{coverage.metadataTypes.map((t) => <div key={t}>{t}</div>)}</div>
              </details>
              <Notice>
                Not in this version: file and attachment contents, and restoring data back into Salesforce. Installed managed-package metadata is skipped because Salesforce does not allow it to be copied.
              </Notice>
            </>
          )}
        </div>
      )}

      {manage && c.status !== 'DISCONNECTED' && (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>Disconnect</h2>
              <p>Salesforce is told to forget our access. Backups already taken are kept.</p>
            </div>
            <button className="btn danger" disabled={!!busy} onClick={() => void disconnect()}>Disconnect org</button>
          </div>
        </div>
      )}
      {toast.node}
    </>
  );
}
