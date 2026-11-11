import { useEffect, useState, type FormEvent } from 'react';
import { api, errText, formatBytes, formatDate, type Settings, type TeamInvite, type TeamUser, type User } from '../api';
import { useAuth } from '../auth';
import { Notice, PageHead, useLoad, useToast } from '../ui';

type Role = User['role'];

interface Form {
  name: string;
  timeZone: string;
  retentionDays: string; // '' = keep forever
  defaultScheduleHours: string; // '' = manual only
  alertOnFailure: boolean;
  alertEmail: string;
  sessionHours: string;
}

const toForm = (s: Settings): Form => ({
  name: s.name,
  timeZone: s.timeZone,
  retentionDays: s.retentionDays?.toString() ?? '',
  defaultScheduleHours: s.defaultScheduleHours?.toString() ?? '',
  alertOnFailure: s.alertOnFailure,
  alertEmail: s.alertEmail ?? '',
  sessionHours: s.sessionHours.toString(),
});

const num = (v: string) => (v.trim() === '' ? null : Number(v));

const SCHEDULES = [
  { v: '', t: 'Manual only' },
  { v: '6', t: 'Every 6 hours' },
  { v: '12', t: 'Every 12 hours' },
  { v: '24', t: 'Daily' },
  { v: '168', t: 'Weekly' },
];
const SESSIONS = [
  { v: '1', t: '1 hour' },
  { v: '8', t: '8 hours' },
  { v: '24', t: '1 day' },
  { v: '168', t: '7 days' },
  { v: '720', t: '30 days' },
];

interface SettingsResponse {
  settings: Settings;
  timeZones: string[];
  emailConfigured: boolean;
  alertRecipients: string[];
  recentAlerts: { id: string; runId: string; toEmail: string; status: 'SENT' | 'FAILED' | 'PENDING'; detail: string | null; createdAt: string }[];
}

export default function SettingsPage() {
  const { user, setTenant } = useAuth();
  const toast = useToast();
  const isOwner = user?.role === 'OWNER';
  const loaded = useLoad(() => api<SettingsResponse>('/settings'), []);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ runs: number; bytes: number } | null>(null);

  useEffect(() => {
    if (loaded.data) {
      const f = toForm(loaded.data.settings);
      setForm(f);
      setSaved(f);
    }
  }, [loaded.data]);

  // Show how much a retention period would delete before it is saved.
  const retention = form?.retentionDays ?? '';
  useEffect(() => {
    const n = num(retention);
    if (n === null || !Number.isInteger(n) || n < 1 || n > 3650) {
      setPreview(null);
      return;
    }
    let off = false;
    const t = window.setTimeout(() => {
      api<{ runs: number; bytes: number }>(`/settings/retention-preview?days=${n}`)
        .then((p) => !off && setPreview(p))
        .catch(() => !off && setPreview(null));
    }, 300);
    return () => {
      off = true;
      window.clearTimeout(t);
    };
  }, [retention]);

  if (!form || !saved || !loaded.data) {
    return (
      <>
        <PageHead eyebrow="ACCOUNT" title="Settings" />
        {loaded.error ? <Notice kind="error">{loaded.error}</Notice> : <div className="empty">Loading…</div>}
      </>
    );
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const retentionChanged = form.retentionDays !== saved.retentionDays;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setError(null);
    if (retentionChanged && form.retentionDays && preview && preview.runs > 0) {
      const ok = window.confirm(
        `Keeping backups for ${form.retentionDays} days will permanently delete ${preview.runs} existing backup(s) (${formatBytes(preview.bytes)}) within the hour. This cannot be undone. Continue?`,
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await api<{ settings: Settings }>('/settings', {
        method: 'PUT',
        body: {
          name: form.name,
          timeZone: form.timeZone,
          retentionDays: num(form.retentionDays),
          defaultScheduleHours: num(form.defaultScheduleHours),
          alertOnFailure: form.alertOnFailure,
          alertEmail: form.alertEmail.trim(),
          sessionHours: Number(form.sessionHours),
        },
      });
      const f = toForm(r.settings);
      setForm(f);
      setSaved(f);
      setTenant({ name: r.settings.name, timeZone: r.settings.timeZone });
      toast.show('Settings saved');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function applySchedule() {
    try {
      const r = await api<{ updated: number }>('/settings/apply-schedule', { method: 'POST', body: {} });
      toast.show(`Schedule applied to ${r.updated} org(s)`);
    } catch (err) {
      setError(errText(err));
    }
  }

  async function sendTestAlert() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api<{ ok: boolean; message: string }>('/settings/test-alert', { method: 'POST', body: {} }));
    } catch (err) {
      setTestResult({ ok: false, message: errText(err) });
    } finally {
      setTesting(false);
    }
  }

  const ro = !isOwner;
  const { timeZones, emailConfigured, recentAlerts } = loaded.data;
  // Who would get an alert right now, based on what is on screen (the saved value may differ until saved).
  const sendTo = form.alertEmail.trim() || loaded.data.alertRecipients.join(', ') || 'the company owners';
  const zones = timeZones.includes(form.timeZone) ? timeZones : [form.timeZone, ...timeZones];
  const scheduleOptions = SCHEDULES.some((s) => s.v === form.defaultScheduleHours) ? SCHEDULES : [...SCHEDULES, { v: form.defaultScheduleHours, t: `Every ${form.defaultScheduleHours} hours` }];
  const sessionOptions = SESSIONS.some((s) => s.v === form.sessionHours) ? SESSIONS : [...SESSIONS, { v: form.sessionHours, t: `${form.sessionHours} hours` }];

  return (
    <>
      <PageHead eyebrow="ACCOUNT" title="Settings" subtitle="How backups run for your company, and who can use CloudBackup." />
      {ro && <Notice>Only owners can change company settings. You can view them here and change your own password.</Notice>}
      {error && <Notice kind="error">{error}</Notice>}

      <form onSubmit={save}>
        <section className="panel">
          <div className="panel-head"><div><h2>General</h2></div></div>
          <div className="grid2">
            <div className="field">
              <label htmlFor="cn">Company name</label>
              <input id="cn" value={form.name} onChange={(e) => set('name', e.target.value)} disabled={ro} required minLength={2} />
            </div>
            <div className="field">
              <label htmlFor="tz">Time zone</label>
              <select id="tz" value={form.timeZone} onChange={(e) => set('timeZone', e.target.value)} disabled={ro}>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
              <small>All dates in the app are shown in this time zone.</small>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Backup schedule</h2>
              <p>The schedule given to every org you connect from now on. You can still change it per org.</p>
            </div>
          </div>
          <div className="field">
            <label htmlFor="sc">Default schedule</label>
            <select id="sc" value={form.defaultScheduleHours} onChange={(e) => set('defaultScheduleHours', e.target.value)} disabled={ro}>
              {scheduleOptions.map((s) => <option key={s.v} value={s.v}>{s.t}</option>)}
            </select>
          </div>
          {isOwner && (
            <div className="row gap" style={{ marginTop: 0 }}>
              <button type="button" className="btn secondary small" disabled={dirty} onClick={() => void applySchedule()}>Apply to all connected orgs now</button>
              {dirty && <small className="hint-line">Save first, then apply.</small>}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Retention</h2>
              <p>How long finished backups are kept. The newest good backup of each org is always kept, and running backups are never touched.</p>
            </div>
          </div>
          <div className="field">
            <label htmlFor="rt">Keep backups for (days)</label>
            <input id="rt" type="number" min={1} max={3650} placeholder="Forever" value={form.retentionDays} onChange={(e) => set('retentionDays', e.target.value)} disabled={ro} />
            <small>Leave empty to keep backups forever.</small>
          </div>
          {preview && (
            preview.runs > 0 ? (
              <Notice kind="warn">
                With {form.retentionDays} days, <b>{preview.runs}</b> existing backup(s) ({formatBytes(preview.bytes)}) would be permanently deleted.
              </Notice>
            ) : (
              <p className="hint-line">No existing backup is older than {form.retentionDays} days.</p>
            )
          )}
        </section>

        <section className="panel">
          <div className="panel-head"><div><h2>Alerts</h2><p>An email is sent when a backup fails or an org needs to be reconnected. Partial backups show on the Dashboard only.</p></div></div>
          {!emailConfigured && (
            <Notice kind="warn">Email is not set up on this server yet, so alerts cannot be sent. Ask the platform administrator to enter the mail server details. Failed backups always show on the Dashboard.</Notice>
          )}
          <label className="check">
            <input type="checkbox" checked={form.alertOnFailure} onChange={(e) => set('alertOnFailure', e.target.checked)} disabled={ro} />
            Email me when a backup fails
          </label>
          <div className="field">
            <label htmlFor="ae">Alert email</label>
            <input id="ae" type="email" placeholder="you@company.com" value={form.alertEmail} onChange={(e) => set('alertEmail', e.target.value)} disabled={ro} />
            <small>Leave empty to email every active owner ({loaded.data.alertRecipients.join(', ') || 'none'}).</small>
          </div>
          {isOwner && emailConfigured && (
            <div className="row gap" style={{ marginTop: 0 }}>
              <button type="button" className="btn secondary small" disabled={dirty || testing} onClick={() => void sendTestAlert()}>
                {testing ? 'Sending…' : 'Send a test alert'}
              </button>
              <small className="hint-line">{dirty ? 'Save first, then test.' : `Sends to ${sendTo}.`}</small>
            </div>
          )}
          {testResult && <div style={{ marginTop: 12 }}><Notice kind={testResult.ok ? 'ok' : 'error'}>{testResult.message}</Notice></div>}
          {recentAlerts.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 16 }}>
              <table>
                <thead><tr><th>RECENT ALERTS</th><th>SENT TO</th><th>RESULT</th></tr></thead>
                <tbody>
                  {recentAlerts.map((a) => (
                    <tr key={a.id}>
                      <td>{formatDate(a.createdAt)}</td>
                      <td>{a.toEmail}</td>
                      <td>{a.status === 'SENT' ? <span className="pill ok">Sent</span> : a.status === 'FAILED' ? <><span className="pill bad">Not sent</span> <small className="hint">{a.detail}</small></> : <span className="pill grey">Sending</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head"><div><h2>Security</h2><p>How long people stay signed in before they must sign in again.</p></div></div>
          <div className="field">
            <label htmlFor="ss">Sign-in length</label>
            <select id="ss" value={form.sessionHours} onChange={(e) => set('sessionHours', e.target.value)} disabled={ro}>
              {sessionOptions.map((s) => <option key={s.v} value={s.v}>{s.t}</option>)}
            </select>
            <small>Applies the next time someone signs in.</small>
          </div>
        </section>

        {isOwner && (
          <div className="savebar">
            <button className="btn primary" disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save settings'}</button>
            {dirty && <button type="button" className="btn secondary" onClick={() => setForm(saved)}>Discard changes</button>}
          </div>
        )}
      </form>

      <PasswordPanel onDone={() => toast.show('Password changed')} />
      <TeamPanel isOwner={isOwner} meId={user!.id} />
      <PermissionsPanel />
      {toast.node}
    </>
  );
}

function PasswordPanel({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/auth/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      setCurrent('');
      setNext('');
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <div className="panel-head"><div><h2>Change my password</h2></div></div>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="grid2">
        <div className="field">
          <label htmlFor="cp">Current password</label>
          <input id="cp" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
        </div>
        <div className="field">
          <label htmlFor="np">New password</label>
          <input id="np" type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} autoComplete="new-password" />
          <small>At least 10 characters.</small>
        </div>
      </div>
      <button className="btn secondary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
    </form>
  );
}

function TeamPanel({ isOwner, meId }: { isOwner: boolean; meId: string }) {
  const team = useLoad(() => api<{ users: TeamUser[]; invites: TeamInvite[] }>('/team'), []);
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('VIEWER');
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string; emailed: boolean; emailError: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ invite: { email: string }; link: string; emailed: boolean; emailError: string | null }>('/team/invites', { method: 'POST', body: { email, role } });
      setLink({ email: r.invite.email, url: r.link, emailed: r.emailed, emailError: r.emailError });
      setEmail('');
      team.reload();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>, done?: string) {
    setError(null);
    try {
      await fn();
      if (done) toast.show(done);
      team.reload();
    } catch (err) {
      setError(errText(err));
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.show('Link copied');
    } catch {
      toast.show('Could not copy. Select the link and copy it.');
    }
  }

  const users = team.data?.users ?? [];
  const invites = team.data?.invites ?? [];

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Team</h2>
          <p>People in your company who can sign in.</p>
        </div>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {team.error && <Notice kind="error">{team.error}</Notice>}

      {isOwner && (
        <form onSubmit={invite} className="invite-form">
          <div className="field">
            <label htmlFor="ie">Invite by email</label>
            <input id="ie" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" required />
          </div>
          <div className="field">
            <label htmlFor="ir">Role</label>
            <select id="ir" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="VIEWER">Viewer</option>
              <option value="ADMIN">Admin</option>
              <option value="OWNER">Owner</option>
            </select>
          </div>
          <button className="btn primary" disabled={busy}>{busy ? 'Sending…' : 'Invite'}</button>
        </form>
      )}
      {link && (
        <Notice kind="ok">
          {link.emailed ? (
            <>An invitation email was sent to <b>{link.email}</b>. You can also share this link yourself. It works once, for 7 days, and is shown only now.</>
          ) : link.emailError ? (
            <>Invite for <b>{link.email}</b> is ready, but the email could not be sent: {link.emailError} Share this link yourself. It works once, for 7 days, and is shown only now.</>
          ) : (
            <>Invite for <b>{link.email}</b> is ready. Email is not set up on this server, so share this link yourself. It works once, for 7 days, and is shown only now.</>
          )}
          <div className="linkbox">
            <code>{link.url}</code>
            <button type="button" className="btn secondary small" onClick={() => void copy(link.url)}>Copy</button>
          </div>
        </Notice>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>PERSON</th><th>ROLE</th><th>STATUS</th><th>LAST SIGN-IN</th>{isOwner && <th />}</tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const me = u.id === meId;
              return (
                <tr key={u.id}>
                  <td><strong>{u.name}</strong>{me && ' (you)'}<div className="hint">{u.email}</div></td>
                  <td>
                    {isOwner && !me ? (
                      <select
                        aria-label={`Role of ${u.name}`}
                        value={u.role}
                        onChange={(e) => void act(() => api(`/team/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } }), 'Role updated')}
                      >
                        <option value="VIEWER">Viewer</option>
                        <option value="ADMIN">Admin</option>
                        <option value="OWNER">Owner</option>
                      </select>
                    ) : (
                      u.role.toLowerCase()
                    )}
                  </td>
                  <td><span className={`pill ${u.active ? '' : 'grey'}`}>{u.active ? 'Active' : 'Switched off'}</span></td>
                  <td>{formatDate(u.lastLoginAt)}</td>
                  {isOwner && (
                    <td>
                      {!me && (
                        <button
                          className={`btn small ${u.active ? 'danger' : 'secondary'}`}
                          onClick={() => void act(() => api(`/team/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }), u.active ? 'User switched off' : 'User switched on')}
                        >
                          {u.active ? 'Switch off' : 'Switch on'}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {invites.length > 0 && (
        <>
          <h2 style={{ marginTop: 22 }}>Waiting to join</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>EMAIL</th><th>ROLE</th><th>EXPIRES</th>{isOwner && <th />}</tr></thead>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>{i.role.toLowerCase()}</td>
                    <td>{formatDate(i.expiresAt)}</td>
                    {isOwner && (
                      <td>
                        <button className="btn small secondary" onClick={() => void act(() => api(`/team/invites/${i.id}`, { method: 'DELETE' }), 'Invite cancelled')}>Cancel</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {toast.node}
    </section>
  );
}

const PERMS: { what: string; owner: boolean; admin: boolean; viewer: boolean }[] = [
  { what: 'See dashboard, orgs, backups and activity', owner: true, admin: true, viewer: true },
  { what: 'Download backup files', owner: true, admin: true, viewer: true },
  { what: 'Connect or disconnect Salesforce orgs', owner: true, admin: true, viewer: false },
  { what: 'Run backups and set an org schedule', owner: true, admin: true, viewer: false },
  { what: 'Change company settings (time zone, retention, alerts)', owner: true, admin: false, viewer: false },
  { what: 'Invite people and change roles', owner: true, admin: false, viewer: false },
];

function PermissionsPanel() {
  const mark = (v: boolean) => (v ? <span className="yes" aria-label="Allowed">Yes</span> : <span className="no" aria-label="Not allowed">No</span>);
  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Role permissions</h2><p>What each role can do. This list is fixed.</p></div></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>ACTION</th><th>OWNER</th><th>ADMIN</th><th>VIEWER</th></tr></thead>
          <tbody>
            {PERMS.map((p) => (
              <tr key={p.what}><td>{p.what}</td><td>{mark(p.owner)}</td><td>{mark(p.admin)}</td><td>{mark(p.viewer)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
