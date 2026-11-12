/**
 * The "what do you want to back up?" choice, as the screen sees it.
 *
 * The screen keeps one flat set of ticked items (`o:Account`, `m:ApexClass`). These helpers turn
 * that set into what the server wants (whole sections where everything in a section is ticked,
 * single items otherwise) and back again.
 */

export interface CoverageCategory {
  id: string;
  kind: 'data' | 'metadata';
  order: number;
  label: string;
  description: string;
}

export interface CoverageObject { name: string; label: string; custom: boolean; category: string }
export interface CoverageType { name: string; label: string; category: string }

export interface SavedSelection {
  includeRecords?: boolean;
  includeMetadata?: boolean;
  categories?: string[];
  objects?: string[];
  metadataTypes?: string[];
  fullCopy?: boolean;
}

export interface Coverage {
  apiVersion: string;
  categories: CoverageCategory[];
  objects: CoverageObject[];
  excludedObjects: { name: string; label?: string; reason: string }[];
  metadataTypes: CoverageType[];
  defaultSelection: SavedSelection | null;
}

export interface PickItem {
  key: string;
  name: string;
  label: string;
  category: string;
  side: 'data' | 'metadata';
}

export const objKey = (name: string) => `o:${name}`;
export const typeKey = (name: string) => `m:${name}`;

export function allItems(cov: Coverage): PickItem[] {
  return [
    ...cov.objects.map((o): PickItem => ({ key: objKey(o.name), name: o.name, label: o.label || o.name, category: o.category, side: 'data' })),
    ...cov.metadataTypes.map((t): PickItem => ({ key: typeKey(t.name), name: t.name, label: t.label || t.name, category: t.category, side: 'metadata' })),
  ];
}

export function itemsByCategory(cov: Coverage): Map<string, PickItem[]> {
  const m = new Map<string, PickItem[]>();
  for (const it of allItems(cov)) {
    const list = m.get(it.category);
    if (list) list.push(it);
    else m.set(it.category, [it]);
  }
  for (const list of m.values()) list.sort((a, b) => a.label.localeCompare(b.label));
  return m;
}

/** Everything ticked. */
export function everythingSelected(cov: Coverage): Set<string> {
  return new Set(allItems(cov).map((i) => i.key));
}

/** The ticks that match a selection saved earlier (or everything when none was saved). */
export function fromSaved(cov: Coverage, saved: SavedSelection | null): Set<string> {
  if (!saved) return everythingSelected(cov);
  const out = new Set<string>();
  const cats = new Set(saved.categories ?? []);
  const objs = new Set(saved.objects ?? []);
  const types = new Set(saved.metadataTypes ?? []);
  const dataFiltered = cats.size > 0 && [...cats].some((c) => c.startsWith('data.')) || objs.size > 0;
  const metaFiltered = [...cats].some((c) => c.startsWith('meta.')) || types.size > 0;
  for (const it of allItems(cov)) {
    if (it.side === 'data') {
      if (saved.includeRecords === false) continue;
      if (!dataFiltered || objs.has(it.name) || cats.has(it.category)) out.add(it.key);
    } else {
      if (saved.includeMetadata === false) continue;
      if (!metaFiltered || types.has(it.name) || cats.has(it.category)) out.add(it.key);
    }
  }
  return out;
}

export interface Built {
  selection: SavedSelection;
  /** Nothing is narrowed: the server will back up everything it can. */
  everything: boolean;
  /** Nothing is ticked at all. */
  empty: boolean;
  objects: number;
  types: number;
}

/** Turns the ticks into the request body. */
export function buildSelection(cov: Coverage, selected: Set<string>): Built {
  const byCat = itemsByCategory(cov);
  const selection: SavedSelection = {};
  const categories: string[] = [];
  const objects: string[] = [];
  const metadataTypes: string[] = [];
  let everything = true;
  let countObjects = 0;
  let countTypes = 0;

  for (const side of ['data', 'metadata'] as const) {
    const items = allItems(cov).filter((i) => i.side === side);
    const picked = items.filter((i) => selected.has(i.key));
    if (side === 'data') countObjects = picked.length;
    else countTypes = picked.length;
    if (picked.length === 0) {
      everything = false;
      if (side === 'data') selection.includeRecords = false;
      else selection.includeMetadata = false;
      continue;
    }
    if (picked.length === items.length) continue;
    everything = false;
    for (const c of cov.categories.filter((c) => c.kind === side)) {
      const list = byCat.get(c.id) ?? [];
      if (list.length === 0) continue;
      const ticked = list.filter((i) => selected.has(i.key));
      if (ticked.length === list.length) categories.push(c.id);
      else for (const i of ticked) (side === 'data' ? objects : metadataTypes).push(i.name);
    }
  }
  if (categories.length) selection.categories = categories;
  if (objects.length) selection.objects = objects;
  if (metadataTypes.length) selection.metadataTypes = metadataTypes;
  const empty = countObjects === 0 && countTypes === 0;
  return { selection: everything ? {} : selection, everything, empty, objects: countObjects, types: countTypes };
}

export interface Preset {
  id: string;
  label: string;
  hint: string;
  pick: (cov: Coverage) => Set<string>;
}

const only = (cov: Coverage, test: (i: PickItem) => boolean) => new Set(allItems(cov).filter(test).map((i) => i.key));

export const PRESETS: Preset[] = [
  { id: 'all', label: 'Everything', hint: 'All records and all configuration', pick: everythingSelected },
  { id: 'config', label: 'Configuration only', hint: 'How the org is set up, without any record data', pick: (c) => only(c, (i) => i.side === 'metadata') },
  { id: 'records', label: 'Records only', hint: 'The data in your objects, without configuration', pick: (c) => only(c, (i) => i.side === 'data') },
  { id: 'security', label: 'Security only', hint: 'Profiles, permission sets, roles, sharing and access records', pick: (c) => only(c, (i) => i.category === 'meta.security' || i.category === 'data.users') },
  { id: 'code', label: 'Code & automation', hint: 'Apex, flows, workflows and Lightning components', pick: (c) => only(c, (i) => i.category === 'meta.apex' || i.category === 'meta.automation') },
  { id: 'business', label: 'Business data', hint: 'Sales, service, marketing and your own custom objects', pick: (c) => only(c, (i) => i.category === 'data.business' || i.category === 'data.custom') },
];

/** Which preset matches the current ticks, if any. */
export function activePreset(cov: Coverage, selected: Set<string>): string | null {
  for (const p of PRESETS) {
    const want = p.pick(cov);
    if (want.size === selected.size && [...want].every((k) => selected.has(k))) return p.id;
  }
  return null;
}
