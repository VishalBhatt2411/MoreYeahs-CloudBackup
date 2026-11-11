import { useEffect, useState, type FormEvent } from 'react';
import { api, errText, formatDate } from '../api';
import { Notice, PageHead, useLoad } from '../ui';

interface SfConfig {
  configured: boolean;
  clientId: string | null;
  clientSecretSaved: boolean;
  updatedAt: string | null;
  callbackUrl: string;
  scopes: string[];
}

export default function PlatformPage() {
  const cfg = useLoad(() => api<SfConfig>('/platform/salesforce'), []);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (cfg.data?.clientId) setClientId(cfg.data.clientId);
  }, [cfg.data?.clientId]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setTest(null);
    setBusy('save');
    try {
      await api('/platform/salesforce', { method: 'PUT', body: { clientId, ...(clientSecret ? { clientSecret } : {}) } });
      setClientSecret('');
      setSaved(true);
      cfg.reload();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    setError(null);
    setTest(null);
    setBusy('test');
    try {
      setTest(await api<{ ok: boolean; message: string }>('/platform/salesforce/test', { method: 'POST', body: {} }));
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  const c = cfg.data;

  return (
    <>
      <PageHead
        eyebrow="PLATFORM"
        title="Salesforce integration"
        subtitle="Set up once. Customers then click 'Connect Salesforce' and log in. They never see or paste these details."
      />
      {cfg.error && <Notice kind="error">{cfg.error}</Notice>}

      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Step 1 · Create the Connected App in Salesforce</h2>
            <p>Do this once, in the Salesforce org that will own the app.</p>
          </div>
        </div>
        <ol className="steps">
          <li>In Salesforce: <b>Setup → App Manager → New Connected App</b>.</li>
          <li>Give it a name (for example "MoreYeahs CloudBackup") and your contact email.</li>
          <li>Turn on <b>Enable OAuth Settings</b>.</li>
          <li>
            Callback URL:{' '}
            <code>{c?.callbackUrl ?? '…'}</code>{' '}
            {c && (
              <button
                className="link"
                onClick={() => {
                  void navigator.clipboard?.writeText(c.callbackUrl).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); });
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
          </li>
          <li>Selected OAuth scopes: <b>Manage user data via APIs (api)</b>, <b>Perform requests at any time (refresh_token, offline_access)</b>, and <b>Access the identity URL service (id)</b>.</li>
          <li>Turn on <b>Require Proof Key for Code Exchange (PKCE)</b>. Keep "Require Secret for Web Server Flow" on.</li>
          <li>Save. Salesforce can take a few minutes to activate a new app.</li>
          <li>Open the app, click <b>Manage Consumer Details</b>, and copy the <b>Consumer Key</b> (Client ID) and <b>Consumer Secret</b>.</li>
        </ol>
        <Notice>
          For other customers' orgs: this app must also be available to them. In their org, an admin may need to allow it under <b>Setup → Connected Apps OAuth Usage</b> (or install it). See the guide in the project docs.
        </Notice>
      </div>

      <form className="panel" onSubmit={save}>
        <div className="panel-head">
          <div>
            <h2>Step 2 · Enter the app details</h2>
            <p>
              {c?.configured ? <>Saved {formatDate(c.updatedAt)}. The secret is stored encrypted and is never shown again.</> : 'Not saved yet.'}
            </p>
          </div>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        {saved && <Notice kind="ok">Saved.</Notice>}
        <div className="field">
          <label htmlFor="cid">Client ID (Consumer Key)</label>
          <input id="cid" value={clientId} onChange={(e) => setClientId(e.target.value)} required autoComplete="off" spellCheck={false} />
        </div>
        <div className="field">
          <label htmlFor="cs">Client Secret (Consumer Secret)</label>
          <input
            id="cs"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={c?.clientSecretSaved ? '•••••••• saved. Type only to replace it' : ''}
            required={!c?.clientSecretSaved}
            autoComplete="off"
          />
          {c?.clientSecretSaved && <small>A secret is saved. Leave blank to keep it.</small>}
        </div>
        <div className="row gap">
          <button className="btn primary" disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn secondary" disabled={busy !== null || !c?.configured} onClick={() => void runTest()}>
            {busy === 'test' ? 'Testing…' : 'Test with Salesforce'}
          </button>
        </div>
        {test && <div style={{ marginTop: 16 }}><Notice kind={test.ok ? 'ok' : 'error'}>{test.message}</Notice></div>}
      </form>
    </>
  );
}
