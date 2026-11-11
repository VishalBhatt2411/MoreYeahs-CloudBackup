import { Connection } from 'jsforce';
import type { OrgConnection } from '@prisma/client';
import { config } from '../config.js';
import { refreshOrgLogin, requireAppCredentials } from './oauth.js';
import { latestApiVersion } from './rest.js';

export interface ObjectInfo {
  name: string;
  label: string;
  custom: boolean;
  queryable: boolean;
  deprecatedAndHidden: boolean;
}

export interface FieldInfo {
  name: string;
  type: string;
  compoundFieldName?: string | null;
}

export interface QueryOptions {
  /** Also return rows that were deleted (in the recycle bin) or merged away. Used to find deletions. */
  includeDeleted?: boolean;
}

export interface BulkQueryOptions extends QueryOptions {
  /** Field name -> Salesforce field type. Bulk returns text; this turns numbers and booleans back into real values. */
  fieldTypes?: Record<string, string>;
  /** What the object's row count was just before the query (becomes each page's totalSize). */
  expectedRows?: number;
}

export interface MetadataTypeInfo {
  xmlName: string;
  inFolder: boolean;
}

export interface MetadataMember {
  type: string;
  fullName: string;
  manageableState?: string | null;
}

export interface RetrievedMetadata {
  zip: Buffer;
  /** "Type/FullName" of every component that came back in the zip. */
  found: string[];
  warnings: string[];
}

export interface QueryPage {
  records: Record<string, unknown>[];
  totalSize: number;
}

/** Everything the backup engine needs from Salesforce. Real and fake versions share this shape. */
export interface SfGateway {
  readonly apiVersion: string;
  describeGlobal(): Promise<ObjectInfo[]>;
  describeFields(objectName: string): Promise<FieldInfo[]>;
  /** How many rows the object has right now (a cheap COUNT query). */
  countRows(objectName: string): Promise<number>;
  queryPages(soql: string, opts?: QueryOptions): AsyncGenerator<QueryPage>;
  /** Same rows as queryPages, fetched as a Bulk API 2.0 job. For very large objects. */
  bulkQueryPages(soql: string, opts?: BulkQueryOptions): AsyncGenerator<QueryPage>;
  describeMetadataTypes(): Promise<MetadataTypeInfo[]>;
  listMetadata(type: string, inFolder: boolean): Promise<MetadataMember[]>;
  /** `types` maps a metadata type name to the member names to fetch. */
  retrieveMetadata(types: Record<string, string[]>): Promise<RetrievedMetadata>;
}

export type GatewayFactory = (connection: OrgConnection) => Promise<SfGateway>;

const NUMBER_TYPES = new Set(['int', 'double', 'currency', 'percent', 'long']);

/** Bulk results are all text. Give numbers and booleans their real type and turn empty text into null. */
export function coerceBulkRow(raw: Record<string, unknown>, types: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'attributes') continue;
    if (v === '' || v === undefined || v === null) {
      out[k] = null;
      continue;
    }
    const t = types[k];
    if (t === 'boolean') out[k] = v === 'true' || v === true;
    else if (NUMBER_TYPES.has(t ?? '') && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

class JsforceGateway implements SfGateway {
  constructor(
    private conn: Connection,
    public readonly apiVersion: string,
  ) {
    conn.metadata.pollInterval = 2000;
    conn.metadata.pollTimeout = 20 * 60 * 1000;
  }

  async describeGlobal(): Promise<ObjectInfo[]> {
    const r = await this.conn.describeGlobal();
    return r.sobjects.map((s) => ({
      name: s.name,
      label: s.label,
      custom: s.custom,
      queryable: s.queryable,
      deprecatedAndHidden: s.deprecatedAndHidden,
    }));
  }

  async describeFields(objectName: string): Promise<FieldInfo[]> {
    const d = await this.conn.sobject(objectName).describe();
    return d.fields.map((f) => ({ name: f.name, type: f.type, compoundFieldName: f.compoundFieldName }));
  }

  async countRows(objectName: string): Promise<number> {
    const r = await this.conn.query(`SELECT COUNT() FROM ${objectName}`);
    return r.totalSize;
  }

  async *queryPages(soql: string, opts: QueryOptions = {}): AsyncGenerator<QueryPage> {
    let r = await this.conn.query(soql, opts.includeDeleted ? { scanAll: true } : {});
    yield { records: r.records as Record<string, unknown>[], totalSize: r.totalSize };
    while (!r.done && r.nextRecordsUrl) {
      r = await this.conn.queryMore(r.nextRecordsUrl);
      yield { records: r.records as Record<string, unknown>[], totalSize: r.totalSize };
    }
  }

  async *bulkQueryPages(soql: string, opts: BulkQueryOptions = {}): AsyncGenerator<QueryPage> {
    const stream = await this.conn.bulk2.query(soql, {
      scanAll: !!opts.includeDeleted,
      pollInterval: 5000,
      pollTimeout: 60 * 60 * 1000,
    });
    const total = opts.expectedRows ?? 0;
    let batch: Record<string, unknown>[] = [];
    for await (const raw of stream as AsyncIterable<Record<string, unknown>>) {
      batch.push(coerceBulkRow(raw, opts.fieldTypes ?? {}));
      if (batch.length >= 2000) {
        yield { records: batch, totalSize: total };
        batch = [];
      }
    }
    if (batch.length > 0 || total === 0) yield { records: batch, totalSize: total };
  }

  async describeMetadataTypes(): Promise<MetadataTypeInfo[]> {
    const r = await this.conn.metadata.describe(this.apiVersion);
    return r.metadataObjects.map((m) => ({ xmlName: m.xmlName, inFolder: !!m.inFolder }));
  }

  async listMetadata(type: string, inFolder: boolean): Promise<MetadataMember[]> {
    const toMembers = (rows: Array<{ type: string; fullName: string; manageableState?: string | null }> | undefined) =>
      (rows ?? []).map((p) => ({ type: p.type, fullName: p.fullName, manageableState: p.manageableState }));
    const asArray = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

    if (!inFolder) {
      return toMembers(asArray(await this.conn.metadata.list({ type }, this.apiVersion)));
    }
    // Reports, dashboards, documents and email templates live inside folders.
    const folderType = type === 'EmailTemplate' ? 'EmailFolder' : `${type}Folder`;
    const folders = asArray(await this.conn.metadata.list({ type: folderType }, this.apiVersion));
    const out: MetadataMember[] = [];
    for (const f of folders) {
      out.push({ type: folderType, fullName: f.fullName, manageableState: f.manageableState });
      const inside = asArray(await this.conn.metadata.list({ type, folder: f.fullName }, this.apiVersion));
      out.push(...toMembers(inside));
    }
    return out;
  }

  async retrieveMetadata(types: Record<string, string[]>): Promise<RetrievedMetadata> {
    const result = await this.conn.metadata
      .retrieve({
        apiVersion: Number(this.apiVersion),
        singlePackage: true,
        unpackaged: {
          version: this.apiVersion,
          types: Object.entries(types).map(([name, members]) => ({ name, members })),
        } as never,
      })
      .complete();
    const props = Array.isArray(result.fileProperties) ? result.fileProperties : result.fileProperties ? [result.fileProperties] : [];
    const messages = Array.isArray(result.messages) ? result.messages : result.messages ? [result.messages] : [];
    return {
      zip: Buffer.from(result.zipFile ?? '', 'base64'),
      found: props.map((p) => `${p.type}/${p.fullName}`),
      warnings: messages.map((m) => `${m.fileName}: ${m.problem}`),
    };
  }
}

/** Builds a live Salesforce connection from a stored org connection (refreshes the login automatically). */
export const realGatewayFactory: GatewayFactory = async (connection) => {
  const creds = await requireAppCredentials();
  const conn = new Connection({
    instanceUrl: connection.instanceUrl,
    oauth2: {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      loginUrl: connection.loginUrl,
      redirectUri: config.oauthCallbackUrl,
    },
    // If the access token runs out during a long backup, renew it our way (keeps the rotated refresh token).
    refreshFn: (_c, callback) => {
      refreshOrgLogin(connection, creds).then(
        (f) => callback(null, f.accessToken),
        (e) => callback(e as Error),
      );
    },
  });
  // No access token yet: ask Salesforce for one using the stored refresh token.
  // (Saves the newest refresh token too, because Salesforce may rotate it every time.)
  const fresh = await refreshOrgLogin(connection, creds);
  conn.accessToken = fresh.accessToken;
  if (fresh.instanceUrl) conn.instanceUrl = fresh.instanceUrl;
  const apiVersion = await latestApiVersion(conn.instanceUrl);
  conn.version = apiVersion;
  return new JsforceGateway(conn, apiVersion);
};

let factory: GatewayFactory = realGatewayFactory;
export const getGateway: GatewayFactory = (c) => factory(c);
/** Tests plug in a fake Salesforce here. */
export function setGatewayFactory(f: GatewayFactory | null) {
  factory = f ?? realGatewayFactory;
}
