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
        title="Platform setup"
        subtitle="Set up once for the whole platform: how customers connect Salesforce, and how the app sends email. Customers never see or paste these details."
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

      <EmailPanel />
    </>
  );
}

interface EmailCfg {
  configured: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  passwordSaved: boolean;
  fromEmail: string;
  fromName: string;
  updatedAt: string | null;
}

function EmailPanel() {
  const cfg = useLoad(() => api<EmailCfg>('/platform/email'), []);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [secure, setSecure] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [fromName, setFromName] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    const d = cfg.data;
    if (!d) return;
    setHost(d.host);
    setPort(String(d.port));
    setSecure(d.secure);
    setUsername(d.username);
    setFromEmail(d.fromEmail);
    setFromName(d.fromName);
  }, [cfg.data]);

  // Port 465 expects TLS from the first byte; the other common ports upgrade later. Help the admin get it right.
  function changePort(v: string) {
    setPort(v);
    if (v === '465') setSecure(true);
    else if (v === '587' || v === '25') setSecure(false);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setTest(null);
    setBusy('save');
    try {
      await api('/platform/email', {
        method: 'PUT',
        body: {
          host,
          port: Number(port),
          secure,
          username: username.trim(),
          ...(password ? { password } : {}),
          fromEmail,
          fromName,
        },
      });
      setPassword('');
      setSaved(true);
      cfg.reload();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setError(null);
    setTest(null);
    setBusy('test');
    try {
      setTest(await api<{ ok: boolean; message: string }>('/platform/email/test', { method: 'POST', body: {} }));
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm('Remove the email settings? Alerts and invitation emails will stop until they are set up again.')) return;
    setError(null);
    setTest(null);
    setSaved(false);
    setBusy('remove');
    try {
      await api('/platform/email', { method: 'DELETE' });
      setPassword('');
      cfg.reload();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  const c = cfg.data;

  return (
    <form className="panel" onSubmit={save}>
      <div className="panel-head">
        <div>
          <h2>Email (SMTP)</h2>
          <p>
            {c?.configured
              ? <>Saved {formatDate(c.updatedAt)}. Used for backup failure alerts and team invitations. The password is stored encrypted and is never shown again.</>
              : 'Not set up. Enter the details of a mail account that can send email (for example from your email provider). Until then, alerts are not sent and invite links are shared by hand.'}
          </p>
        </div>
      </div>
      {cfg.error && <Notice kind="error">{cfg.error}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {saved && <Notice kind="ok">Saved. Press "Send a test email" to check it works.</Notice>}
      <div className="field">
        <label htmlFor="mh">Mail server (host)</label>
        <input id="mh" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.yourprovider.com" required autoComplete="off" spellCheck={false} />
      </div>
      <div className="field">
        <label htmlFor="mp">Port</label>
        <input id="mp" type="number" min={1} max={65535} value={port} onChange={(e) => changePort(e.target.value)} required />
        <small>Usually 587 (most providers) or 465.</small>
      </div>
      <label className="check">
        <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
        Secure connection from the start (use this with port 465)
      </label>
      <div className="field">
        <label htmlFor="mu">User name</label>
        <input id="mu" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} />
        <small>Leave empty only if your mail server needs no login.</small>
      </div>
      <div className="field">
        <label htmlFor="mw">Password</label>
        <input
          id="mw"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={c?.passwordSaved ? '•••••••• saved. Type only to replace it' : ''}
          autoComplete="new-password"
        />
        {c?.passwordSaved && <small>A password is saved. Leave blank to keep it.</small>}
      </div>
      <div className="field">
        <label htmlFor="mf">Send from (email address)</label>
        <input id="mf" type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="alerts@yourcompany.com" required />
      </div>
      <div className="field">
        <label htmlFor="mn">Sender name</label>
        <input id="mn" value={fromName} onChange={(e) => setFromName(e.target.value)} required maxLength={80} />
      </div>
      <div className="row gap">
        <button className="btn primary" disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn secondary" disabled={busy !== null || !c?.configured} onClick={() => void sendTest()}>
          {busy === 'test' ? 'Sending…' : 'Send a test email'}
        </button>
        {c?.configured && (
          <button type="button" className="btn danger" disabled={busy !== null} onClick={() => void remove()}>
            {busy === 'remove' ? 'Removing…' : 'Remove'}
          </button>
        )}
      </div>
      {test && <div style={{ marginTop: 16 }}><Notice kind={test.ok ? 'ok' : 'error'}>{test.message}</Notice></div>}
    </form>
  );
}
