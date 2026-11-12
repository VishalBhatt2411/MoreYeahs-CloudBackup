import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PRESETS,
  activePreset,
  itemsByCategory,
  type Coverage,
  type CoverageCategory,
  type PickItem,
} from './selection';

/** A checkbox that can show "some of the items below are ticked". */
function Tri({ state, onChange, label }: { state: 'all' | 'some' | 'none'; onChange: (next: boolean) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={state === 'all'} onChange={(e) => onChange(e.target.checked)} />;
}

const stateOf = (ticked: number, total: number): 'all' | 'some' | 'none' => (total > 0 && ticked === total ? 'all' : ticked > 0 ? 'some' : 'none');

function CategoryCard({
  cat,
  items,
  selected,
  setMany,
  noun,
}: {
  cat: CoverageCategory;
  items: PickItem[];
  selected: Set<string>;
  setMany: (keys: string[], on: boolean) => void;
  noun: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ticked = items.filter((i) => selected.has(i.key)).length;
  const state = stateOf(ticked, items.length);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? items.filter((i) => i.label.toLowerCase().includes(s) || i.name.toLowerCase().includes(s)) : items;
  }, [items, q]);

  return (
    <div className={`pick-cat ${state !== 'none' ? 'on' : ''}`}>
      <div className="pick-cat-head">
        <label className="pick-cat-main">
          <Tri state={state} label={cat.label} onChange={(on) => setMany(items.map((i) => i.key), on)} />
          <span>
            <strong>{cat.label}</strong>
            <small>{cat.description}</small>
          </span>
        </label>
        <div className="pick-cat-side">
          <span className="pick-count">{ticked} of {items.length}</span>
          <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide list' : `Choose ${noun}`}
          </button>
        </div>
      </div>
      {open && (
        <div className="pick-list">
          <div className="pick-list-tools">
            <input placeholder={`Search ${items.length} ${noun}`} value={q} onChange={(e) => setQ(e.target.value)} />
            <span>
              <button type="button" className="link" onClick={() => setMany(shown.map((i) => i.key), true)}>Tick {q ? 'shown' : 'all'}</button>
              {' · '}
              <button type="button" className="link" onClick={() => setMany(shown.map((i) => i.key), false)}>Untick {q ? 'shown' : 'all'}</button>
            </span>
          </div>
          <div className="pick-items">
            {shown.map((i) => (
              <label key={i.key} title={i.name}>
                <input type="checkbox" checked={selected.has(i.key)} onChange={(e) => setMany([i.key], e.target.checked)} />
                <span>
                  {i.label}
                  {i.label !== i.name && <small>{i.name}</small>}
                </span>
              </label>
            ))}
            {shown.length === 0 && <small>Nothing matches “{q}”.</small>}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  blurb,
  side,
  coverage,
  byCat,
  selected,
  setMany,
  noun,
}: {
  title: string;
  blurb: string;
  side: 'data' | 'metadata';
  coverage: Coverage;
  byCat: Map<string, PickItem[]>;
  selected: Set<string>;
  setMany: (keys: string[], on: boolean) => void;
  noun: string;
}) {
  const cats = coverage.categories.filter((c) => c.kind === side && (byCat.get(c.id)?.length ?? 0) > 0);
  const keys = cats.flatMap((c) => (byCat.get(c.id) ?? []).map((i) => i.key));
  const ticked = keys.filter((k) => selected.has(k)).length;
  return (
    <section className="pick-section">
      <div className="pick-section-head">
        <label className="pick-cat-main">
          <Tri state={stateOf(ticked, keys.length)} label={`All ${title}`} onChange={(on) => setMany(keys, on)} />
          <span>
            <h3>{title}</h3>
            <small>{blurb}</small>
          </span>
        </label>
        <span className="pick-count">{ticked} of {keys.length} {noun}</span>
      </div>
      {cats.map((c) => (
        <CategoryCard key={c.id} cat={c} items={byCat.get(c.id) ?? []} selected={selected} setMany={setMany} noun={noun} />
      ))}
      {cats.length === 0 && <small>Nothing of this kind is available in this org.</small>}
    </section>
  );
}

/**
 * Two sections, Records and Configuration, each split into plain-language groups with their own
 * ticks. Every group can be opened to pick single objects or types.
 */
export default function BackupPicker({
  coverage,
  selected,
  onChange,
}: {
  coverage: Coverage;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const byCat = useMemo(() => itemsByCategory(coverage), [coverage]);
  const preset = activePreset(coverage, selected);

  const setMany = (keys: string[], on: boolean) => {
    const next = new Set(selected);
    for (const k of keys) {
      if (on) next.add(k);
      else next.delete(k);
    }
    onChange(next);
  };

  return (
    <div className="picker">
      <div className="presets" role="group" aria-label="Quick choices">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className={`chip ${preset === p.id ? 'on' : ''}`} title={p.hint} onClick={() => onChange(p.pick(coverage))}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="pick-grid">
        <Section
          title="Records"
          blurb="The data stored in your objects: accounts, contacts, cases, your own objects and so on."
          side="data"
          coverage={coverage}
          byCat={byCat}
          selected={selected}
          setMany={setMany}
          noun="objects"
        />
        <Section
          title="Configuration"
          blurb="How your org is set up: fields, security, code, automation, layouts, reports and settings."
          side="metadata"
          coverage={coverage}
          byCat={byCat}
          selected={selected}
          setMany={setMany}
          noun="types"
        />
      </div>
    </div>
  );
}
