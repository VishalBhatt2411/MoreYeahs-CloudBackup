import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, errText, formatDate, type Connection } from '../api';
import { canManage, useAuth } from '../auth';
import { Notice, PageHead, StatusPill, useLoad } from '../ui';

export default function Orgs() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [showConnect, setShowConnect] = useState(false);
  const [label, setLabel] = useState('');
  const [environment, setEnvironment] = useState<'PRODUCTION' | 'SANDBOX'>('PRODUCTION');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orgs = useLoad(() => api<{ connections: Connection[] }>('/connections'), []);
  const sf = useLoad(() => api<{ configured: boolean }>('/salesforce/status'), []);

  const connectedId = params.get('connected');
  const sfError = params.get('sf_error');
  useEffect(() => {
    if (connectedId) orgs.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedId]);

  const manage = canManage(user);
  const list = orgs.data?.connections ?? [];
  const notConfigured = sf.data && !sf.data.configured;

  async function startConnect(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ authorizeUrl: string }>('/oauth/salesforce/start', { method: 'POST', body: { environment, label } });
      window.location.assign(r.authorizeUrl);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead
        eyebrow="BACKUP"
        title="Organizations"
        subtitle="Salesforce orgs you have connected. We log in with Salesforce itself, so you never share a password."
        actions={manage && !notConfigured ? <button className="btn primary" onClick={() => setShowConnect(true)}>Connect Salesforce</button> : undefined}
      />

      {connectedId && (
        <Notice kind="ok">
          Salesforce org connected. <button className="link" onClick={() => navigate(`/orgs/${connectedId}`)}>Open it</button>
          {' · '}
          <button className="link" onClick={() => setParams({})}>Dismiss</button>
        </Notice>
      )}
      {sfError && (
        <Notice kind="error">
          Could not connect: {sfError} <button className="link" onClick={() => setParams({})}>Dismiss</button>
        </Notice>
      )}
      {notConfigured && (
        <Notice kind="warn">
          Salesforce connecting is not set up yet.{' '}
          {user?.isPlatformAdmin ? (
            <>Go to <Link to="/platform">Platform setup</Link> and enter the Connected App details once.</>
          ) : (
            <>Please ask your platform administrator to finish the Salesforce setup.</>
          )}
        </Notice>
      )}
      {!manage && <Notice>You have view-only access. Owners and admins can connect orgs and run backups.</Notice>}
      {orgs.error && <Notice kind="error">{orgs.error}</Notice>}

      {showConnect && (
        <form className="panel" onSubmit={startConnect}>
          <div className="panel-head">
            <div>
              <h2>Connect a Salesforce org</h2>
              <p>You will be sent to Salesforce to log in and allow access. Then you come back here.</p>
            </div>
          </div>
          {error && <Notice kind="error">{error}</Notice>}
          <div className="field">
            <label>Org type</label>
            <div className="radio-row">
              <label className={environment === 'PRODUCTION' ? 'on' : ''}>
                <input type="radio" checked={environment === 'PRODUCTION'} onChange={() => setEnvironment('PRODUCTION')} />
                Production / Developer Edition
              </label>
              <label className={environment === 'SANDBOX' ? 'on' : ''}>
                <input type="radio" checked={environment === 'SANDBOX'} onChange={() => setEnvironment('SANDBOX')} />
                Sandbox
              </label>
            </div>
          </div>
          <div className="field">
            <label htmlFor="lbl">Name for this org</label>
            <input id="lbl" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Production" maxLength={60} required />
          </div>
          <div className="row gap">
            <button className="btn primary" disabled={busy}>{busy ? 'Opening Salesforce…' : 'Continue to Salesforce'}</button>
            <button type="button" className="btn secondary" onClick={() => setShowConnect(false)}>Cancel</button>
          </div>
        </form>
      )}

      {orgs.loading && !orgs.data ? (
        <div className="empty">Loading…</div>
      ) : list.length === 0 ? (
        <div className="panel empty">
          <h2>No orgs connected yet</h2>
          <p>{manage && !notConfigured ? 'Click "Connect Salesforce" to add your first org.' : 'Once an org is connected, it will show up here.'}</p>
        </div>
      ) : (
        <div className="org-cards">
          {list.map((c) => (
            <div className="card org-card" key={c.id}>
              <div className="row">
                <StatusPill status={c.status} />
                <span className="pill grey">{c.environment === 'SANDBOX' ? 'Sandbox' : 'Production'}</span>
              </div>
              <h2><Link to={`/orgs/${c.id}`}>{c.label}</Link></h2>
              <p>{c.username}</p>
              <p>{c.orgName ?? c.sfOrgId}</p>
              <p>
                Last backup:{' '}
                {c.lastRun ? (
                  <>
                    <StatusPill status={c.lastRun.status} /> <Link to={`/runs/${c.lastRun.id}`}>{formatDate(c.lastRun.createdAt)}</Link>
                  </>
                ) : (
                  'none yet'
                )}
              </p>
              {c.scheduleHours && <p>Automatic backup every {c.scheduleHours} hours</p>}
              {c.lastError && <p style={{ color: 'var(--red)' }}>{c.lastError}</p>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
