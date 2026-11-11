export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** Talks to the backend. Errors come back with a message that is safe to show on screen. */
export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check that it is running and try again.');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status}).`, data.code);
  return data as T;
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'OWNER' | 'ADMIN' | 'VIEWER';
  isPlatformAdmin: boolean;
  tenant: { id: string; name: string; timeZone: string };
}

export interface Connection {
  id: string;
  label: string;
  environment: 'PRODUCTION' | 'SANDBOX';
  username: string;
  orgName: string | null;
  sfOrgId: string;
  instanceUrl: string;
  status: 'ACTIVE' | 'NEEDS_RECONNECT' | 'DISCONNECTED';
  lastError: string | null;
  connectedAt: string;
  lastCheckedAt: string | null;
  scheduleHours: number | null;
  nextRunAt: string | null;
  lastRun?: { id: string; status: string; createdAt: string; finishedAt: string | null } | null;
}

export interface Run {
  id: string;
  connectionId: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  trigger: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  orgLabel?: string;
  orgUsername?: string;
}

export interface RunItem {
  id: string;
  kind: 'OBJECT' | 'METADATA';
  name: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  expectedCount: number | null;
  rowCount: number | null;
  bytes: number | null;
  sha256: string | null;
  note: string | null;
  error: string | null;
  downloadable: boolean;
}

export interface RunDetail extends Run {
  summary: { total: number; succeeded: number; partial: number; failed: number; pending: number; rows: number; bytes: number };
  items: RunItem[];
}

export function formatBytes(n: number | null | undefined) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// Dates are shown in the company's time zone (Settings). Set by the sign-in state.
let displayZone: string | undefined;
export function setDisplayZone(zone: string | undefined) {
  displayZone = zone;
}
export const getDisplayZone = () => displayZone;

export function formatDate(s: string | null | undefined) {
  if (!s) return '-';
  try {
    return new Date(s).toLocaleString(undefined, { timeZone: displayZone });
  } catch {
    return new Date(s).toLocaleString();
  }
}

export interface Settings {
  name: string;
  timeZone: string;
  retentionDays: number | null;
  defaultScheduleHours: number | null;
  alertOnFailure: boolean;
  alertEmail: string | null;
  sessionHours: number;
}

export interface TeamUser {
  id: string;
  email: string;
  name: string;
  role: User['role'];
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface TeamInvite {
  id: string;
  email: string;
  role: User['role'];
  createdAt: string;
  expiresAt: string;
}

export interface Dashboard {
  timeZone: string;
  retentionDays: number | null;
  totals: { orgs: number; connected: number; running: number; bytes: number; rows: number };
  last30Days: Record<'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'RUNNING' | 'QUEUED', number>;
  nextScheduled: { connectionId: string; orgLabel: string; at: string } | null;
  orgs: {
    id: string;
    label: string;
    username: string;
    environment: 'PRODUCTION' | 'SANDBOX';
    status: Connection['status'];
    scheduleHours: number | null;
    nextRunAt: string | null;
    lastRun: { id: string; status: string; finishedAt: string | null; createdAt: string } | null;
    lastGoodAt: string | null;
  }[];
  attention: { kind: 'reconnect' | 'failed' | 'partial' | 'overdue' | 'never'; connectionId: string; orgLabel: string; text: string; runId?: string }[];
  recentRuns: { id: string; status: string; trigger: string; createdAt: string; finishedAt: string | null; orgLabel: string; orgUsername: string }[];
}
