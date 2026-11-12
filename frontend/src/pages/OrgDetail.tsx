import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errText, formatDate, type Connection } from '../api';
import { canManage, useAuth } from '../auth';
import BackupPicker from '../BackupPicker';
import { buildSelection, fromSaved, type Coverage } from '../selection';
import { Notice, PageHead, StatusPill, useLoad, useToast } from '../ui';

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

  const [fullCopy, setFullCopy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [useForSchedule, setUseForSchedule] = useState(false);

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
        const cov = await api<Coverage>(`/connections/${id}/coverage`);
        setCoverage(cov);
        setSelected(fromSaved(cov, cov.defaultSelection));
      } catch (e) {
        setCoverageError(errText(e));
      }
    });
  }

  // What can be backed up is fetched once the org is known to be connected.
  const isActive = c?.status === 'ACTIVE';
  useEffect(() => {
    if (isActive && !coverage && !coverageError) void loadCoverage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, id]);

  const built = coverage ? buildSelection(coverage, selected) : null;

  async function startBackup() {
    if (!built || built.empty) return;
    const r = await act('run', async () => {
      if (useForSchedule) {
        await api(`/connections/${id}/selection`, { method: 'PUT', body: { selection: built.everything ? null : built.selection } });
      }
      const body = { ...built.selection, ...(fullCopy ? { fullCopy: true } : {}) };
      return api<{ run: { id: string } }>(`/connections/${id}/runs`, { method: 'POST', body });
    });
    if (r) navigate(`/runs/${r.run.id}`);
  }

  async function saveForSchedule() {
    if (!built || built.empty) return;
    const r = await act('selection', () => api(`/connections/${id}/selection`, { method: 'PUT', body: { selection: built.everything ? null : built.selection } }));
    if (r) {
      setCoverage((cv) => (cv ? { ...cv, defaultSelection: built.everything ? null : built.selection } : cv));
      toast.show(built.everything ? 'Automatic backups will cover everything.' : 'Automatic backups will use this selection.');
    }
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

  if (org.error && !c) return <Notice kind="error">{org.error}</Notice>;
  if (!c) return <div className="empty">Loading…</div>;

  const active = c.status === 'ACTIVE';
  const savedIsCustom = !!coverage?.defaultSelection;

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
              <p>Choose what to copy. Nothing is ever written back to Salesforce. When it finishes, you can download everything as organised Excel or CSV files.</p>
            </div>
          </div>
          {!manage ? (
            <Notice>View-only access. Owners and admins can start backups.</Notice>
          ) : (
            <>
              {coverageError && (
                <Notice kind="error">
                  {coverageError} <button className="link" onClick={() => void loadCoverage()}>Try again</button>
                </Notice>
              )}
              {!coverage && !coverageError && <div className="empty">Reading what is in this org…</div>}
              {coverage && built && (
                <>
                  <BackupPicker coverage={coverage} selected={selected} onChange={setSelected} />

                  <div className="pick-bar">
                    <div className="pick-summary">
                      {built.empty ? (
                        <strong>Nothing selected yet</strong>
                      ) : (
                        <>
                          <strong>{built.everything ? 'Everything' : 'Your selection'}</strong>
                          <span>
                            {built.objects.toLocaleString()} of {coverage.objects.length.toLocaleString()} objects · {built.types.toLocaleString()} of {coverage.metadataTypes.length.toLocaleString()} configuration types
                          </span>
                        </>
                      )}
                    </div>
                    <div className="pick-options">
                      <label className="check">
                        <input type="checkbox" checked={fullCopy} onChange={(e) => setFullCopy(e.target.checked)} />
                        Read every record again (full copy)
                      </label>
                      <label className="check">
                        <input type="checkbox" checked={useForSchedule} onChange={(e) => setUseForSchedule(e.target.checked)} />
                        Use this selection for automatic backups too
                      </label>
                    </div>
                    <button className="btn primary" disabled={!!busy || built.empty} onClick={() => void startBackup()}>
                      {busy === 'run' ? 'Starting…' : 'Start backup'}
                    </button>
                  </div>
                  <p className="hint-line">
                    By default only records changed since the last good backup are read, and the rest is carried over, so every backup is still a complete snapshot. Tick "full copy" to read everything again.
                  </p>
                </>
              )}
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
          {coverage && built && (
            <div className="row" style={{ justifyContent: 'flex-start', gap: 14 }}>
              <span className="hint-line">
                Automatic backups currently cover: <b>{savedIsCustom ? 'a custom selection' : 'everything'}</b>.
              </span>
              <button className="btn secondary small" disabled={!!busy || built.empty} onClick={() => void saveForSchedule()}>
                {busy === 'selection' ? 'Saving…' : 'Use the selection above'}
              </button>
            </div>
          )}
        </div>
      )}

      {active && coverage && (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>What is left out</h2>
              <p>API version {coverage.apiVersion}. Some objects cannot be copied through Salesforce's API; they are listed here with the reason.</p>
            </div>
            <button className="btn secondary small" disabled={!!busy} onClick={() => void loadCoverage()}>{busy === 'coverage' ? 'Loading…' : 'Refresh list'}</button>
          </div>
          <details>
            <summary>Objects that cannot be copied ({coverage.excludedObjects.length})</summary>
            <div className="table-wrap">
              <table>
                <thead><tr><th>OBJECT</th><th>WHY</th></tr></thead>
                <tbody>{coverage.excludedObjects.map((o) => <tr key={o.name}><td>{o.label && o.label !== o.name ? `${o.label} (${o.name})` : o.name}</td><td>{o.reason}</td></tr>)}</tbody>
              </table>
            </div>
          </details>
          <Notice>
            Not in this version: file and attachment contents, and restoring data back into Salesforce. Installed managed-package metadata is skipped because Salesforce does not allow it to be copied.
          </Notice>
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
