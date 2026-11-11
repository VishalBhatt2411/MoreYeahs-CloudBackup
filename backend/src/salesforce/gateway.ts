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
  queryPages(soql: string): AsyncGenerator<QueryPage>;
  describeMetadataTypes(): Promise<MetadataTypeInfo[]>;
  listMetadata(type: string, inFolder: boolean): Promise<MetadataMember[]>;
  /** `types` maps a metadata type name to the member names to fetch. */
  retrieveMetadata(types: Record<string, string[]>): Promise<RetrievedMetadata>;
}

export type GatewayFactory = (connection: OrgConnection) => Promise<SfGateway>;

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

  async *queryPages(soql: string): AsyncGenerator<QueryPage> {
    let r = await this.conn.query(soql);
    yield { records: r.records as Record<string, unknown>[], totalSize: r.totalSize };
    while (!r.done && r.nextRecordsUrl) {
      r = await this.conn.queryMore(r.nextRecordsUrl);
      yield { records: r.records as Record<string, unknown>[], totalSize: r.totalSize };
    }
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
