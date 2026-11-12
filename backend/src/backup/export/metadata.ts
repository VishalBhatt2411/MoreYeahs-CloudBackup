import { XMLParser } from 'fast-xml-parser';
import { strFromU8, unzipSync } from 'fflate';
import { humanizeApiName } from '../categories.js';
import type { Cell, Col } from './tables.js';

/**
 * Turns the raw configuration a backup holds (Salesforce's XML files inside zips) into plain tables:
 * "who can do what" for profiles, a data dictionary for objects, a list of Apex classes with their
 * source, and so on. Types without a hand-made layout still get a readable "Component | Section |
 * Item | Setting | Value" listing, so nothing is left as raw XML.
 */

type Obj = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: true,
  ignoreDeclaration: true,
  parseTagValue: false,
  trimValues: true,
});

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const arr = (x: unknown): unknown[] => (x === undefined || x === null || x === '' ? [] : Array.isArray(x) ? x : [x]);
const isScalar = (x: unknown) => x === null || x === undefined || ['string', 'number', 'boolean'].includes(typeof x);

function scalar(x: unknown): Cell {
  if (x === undefined || x === null) return null;
  if (typeof x === 'boolean') return x;
  const s = String(x);
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

/** Anything at all as a short piece of text. */
function plain(x: unknown, depth = 0): Cell {
  if (isScalar(x)) return scalar(x);
  if (Array.isArray(x)) {
    const parts = x.map((e) => plain(e, depth + 1)).filter((e) => e !== null && e !== '');
    return parts.join('; ');
  }
  if (depth > 3) return '';
  return Object.entries(x as Obj)
    .map(([k, v]) => [k, plain(v, depth + 1)] as const)
    .filter(([, v]) => v !== null && v !== '')
    .map(([k, v]) => `${humanizeApiName(k)}: ${String(v)}`)
    .join(', ');
}

const str = (x: unknown) => String(plain(x) ?? '');

// -------------------------------------------------------------------------------------------
// Collecting rows
// -------------------------------------------------------------------------------------------

const MAX_ROWS_PER_TABLE = 250_000;

export interface AccTable {
  cols: Col[];
  rows: Cell[][];
  seen: Set<string>;
  capped: boolean;
}

/** Rows gathered from many components, grouped by table. The same row arriving twice is kept once. */
export class TableAcc {
  readonly tables = new Map<string, AccTable>();

  add(title: string, cols: Col[], row: Cell[]) {
    let t = this.tables.get(title);
    if (!t) {
      t = { cols, rows: [], seen: new Set(), capped: false };
      this.tables.set(title, t);
    }
    if (t.rows.length >= MAX_ROWS_PER_TABLE) {
      t.capped = true;
      return;
    }
    const key = row.map((c) => (c instanceof Date ? c.toISOString() : typeof c === 'object' && c ? c.text : String(c))).join('\u0001');
    if (t.seen.has(key)) return;
    t.seen.add(key);
    t.rows.push(row);
  }
}

// -------------------------------------------------------------------------------------------
// Hand-made layouts
// -------------------------------------------------------------------------------------------

interface Ctx {
  name: string;
  src?: { lines: number; chars: number; rel: string; body: string };
}

type Getter = string | ((o: Obj, c: Ctx) => Cell);

interface Spec {
  sheet: string;
  /** Heading of the first column (the component the row belongs to). */
  first: string;
  /** Top-level element holding the rows. Without it, the whole component is one row. */
  from?: string;
  where?: (o: Obj) => boolean;
  cols: Array<[header: string, get: Getter, kind?: Col['kind'], width?: number]>;
}

const yes = (k: string): Getter => (o) => scalar(o[k]);
const text = (k: string): Getter => (o) => plain(o[k]);
const splitFirst = (s: unknown, part: 0 | 1): Cell => {
  const v = String(s ?? '');
  const i = v.indexOf('.');
  if (i < 0) return part === 0 ? v : '';
  return part === 0 ? v.slice(0, i) : v.slice(i + 1);
};

function permissionSpecs(kind: 'Profile' | 'Permission Set'): Spec[] {
  const p = kind;
  const tabs = kind === 'Profile' ? 'tabVisibilities' : 'tabSettings';
  return [
    {
      sheet: `${p} - Objects`, first: kind, from: 'objectPermissions',
      cols: [['Object', 'object'], ['Can read', yes('allowRead')], ['Can create', yes('allowCreate')], ['Can edit', yes('allowEdit')], ['Can delete', yes('allowDelete')], ['View all records', yes('viewAllRecords')], ['Modify all records', yes('modifyAllRecords')]],
    },
    {
      sheet: `${p} - Fields`, first: kind, from: 'fieldPermissions',
      cols: [['Object', (o) => splitFirst(o.field, 0)], ['Field', (o) => splitFirst(o.field, 1)], ['Can read', yes('readable')], ['Can edit', yes('editable')]],
    },
    {
      sheet: `${p} - System Perms`, first: kind, from: 'userPermissions',
      cols: [['Permission', (o) => humanizeApiName(String(o.name ?? ''))], ['API name', 'name'], ['Enabled', yes('enabled')]],
    },
    { sheet: `${p} - Apex Classes`, first: kind, from: 'classAccesses', cols: [['Apex class', 'apexClass'], ['Enabled', yes('enabled')]] },
    { sheet: `${p} - VF Pages`, first: kind, from: 'pageAccesses', cols: [['Visualforce page', 'apexPage'], ['Enabled', yes('enabled')]] },
    { sheet: `${p} - Tabs`, first: kind, from: tabs, cols: [['Tab', 'tab'], ['Visibility', text('visibility')]] },
    { sheet: `${p} - Apps`, first: kind, from: 'applicationVisibilities', cols: [['App', 'application'], ['Visible', yes('visible')], ['Default app', yes('default')]] },
    { sheet: `${p} - Record Types`, first: kind, from: 'recordTypeVisibilities', cols: [['Record type', 'recordType'], ['Visible', yes('visible')], ['Default', yes('default')], ['Person account default', yes('personAccountDefault')]] },
    { sheet: `${p} - Custom Perms`, first: kind, from: 'customPermissions', cols: [['Custom permission', 'name'], ['Enabled', yes('enabled')]] },
    ...(kind === 'Profile' ? [{ sheet: 'Profile - Layouts', first: 'Profile', from: 'layoutAssignments', cols: [['Layout', 'layout'], ['Record type', text('recordType')]] } as Spec] : []),
  ];
}

const picklistValues = (o: Obj): Cell => {
  const vs = o.valueSet as Obj | undefined;
  const def = (vs?.valueSetDefinition as Obj | undefined)?.value;
  if (def) return arr(def).map((v) => str(isObj(v) ? v.label ?? v.fullName : v)).join('; ');
  if (vs?.valueSetName) return `Shared list: ${str(vs.valueSetName)}`;
  const legacy = (o.picklist as Obj | undefined)?.picklistValues;
  if (legacy) return arr(legacy).map((v) => str(isObj(v) ? v.fullName : v)).join('; ');
  return null;
};

const count = (k: string): Getter => (o) => arr(o[k]).length;

const SPECS: Record<string, Spec[]> = {
  Profile: [
    { sheet: 'Profiles', first: 'Profile', cols: [['Custom profile', yes('custom')], ['User license', text('userLicense')], ['Description', text('description')]] },
    ...permissionSpecs('Profile'),
  ],
  PermissionSet: [
    { sheet: 'Permission Sets', first: 'Permission set', cols: [['Label', text('label')], ['Description', text('description')], ['License', text('license')], ['Needs activation', yes('hasActivationRequired')]] },
    ...permissionSpecs('Permission Set'),
  ],
  CustomObject: [
    {
      sheet: 'Objects', first: 'Object', where: (o) => o.label !== undefined,
      cols: [['Label', text('label')], ['Plural label', text('pluralLabel')], ['Sharing model', text('sharingModel')], ['Deployment status', text('deploymentStatus')], ['Description', text('description')], ['Fields', count('fields')], ['Validation rules', count('validationRules')], ['Record types', count('recordTypes')]],
    },
    {
      sheet: 'Fields (data dictionary)', first: 'Object', from: 'fields',
      cols: [['Field label', text('label'), undefined, 28], ['API name', 'fullName', undefined, 28], ['Type', text('type')], ['Required', yes('required')], ['Unique', yes('unique')], ['External ID', yes('externalId')], ['Length', text('length')], ['Decimal places', text('scale')], ['Default value', text('defaultValue')], ['Formula', text('formula'), undefined, 40], ['Picklist values', picklistValues, undefined, 40], ['Related to', text('referenceTo')], ['Description', text('description'), undefined, 40], ['Help text', text('inlineHelpText'), undefined, 40]],
    },
    {
      sheet: 'Validation Rules', first: 'Object', from: 'validationRules',
      cols: [['Rule', 'fullName'], ['Active', yes('active')], ['Error message', text('errorMessage'), undefined, 40], ['Error shown at', text('errorDisplayField')], ['Rule formula', text('errorConditionFormula'), undefined, 50], ['Description', text('description'), undefined, 40]],
    },
    {
      sheet: 'Record Types', first: 'Object', from: 'recordTypes',
      cols: [['Record type', 'fullName'], ['Label', text('label')], ['Active', yes('active')], ['Description', text('description'), undefined, 40], ['Business process', text('businessProcess')]],
    },
  ],
  CustomLabels: [
    { sheet: 'Custom Labels', first: 'Set', from: 'labels', cols: [['Label name', 'fullName'], ['Value', text('value'), undefined, 50], ['Description', text('shortDescription'), undefined, 40], ['Language', text('language')], ['Category', text('categories')], ['Protected', yes('protected')]] },
  ],
  Workflow: [
    { sheet: 'Workflow Rules', first: 'Object', from: 'rules', cols: [['Rule', 'fullName'], ['Active', yes('active')], ['Runs when', text('triggerType')], ['Condition formula', text('formula'), undefined, 50], ['Actions', (o) => arr(o.actions).map((a) => (isObj(a) ? `${humanizeApiName(str(a.type))}: ${str(a.name)}` : str(a))).join('; '), undefined, 40], ['Description', text('description'), undefined, 40]] },
    { sheet: 'Workflow Field Updates', first: 'Object', from: 'fieldUpdates', cols: [['Update', 'fullName'], ['Field', text('field')], ['Operation', text('operation')], ['New value', (o) => plain(o.formula ?? o.literalValue ?? o.lookupValue ?? o.name), undefined, 40]] },
    { sheet: 'Workflow Email Alerts', first: 'Object', from: 'alerts', cols: [['Alert', 'fullName'], ['Template', text('template')], ['Description', text('description'), undefined, 40], ['Recipients', (o) => plain(o.recipients), undefined, 40]] },
  ],
  Layout: [
    {
      sheet: 'Layout Sections', first: 'Layout', from: 'layoutSections',
      cols: [['Section', text('label')], ['Style', text('style')], ['Fields', (o) => arr(o.layoutColumns).flatMap((c) => (isObj(c) ? arr(c.layoutItems) : [])).map((i) => (isObj(i) ? str(i.field ?? i.component ?? i.customLink) : '')).filter(Boolean).join('; '), undefined, 60]],
    },
    { sheet: 'Layout Related Lists', first: 'Layout', from: 'relatedLists', cols: [['Related list', text('relatedList')], ['Columns', (o) => plain(o.fields), undefined, 50]] },
  ],
  Flow: [
    {
      sheet: 'Flows', first: 'Flow',
      cols: [['Label', text('label')], ['Kind', text('processType')], ['Status', text('status')], ['Starts on object', (o) => plain((o.start as Obj | undefined)?.object)], ['Starts when', (o) => plain((o.start as Obj | undefined)?.triggerType ?? (o.start as Obj | undefined)?.recordTriggerType)], ['API version', text('apiVersion')], ['Description', text('description'), undefined, 40]],
    },
  ],
  ApexClass: [{ sheet: 'Apex Classes', first: 'Class', cols: [['API version', text('apiVersion')], ['Status', text('status')], ['Lines of code', (_o, c) => c.src?.lines ?? null], ['Source file', (_o, c) => c.src?.rel ?? 'not included', undefined, 40]] }],
  ApexTrigger: [
    {
      sheet: 'Apex Triggers', first: 'Trigger',
      cols: [['Runs on object', (_o, c) => /trigger\s+\w+\s+on\s+(\w+)/i.exec(c.src?.body ?? '')?.[1] ?? null], ['API version', text('apiVersion')], ['Status', text('status')], ['Lines of code', (_o, c) => c.src?.lines ?? null], ['Source file', (_o, c) => c.src?.rel ?? 'not included', undefined, 40]],
    },
  ],
  ApexPage: [{ sheet: 'Visualforce Pages', first: 'Page', cols: [['Label', text('label')], ['API version', text('apiVersion')], ['Description', text('description'), undefined, 40], ['Lines', (_o, c) => c.src?.lines ?? null], ['Source file', (_o, c) => c.src?.rel ?? 'not included', undefined, 40]] }],
  ApexComponent: [{ sheet: 'Visualforce Components', first: 'Component', cols: [['Label', text('label')], ['API version', text('apiVersion')], ['Description', text('description'), undefined, 40], ['Lines', (_o, c) => c.src?.lines ?? null], ['Source file', (_o, c) => c.src?.rel ?? 'not included', undefined, 40]] }],
};

/** Top-level elements a hand-made layout already shows, so the catch-all listing does not repeat them. */
function coveredKeys(root: string): Set<string> {
  const s = new Set<string>();
  for (const sp of SPECS[root] ?? []) if (sp.from) s.add(sp.from);
  if (root === 'Profile') ['tabVisibilities'].forEach((k) => s.add(k));
  if (root === 'PermissionSet') ['tabSettings'].forEach((k) => s.add(k));
  return s;
}

/** Elements that make up a flow (decisions, record updates, screens ...), listed with the name people gave them. */
function flowElements(name: string, body: Obj, acc: TableAcc) {
  const cols: Col[] = [{ header: 'Flow' }, { header: 'Step type' }, { header: 'Step name' }, { header: 'Label' }];
  for (const [k, v] of Object.entries(body)) {
    if (isScalar(v)) continue;
    for (const el of arr(v)) {
      if (isObj(el) && el.name !== undefined && k !== 'start') acc.add('Flow Steps', cols, [name, humanizeApiName(k), str(el.name), str(el.label ?? '')]);
    }
  }
}

const NAME_KEYS = ['fullName', 'name', 'label', 'developerName', 'field', 'object', 'apexClass', 'apexPage', 'tab', 'application', 'layout', 'recordType', 'flow', 'dataType'];

function itemName(el: Obj): string {
  for (const k of NAME_KEYS) if (isScalar(el[k]) && el[k] !== undefined && el[k] !== '') return str(el[k]);
  for (const [, v] of Object.entries(el)) if (isScalar(v) && v !== undefined && v !== '') return str(v);
  return '';
}

function flatten(o: Obj, prefix = '', depth = 0, out: Array<[string, Cell]> = []): Array<[string, Cell]> {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix} ${humanizeApiName(k)}` : humanizeApiName(k);
    if (isObj(v) && depth < 3) flatten(v, key, depth + 1, out);
    else out.push([key, plain(v)]);
  }
  return out;
}

const DETAIL_COLS: Col[] = [{ header: 'Component' }, { header: 'Section' }, { header: 'Item', width: 28 }, { header: 'Setting', width: 28 }, { header: 'Value', width: 50 }];
const ROWS_PER_COMPONENT = 500;

function detailRows(name: string, body: Obj, skip: Set<string>, includeScalars: boolean): Cell[][] {
  const rows: Cell[][] = [];
  const push = (r: Cell[]) => {
    if (rows.length < ROWS_PER_COMPONENT) rows.push(r);
  };
  for (const [k, v] of Object.entries(body)) {
    if (skip.has(k)) continue;
    const section = humanizeApiName(k);
    if (isScalar(v)) {
      if (includeScalars && v !== '') push([name, 'General', '', section, scalar(v)]);
      continue;
    }
    for (const el of arr(v)) {
      if (isScalar(el)) {
        push([name, section, '', '', scalar(el)]);
        continue;
      }
      const item = itemName(el as Obj);
      for (const [setting, value] of flatten(el as Obj)) {
        if (value === null || value === '') continue;
        push([name, section, item, setting, value]);
      }
    }
  }
  if (rows.length === ROWS_PER_COMPONENT) rows.push([name, '', '', '(more settings not shown here)', 'The raw archive has the complete file.']);
  return rows;
}

// -------------------------------------------------------------------------------------------
// Reading a zip
// -------------------------------------------------------------------------------------------

const SOURCE_FOLDERS = new Set(['classes', 'triggers', 'pages', 'components', 'lwc', 'aura', 'email']);
const SOURCE_FOLDER_LABEL: Record<string, string> = {
  classes: 'Apex Classes', triggers: 'Apex Triggers', pages: 'Visualforce Pages', components: 'Visualforce Components', lwc: 'Lightning Web Components', aura: 'Aura Components', email: 'Email Templates',
};
const MAX_MEMBER_BYTES = 4_000_000;

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function componentName(folder: string, rest: string[]): string {
  if ((folder === 'lwc' || folder === 'aura') && rest.length > 1) return decode(rest[0]);
  const last = decode(rest[rest.length - 1]).replace(/-meta\.xml$/, '').replace(/\.[^./]+$/, '');
  return [...rest.slice(0, -1).map(decode), last].join('/');
}

const looksXml = (b: Uint8Array) => {
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < b.length && b[i] <= 32) i++;
  return b[i] === 0x3c; // "<"
};

export interface ConvertResult {
  components: number;
  unreadable: number;
}

/**
 * Reads one saved metadata zip and adds what is in it to `acc`. Source code and similar text files
 * are passed to `onSource` with a path like "Source code/Apex Classes/MyClass.cls".
 */
export function convertMetadataZip(
  zip: Uint8Array,
  typeLabel: string,
  acc: TableAcc,
  onSource: (relPath: string, data: Uint8Array) => void,
): ConvertResult {
  const out: ConvertResult = { components: 0, unreadable: 0 };
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip, {
      filter: (f) => f.originalSize <= MAX_MEMBER_BYTES && !(/^(staticresources|documents)\//.test(f.name) && !f.name.endsWith('-meta.xml')),
    });
  } catch {
    out.unreadable++;
    return out;
  }

  // First pass: find source files, so a class's overview row can show its length.
  const sources = new Map<string, NonNullable<Ctx['src']>>();
  // Alphabetical, so every sheet reads in a predictable order (Salesforce returns files in no particular order).
  const names = Object.keys(files)
    .filter((n) => !n.endsWith('/') && n !== 'package.xml')
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }));
  for (const n of names) {
    const [folder, ...rest] = n.split('/');
    if (!SOURCE_FOLDERS.has(folder) || rest.length === 0 || n.endsWith('-meta.xml')) continue;
    const data = files[n];
    if (data.length > 2_000_000 || (folder !== 'lwc' && folder !== 'aura' && !/\.(cls|trigger|page|component|email|js|html|css|cmp|app|evt|intf|design|svg|auradoc)$/i.test(n))) continue;
    const rel = `Source code/${SOURCE_FOLDER_LABEL[folder]}/${rest.map(decode).join('/')}`;
    onSource(rel, data);
    const body = strFromU8(data);
    if (folder !== 'lwc' && folder !== 'aura') {
      sources.set(`${folder}/${componentName(folder, rest)}`, { lines: body.split('\n').length, chars: body.length, rel, body: body.slice(0, 2000) });
    }
  }

  for (const n of names) {
    const data = files[n];
    if (!looksXml(data)) continue;
    const [folder, ...rest] = n.split('/');
    if (rest.length === 0) continue;
    const name = componentName(folder, rest);
    let doc: Obj;
    try {
      doc = parser.parse(strFromU8(data)) as Obj;
    } catch {
      out.unreadable++;
      continue;
    }
    const rootName = Object.keys(doc)[0];
    if (!rootName) continue;
    const bodyRaw = doc[rootName];
    const body: Obj = isObj(bodyRaw) ? bodyRaw : {};
    out.components++;
    const ctx: Ctx = { name, src: sources.get(`${folder}/${name}`) };

    const specs = SPECS[rootName];
    if (specs) {
      for (const sp of specs) {
        const cols: Col[] = [{ header: sp.first, width: 26 }, ...sp.cols.map(([header, , kind, width]) => ({ header, kind, width }))];
        const items = sp.from ? arr(body[sp.from]).filter(isObj) : [body];
        for (const it of items) {
          if (sp.where && !sp.where(it)) continue;
          acc.add(sp.sheet, cols, [name, ...sp.cols.map(([, g]) => (typeof g === 'string' ? plain(it[g]) : g(it, ctx)))]);
        }
      }
      if (rootName === 'Flow') flowElements(name, body, acc);
      const rest2 = detailRows(name, body, coveredKeys(rootName), false);
      const skipDetails = rootName === 'Flow' || rootName.startsWith('Apex');
      if (!skipDetails) for (const r of rest2) acc.add(`${typeLabel.slice(0, 22)} Details`, DETAIL_COLS, r);
      continue;
    }

    // No hand-made layout: a short overview row plus the full listing of settings.
    const scalars = Object.values(body).filter((v) => isScalar(v) && v !== '').length;
    acc.add(
      typeLabel.slice(0, 31),
      [{ header: 'Name', width: 30 }, { header: 'Label', width: 28 }, { header: 'Description', width: 40 }, { header: 'Active / status' }, { header: 'API version' }, { header: 'Settings' }],
      [name, str(body.label ?? body.masterLabel ?? body.fullName ?? ''), str(body.description ?? ''), scalar(body.active ?? body.status ?? body.isActive ?? null), str(body.apiVersion ?? ''), scalars],
    );
    for (const r of detailRows(name, body, new Set(), true)) acc.add(`${typeLabel.slice(0, 22)} Details`, DETAIL_COLS, r);
  }
  return out;
}
