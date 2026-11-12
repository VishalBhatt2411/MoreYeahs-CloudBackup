import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errText, formatBytes, formatDate, type RunDetail as RunDetailT, type RunItem } from '../api';
import { canExport, useAuth } from '../auth';
import { Notice, PageHead, StatusPill, useLoad } from '../ui';
import { isActiveRun } from './Runs';

type Format = 'xlsx' | 'csv';
type Headers = 'label' | 'api';

interface Cat { id: string; kind: 'data' | 'metadata'; order: number; label: string; description: string }

const FORMATS: { id: Format; label: string; hint: string }[] = [
  { id: 'xlsx', label: 'Excel (.xlsx)', hint: 'One workbook per group, one sheet per object, with a guide and an index.' },
  { id: 'csv', label: 'CSV (.csv)', hint: 'Plain files that open anywhere. Several files come as one zip.' },
];

function ItemRow({ i, kind, exportOk, busy, onDownload }: { i: RunItem; kind: 'data' | 'metadata'; exportOk: boolean; busy: boolean; onDownload: (id: string) => void }) {
  const title = kind === 'metadata' && i.label && i.label !== i.name ? i.label : i.name;
  return (
    <tr>
      <td>
        <strong>{title}</strong>
        {title !== i.name && <div className="hint mono">{i.name}</div>}
        {i.error && <div className="err">{i.error}</div>}
        {i.note && <div className="hint">{i.note}</div>}
        {i.mode === 'INCREMENTAL' && (
          <div className="hint">Incremental: {(i.changedCount ?? 0).toLocaleString()} changed, {(i.deletedCount ?? 0).toLocaleString()} deleted since the last backup</div>
        )}
      </td>
      <td><StatusPill status={i.status} /></td>
      <td>{i.expectedCount ?? '-'}</td>
      <td>{i.rowCount ?? '-'}</td>
      <td>{formatBytes(i.bytes)}</td>
      <td className="mono" title={i.sha256 ?? undefined}>{i.sha256 ? `${i.sha256.slice(0, 10)}…` : '-'}</td>
      <td>{i.downloadable && exportOk && <button className="link" disabled={busy} onClick={() => onDownload(i.id)}>Download</button>}</td>
    </tr>
  );
}

function CategoryBlock({
  cat, items, exportOk, running, busy, onCategory, onItem, defaultOpen,
}: {
  cat: Cat; items: RunItem[]; exportOk: boolean; running: boolean; busy: boolean;
  onCategory: (id: string) => void; onItem: (id: string) => void; defaultOpen: boolean;
}) {
  const problems = items.filter((i) => i.status === 'FAILED' || i.status === 'PARTIAL').length;
  const saved = items.filter((i) => i.downloadable).length;
  const rows = items.reduce((a, i) => a + (cat.kind === 'data' ? i.rowCount ?? 0 : 0), 0);
  const bytes = items.reduce((a, i) => a + (i.bytes ?? 0), 0);
  return (
    <details className="run-cat" open={defaultOpen || problems > 0}>
      <summary>
        <span className="run-cat-title">
          <strong>{cat.label}</strong>
          <small>{cat.description}</small>
        </span>
        <span className="run-cat-meta">
          {items.length} {cat.kind === 'data' ? (items.length === 1 ? 'object' : 'objects') : (items.length === 1 ? 'type' : 'types')}
          {cat.kind === 'data' && rows > 0 && <> · {rows.toLocaleString()} records</>}
          {' · '}{formatBytes(bytes)}
          {problems > 0 && <span className="pill bad"> {problems} with problems</span>}
        </span>
      </summary>
      <div className="run-cat-body">
        {exportOk && (
          <div className="run-cat-actions">
            <button className="btn secondary small" disabled={busy || running || saved === 0} onClick={() => onCategory(cat.id)}>
              Download this group
            </button>
          </div>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>{cat.kind === 'data' ? 'OBJECT' : 'TYPE'}</th><th>STATUS</th><th>EXPECTED</th><th>SAVED</th><th>SIZE</th><th>CHECKSUM</th><th></th></tr>
            </thead>
            <tbody>
              {items.map((i) => <ItemRow key={i.id} i={i} kind={cat.kind} exportOk={exportOk} busy={busy || running} onDownload={onItem} />)}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

export default function RunDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const exportOk = canExport(user);
  const [dlError, setDlError] = useState<string | null>(null);
  const [dlBusy, setDlBusy] = useState(false);
  const [format, setFormat] = useState<Format>('xlsx');
  const [headers, setHeaders] = useState<Headers>('label');
  const [filter, setFilter] = useState<'all' | 'problems'>('all');
  const res = useLoad(() => api<{ run: RunDetailT }>(`/runs/${id}`), [id], { active: (d) => isActiveRun(d.run) });
  const run = res.data?.run;

  async function download(body: Record<string, unknown>) {
    setDlError(null);
    setDlBusy(true);
    try {
      const r = await api<{ url: string }>(`/runs/${id}/download-link`, { method: 'POST', body });
      window.location.assign(r.url);
    } catch (e) {
      setDlError(errText(e));
    } finally {
      // The browser starts the download by itself; give the button back after a moment.
      setTimeout(() => setDlBusy(false), 1500);
    }
  }
  const structured = (extra: Record<string, unknown> = {}) => download({ kind: 'structured', format, headers, ...extra });

  const groups = useMemo(() => {
    if (!run) return [];
    const cats: Cat[] = run.categories ?? [];
    const byCat = new Map<string, RunItem[]>();
    for (const i of run.items) {
      if (filter === 'problems' && i.status !== 'FAILED' && i.status !== 'PARTIAL') continue;
      const key = i.category ?? (i.kind === 'OBJECT' ? 'data.system' : 'meta.other');
      const list = byCat.get(key);
      if (list) list.push(i);
      else byCat.set(key, [i]);
    }
    return (['data', 'metadata'] as const).map((kind) => ({
      kind,
      cats: cats
        .filter((c) => c.kind === kind && byCat.has(c.id))
        .sort((a, b) => a.order - b.order)
        .map((c) => ({ cat: c, items: (byCat.get(c.id) ?? []).sort((a, b) => (a.label ?? a.name).localeCompare(b.label ?? b.name)) })),
    }));
  }, [run, filter]);

  if (res.error && !run) return <Notice kind="error">{res.error}</Notice>;
  if (!run) return <div className="empty">Loading…</div>;

  const s = run.summary;
  const running = isActiveRun(run);
  const hasFiles = run.items.some((i) => i.downloadable);
  const objectCount = run.items.filter((i) => i.kind === 'OBJECT').length;
  const typeCount = run.items.filter((i) => i.kind === 'METADATA').length;
  const titles = { data: 'Records', metadata: 'Configuration' } as const;
  const blurbs = {
    data: 'The data stored in the org\'s objects, grouped by what it is used for. Each object becomes one sheet.',
    metadata: 'How the org is set up, grouped by area. Each type becomes plain tables, and code is kept as readable files.',
  } as const;

  return (
    <>
      <PageHead
        eyebrow="BACKUP RUN"
        title={run.orgLabel ?? 'Backup run'}
        subtitle={<><StatusPill status={run.status} /> {run.orgUsername} · started {formatDate(run.startedAt ?? run.createdAt)}{run.finishedAt ? ` · finished ${formatDate(run.finishedAt)}` : ''} · {run.mode === 'INCREMENTAL' ? 'incremental' : 'full copy'}{run.attempts && run.attempts > 1 ? ` · attempt ${run.attempts}` : ''}</>}
        actions={
          <>
            <Link className="btn secondary" to={`/orgs/${run.connectionId}`}>Open org</Link>
            <Link className="btn secondary" to={`/explorer?org=${run.connectionId}&run=${run.id}`}>Browse records</Link>
          </>
        }
      />
      {dlError && <Notice kind="error">{dlError}</Notice>}
      {run.message && <Notice kind={run.status === 'SUCCEEDED' ? 'ok' : run.status === 'PARTIAL' ? 'warn' : run.status === 'FAILED' ? 'error' : undefined}>{run.message}</Notice>}
      {running && <Notice>This backup is running. This page updates by itself.</Notice>}

      <div className="cards">
        <div className="card"><span>Objects · config types</span><div className="big">{objectCount} · {typeCount}</div></div>
        <div className="card"><span>Succeeded</span><div className="big">{s.succeeded}</div></div>
        <div className="card"><span>Partial / failed</span><div className="big">{s.partial + s.failed}</div></div>
        <div className="card"><span>Records · size</span><div className="big">{s.rows.toLocaleString()} · {formatBytes(s.bytes)}</div></div>
      </div>

      {exportOk && (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>Download</h2>
              <p>Get this backup as ready-to-read files. The download starts with a summary and a read-me, then Records and Configuration, each in its own folder by group.</p>
            </div>
          </div>
          <div className="dl-options">
            <div className="seg" role="group" aria-label="File format">
              {FORMATS.map((f) => (
                <button key={f.id} type="button" className={format === f.id ? 'on' : ''} title={f.hint} onClick={() => setFormat(f.id)}>{f.label}</button>
              ))}
            </div>
            <div className="seg" role="group" aria-label="Column names">
              <button type="button" className={headers === 'label' ? 'on' : ''} title="Column titles as shown in Salesforce, e.g. Account Name" onClick={() => setHeaders('label')}>Plain column names</button>
              <button type="button" className={headers === 'api' ? 'on' : ''} title="Column titles as developers know them, e.g. Name, Industry__c" onClick={() => setHeaders('api')}>Salesforce API names</button>
            </div>
            <button className="btn primary" disabled={!hasFiles || running || dlBusy} onClick={() => void structured()}>
              {dlBusy ? 'Preparing…' : `Download everything (${format === 'xlsx' ? 'Excel' : 'CSV'})`}
            </button>
          </div>
          <p className="hint-line">
            {FORMATS.find((f) => f.id === format)?.hint} Large backups can take a minute to prepare. You can also download one group or one item below.
            {' '}
            <button className="link" disabled={!hasFiles || running || dlBusy} onClick={() => void download({})} title="The exact files that were saved, compressed. For technical use and re-importing.">
              Raw archive (.zip)
            </button>
          </p>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>What was copied</h2>
            <p>"Expected" is what Salesforce said exists. "Saved" is what we stored. They must match for an item to count as succeeded. The checksum (SHA-256) is for the saved file.</p>
          </div>
          <div className="head-actions">
            <button className={`btn small ${filter === 'all' ? 'primary' : 'secondary'}`} onClick={() => setFilter('all')}>All</button>
            <button className={`btn small ${filter === 'problems' ? 'primary' : 'secondary'}`} onClick={() => setFilter('problems')}>Problems only</button>
          </div>
        </div>
        {run.items.length === 0 && <div className="empty">Nothing here yet.</div>}
        {run.items.length > 0 && groups.every((g) => g.cats.length === 0) && <div className="empty">No problems.</div>}
      </div>

      {groups.map((g) => g.cats.length > 0 && (
        <section className="panel" key={g.kind}>
          <div className="panel-head">
            <div>
              <h2>{titles[g.kind]}</h2>
              <p>{blurbs[g.kind]}</p>
            </div>
          </div>
          {g.cats.map(({ cat, items }) => (
            <CategoryBlock
              key={cat.id}
              cat={cat}
              items={items}
              exportOk={exportOk}
              running={running}
              busy={dlBusy}
              defaultOpen={g.cats.length === 1}
              onCategory={(c) => void structured({ category: c })}
              onItem={(itemId) => void structured({ itemId })}
            />
          ))}
        </section>
      ))}
    </>
  );
}
