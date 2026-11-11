import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errText } from '../api';
import { Notice } from '../ui';

/** Opened from the link in the reset email. Works while signed out. */
export default function ResetPassword() {
  const { token = '' } = useParams();
  const [email, setEmail] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api<{ email: string }>(`/auth/reset/${encodeURIComponent(token)}`)
      .then((r) => setEmail(r.email))
      .catch((e) => setProblem(errText(e)));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== again) {
      setError('The two passwords are not the same.');
      return;
    }
    setBusy(true);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <div className="brandmark">C</div>
          <div>
            <strong>CloudBackup</strong>
            <small>BY MOREYEAHS</small>
          </div>
        </div>
        {done ? (
          <>
            <h1>Password changed</h1>
            <Notice kind="ok">Your password was changed. You were signed out everywhere. Sign in with the new password.</Notice>
            {/* A full page load, so this browser forgets any old sign-in. */}
            <a className="btn primary" style={{ width: '100%', display: 'block', textAlign: 'center', boxSizing: 'border-box' }} href="/login">Go to sign in</a>
          </>
        ) : problem ? (
          <>
            <h1>Link not valid</h1>
            <Notice kind="error">{problem}</Notice>
            <div className="switch"><Link to="/forgot-password">Ask for a new link</Link> · <Link to="/login">Sign in</Link></div>
          </>
        ) : !email ? (
          <p className="sub">Checking your link…</p>
        ) : (
          <>
            <h1>Choose a new password</h1>
            <p className="sub">For <b>{email}</b>. You will be signed out everywhere else.</p>
            {error && <Notice kind="error">{error}</Notice>}
            <div className="field">
              <label htmlFor="pw">New password</label>
              <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" autoFocus />
              <small>At least 10 characters.</small>
            </div>
            <div className="field">
              <label htmlFor="pw2">Type it again</label>
              <input id="pw2" type="password" value={again} onChange={(e) => setAgain(e.target.value)} required minLength={10} autoComplete="new-password" />
            </div>
            <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
              {busy ? 'Please wait…' : 'Change password'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
