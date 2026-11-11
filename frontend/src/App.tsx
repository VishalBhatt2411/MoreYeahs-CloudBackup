import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import AuditPage from './pages/Audit';
import AuthPage from './pages/AuthPage';
import DashboardPage from './pages/Dashboard';
import ForgotPassword from './pages/ForgotPassword';
import Join from './pages/Join';
import ResetPassword from './pages/ResetPassword';
import OrgDetail from './pages/OrgDetail';
import Orgs from './pages/Orgs';
import PlatformPage from './pages/Platform';
import RunDetail from './pages/RunDetail';
import RunsPage from './pages/Runs';
import SettingsPage from './pages/Settings';

function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  if (!user) return null;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandmark">C</div>
          <div>
            <strong>CloudBackup</strong>
            <small>BY MOREYEAHS</small>
          </div>
        </div>
        <nav>
          <div className="nav-label">BACKUP</div>
          <NavLink to="/dashboard">Dashboard</NavLink>
          <NavLink to="/orgs">Organizations</NavLink>
          <NavLink to="/runs">Backup runs</NavLink>
          <NavLink to="/audit">Activity log</NavLink>
          <div className="nav-label">ACCOUNT</div>
          <NavLink to="/settings">Settings</NavLink>
          {user.isPlatformAdmin && (
            <>
              <div className="nav-label">PLATFORM</div>
              <NavLink to="/platform">Platform setup</NavLink>
            </>
          )}
        </nav>
        <div className="side-bottom">
          <b>{user.name}</b>
          {user.tenant.name} · {user.role.toLowerCase()}
          <div style={{ marginTop: 8 }}>
            <button className="link" onClick={() => void logout()}>Sign out</button>
          </div>
        </div>
      </aside>
      <main className="main">
        <div className="content">{children}</div>
      </main>
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div className="auth-wrap">Loading…</div>;
  // The reset link opens the same page whether or not someone is signed in on this browser.
  if (location.pathname.startsWith('/reset/')) {
    return (
      <Routes>
        <Route path="/reset/:token" element={<ResetPassword />} />
      </Routes>
    );
  }
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/join/:token" element={<Join />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname + location.search }} />} />
      </Routes>
    );
  }
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/login" element={<Navigate to="/dashboard" replace />} />
        <Route path="/register" element={<Navigate to="/dashboard" replace />} />
        <Route path="/join/:token" element={<Navigate to="/dashboard" replace />} />
        <Route path="/forgot-password" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/orgs" element={<Orgs />} />
        <Route path="/orgs/:id" element={<OrgDetail />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:id" element={<RunDetail />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/platform" element={user.isPlatformAdmin ? <PlatformPage /> : <Navigate to="/orgs" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
  );
}
