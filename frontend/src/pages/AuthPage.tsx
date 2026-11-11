import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { errText } from '../api';
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
  const isRegister = mode === 'register';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (isRegister) await register({ workspaceName, name, email, password });
      else await login(email, password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from.startsWith('/') ? from : '/dashboard', { replace: true });
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
          {isRegister && <small>At least 10 characters.</small>}
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
