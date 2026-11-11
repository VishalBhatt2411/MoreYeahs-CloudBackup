import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, setDisplayZone, type User } from './api';

interface AuthValue {
  user: User | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  register(input: { workspaceName: string; name: string; email: string; password: string }): Promise<void>;
  logout(): Promise<void>;
  acceptInvite(input: { token: string; name: string; password: string }): Promise<void>;
  /** Update what we know about the signed-in user's company after Settings are saved. */
  setTenant(patch: Partial<User['tenant']>): void;
}

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // Set during render so every date drawn below already uses the company's time zone.
  setDisplayZone(user?.tenant.timeZone);

  useEffect(() => {
    api<{ user: User }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) console.warn(e);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api<{ user: User }>('/auth/login', { method: 'POST', body: { email, password } });
    setUser(r.user);
  }, []);
  const register = useCallback(async (input: { workspaceName: string; name: string; email: string; password: string }) => {
    const r = await api<{ user: User }>('/auth/register', { method: 'POST', body: input });
    setUser(r.user);
  }, []);
  const acceptInvite = useCallback(async (input: { token: string; name: string; password: string }) => {
    const r = await api<{ user: User }>('/auth/accept-invite', { method: 'POST', body: input });
    setUser(r.user);
  }, []);
  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    setUser(null);
  }, []);

  const setTenant = useCallback((patch: Partial<User['tenant']>) => {
    setUser((u) => (u ? { ...u, tenant: { ...u.tenant, ...patch } } : u));
  }, []);

  return <Ctx.Provider value={{ user, loading, login, register, logout, acceptInvite, setTenant }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}

export const canManage = (u: User | null) => !!u && (u.role === 'OWNER' || u.role === 'ADMIN');
