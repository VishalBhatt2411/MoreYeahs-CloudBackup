import { useEffect, useRef, useState, type ReactNode } from 'react';

const PILL: Record<string, { cls: string; text: string }> = {
  SUCCEEDED: { cls: '', text: 'Succeeded' },
  PARTIAL: { cls: 'warning', text: 'Partial' },
  FAILED: { cls: 'bad', text: 'Failed' },
  RUNNING: { cls: 'blue', text: 'Running' },
  QUEUED: { cls: 'blue', text: 'Queued' },
  PENDING: { cls: 'grey', text: 'Waiting' },
  ACTIVE: { cls: '', text: 'Connected' },
  NEEDS_RECONNECT: { cls: 'warning', text: 'Reconnect needed' },
  DISCONNECTED: { cls: 'grey', text: 'Disconnected' },
};

export function StatusPill({ status }: { status: string }) {
  const p = PILL[status] ?? { cls: 'grey', text: status };
  return <span className={`pill ${p.cls}`}>{p.text}</span>;
}

export function Notice({ kind, children }: { kind?: 'error' | 'ok' | 'warn'; children: ReactNode }) {
  return <div className={`notice ${kind ?? ''}`}>{children}</div>;
}

export function PageHead({ eyebrow, title, subtitle, actions }: { eyebrow?: string; title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </div>
  );
}

/** Small message at the bottom of the screen that goes away by itself. */
export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = (m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 4000);
  };
  const node = msg ? <div className="toast" role="status">{msg}</div> : null;
  return { show, node };
}

/** Loads something now, and again every `everyMs` while `active` is true. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], opts: { active?: (d: T) => boolean; everyMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const run = async () => {
      try {
        const d = await loadRef.current();
        if (cancelled) return;
        setData(d);
        setError(null);
        if (optsRef.current.active?.(d)) timer = window.setTimeout(run, optsRef.current.everyMs ?? 3000);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    setLoading(true);
    void run();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, error, loading, reload: () => setTick((t) => t + 1), setData };
}
