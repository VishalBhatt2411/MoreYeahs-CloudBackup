import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, errText } from '../api';
import { Notice } from '../ui';

/** Asks for an email address and sends a reset link. Works while signed out. */
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: { email } });
      setSent(true);
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
        <h1>Forgot your password?</h1>
        {sent ? (
          <>
            <Notice kind="ok">
              If there is an account for <b>{email}</b>, we sent an email with a link to choose a new password. The link works once and for 1 hour.
            </Notice>
            <p className="sub">Nothing arrived after a few minutes? Check your spam folder, or try again.</p>
            <div className="switch"><Link to="/login">Back to sign in</Link></div>
          </>
        ) : (
          <>
            <p className="sub">Enter your email and we will send you a link to choose a new one.</p>
            {error && <Notice kind="error">{error}</Notice>}
            <div className="field">
              <label htmlFor="em">Email</label>
              <input id="em" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus />
            </div>
            <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
              {busy ? 'Please wait…' : 'Send reset link'}
            </button>
            <div className="switch"><Link to="/login">Back to sign in</Link></div>
          </>
        )}
      </form>
    </div>
  );
}
