import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, errText } from '../api';
import { useAuth } from '../auth';
import { Notice } from '../ui';

export default function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [workspaceName, setWorkspaceName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 'sent' = we emailed a link after sign-up; 'unverified' = sign-in refused until the link is opened.
  const [verify, setVerify] = useState<null | 'sent' | 'unverified'>(null);
  const [resendMsg, setResendMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const isRegister = mode === 'register';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResendMsg(null);
    setBusy(true);
    try {
      if (isRegister) {
        const r = await register({ workspaceName, name, email, password });
        if (r === 'verify') {
          setVerify('sent');
          return;
        }
      } else {
        await login(email, password);
      }
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from.startsWith('/') ? from : '/dashboard', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'email_not_verified') setVerify('unverified');
      else setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setResendMsg(null);
    setBusy(true);
    try {
      await api('/auth/resend-verification', { method: 'POST', body: { email } });
      setResendMsg({ kind: 'ok', text: 'If that address has an account waiting for confirmation, a new link is on its way. You can ask again in a minute.' });
    } catch (err) {
      setResendMsg({ kind: 'error', text: errText(err) });
    } finally {
      setBusy(false);
    }
  }

  if (verify) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="brand">
            <div className="brandmark">C</div>
            <div>
              <strong>CloudBackup</strong>
              <small>BY MOREYEAHS</small>
            </div>
          </div>
          <h1>Check your email</h1>
          <p className="sub">
            {verify === 'sent' ? <>We sent a confirmation link to <b>{email}</b>.</> : <>The email address <b>{email}</b> is not confirmed yet.</>}{' '}
            Open the link in that message, then sign in. The link works for 24 hours.
          </p>
          {resendMsg && <Notice kind={resendMsg.kind}>{resendMsg.text}</Notice>}
          <button className="btn" style={{ width: '100%' }} disabled={busy} onClick={() => void resend()}>
            {busy ? 'Please wait…' : 'Send the link again'}
          </button>
          <div className="switch">
            <Link to="/login" onClick={() => { setVerify(null); setResendMsg(null); }}>Back to sign in</Link>
          </div>
        </div>
      </div>
    );
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
        <h1>{isRegister ? 'Create your account' : 'Sign in'}</h1>
        <p className="sub">{isRegister ? 'Back up your Salesforce orgs: metadata and records.' : 'Welcome back.'}</p>
        {error && <Notice kind="error">{error}</Notice>}
        {isRegister && (
          <>
            <div className="field">
              <label htmlFor="ws">Company name</label>
              <input id="ws" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} required minLength={2} autoComplete="organization" />
            </div>
            <div className="field">
              <label htmlFor="nm">Your name</label>
              <input id="nm" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="em">Email</label>
          <input id="em" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </div>
        <div className="field">
          <label htmlFor="pw">Password</label>
          <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={isRegister ? 10 : 1} autoComplete={isRegister ? 'new-password' : 'current-password'} />
          {isRegister ? <small>At least 10 characters.</small> : <small><Link to="/forgot-password">Forgot password?</Link></small>}
        </div>
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
        </button>
        <div className="switch">
          {isRegister ? (
            <>Already have an account? <Link to="/login">Sign in</Link></>
          ) : (
            <>New here? <Link to="/register">Create an account</Link></>
          )}
        </div>
      </form>
    </div>
  );
}
