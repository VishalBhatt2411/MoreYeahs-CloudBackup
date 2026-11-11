import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errText } from '../api';
import { Notice } from '../ui';

/** Opened from the link in the "confirm your email" message. Works while signed out. */
export default function VerifyEmail() {
  const { token = '' } = useParams();
  const [state, setState] = useState<'checking' | 'ok' | 'bad'>('checking');
  const [problem, setProblem] = useState('');
  // React strict mode runs effects twice in dev; the link works only once, so guard it.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api('/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => setState('ok'))
      .catch((e) => {
        setProblem(errText(e));
        setState('bad');
      });
  }, [token]);

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
        {state === 'checking' && <p className="sub">Checking your link…</p>}
        {state === 'ok' && (
          <>
            <h1>Email confirmed</h1>
            <Notice kind="ok">Thank you. Your email address is confirmed and your account is ready.</Notice>
            {/* A full page load, so this browser forgets any old sign-in. */}
            <a className="btn primary" style={{ width: '100%', display: 'block', textAlign: 'center', boxSizing: 'border-box' }} href="/login">Go to sign in</a>
          </>
        )}
        {state === 'bad' && (
          <>
            <h1>Link not valid</h1>
            <Notice kind="error">{problem}</Notice>
            <div className="switch">Sign in to ask for a new link: <Link to="/login">Sign in</Link></div>
          </>
        )}
      </div>
    </div>
  );
}
