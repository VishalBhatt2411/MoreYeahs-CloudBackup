import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errText } from '../api';
import { useAuth } from '../auth';
import { Notice } from '../ui';

interface InviteInfo {
  email: string;
  role: string;
  company: string;
}

/** Opened from the link an owner shares. Works while signed out. */
export default function Join() {
  const { token = '' } = useParams();
  const { acceptInvite } = useAuth();
  const navigate = useNavigate();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<InviteInfo>(`/auth/invite/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((e) => setProblem(errText(e)));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await acceptInvite({ token, name, password });
      navigate('/dashboard', { replace: true });
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
        {problem ? (
          <>
            <h1>Invitation not valid</h1>
            <Notice kind="error">{problem}</Notice>
            <div className="switch"><Link to="/login">Go to sign in</Link></div>
          </>
        ) : !info ? (
          <p className="sub">Checking your invitation…</p>
        ) : (
          <>
            <h1>Join {info.company}</h1>
            <p className="sub">
              You were invited as <b>{info.role.toLowerCase()}</b>. Choose a password to finish.
            </p>
            {error && <Notice kind="error">{error}</Notice>}
            <div className="field">
              <label htmlFor="em">Email</label>
              <input id="em" value={info.email} readOnly />
            </div>
            <div className="field">
              <label htmlFor="nm">Your name</label>
              <input id="nm" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
            </div>
            <div className="field">
              <label htmlFor="pw">Password</label>
              <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" />
              <small>At least 10 characters.</small>
            </div>
            <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
              {busy ? 'Please wait…' : 'Join'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
