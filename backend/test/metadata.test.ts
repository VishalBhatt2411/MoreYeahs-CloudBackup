import { describe, expect, it } from 'vitest';
import { exportMetadataType, unretrievableReason, wasRetrieved } from '../src/backup/exporters.js';
import { classifyObjects } from '../src/backup/coverage.js';
import type { SfGateway } from '../src/salesforce/gateway.js';

describe('matching what Salesforce returns to what we asked for', () => {
  it('finds Settings under their <Name>Settings/<Name> key', () => {
    const got = new Set(['AccountSettings/Account', 'SecuritySettings/Security']);
    expect(wasRetrieved({ type: 'Settings', fullName: 'Account' }, got, 'Settings')).toBe(true);
    expect(wasRetrieved({ type: 'Settings', fullName: 'Mobile' }, got, 'Settings')).toBe(false);
  });

  it('finds a bundle by any of its files', () => {
    const got = new Set(['LightningComponentBundle/myCmp/myCmp.js', 'LightningComponentBundle/myCmp/myCmp.html']);
    expect(wasRetrieved({ type: 'LightningComponentBundle', fullName: 'myCmp' }, got, 'LightningComponentBundle')).toBe(true);
    expect(wasRetrieved({ type: 'LightningComponentBundle', fullName: 'other' }, got, 'LightningComponentBundle')).toBe(false);
    // a bundle whose name only starts the same must not match
    expect(wasRetrieved({ type: 'LightningComponentBundle', fullName: 'myC' }, got, 'LightningComponentBundle')).toBe(false);
  });

  it('finds a folder under the base type', () => {
    expect(wasRetrieved({ type: 'ReportFolder', fullName: 'Sales' }, new Set(['Report/Sales']), 'Report')).toBe(true);
    expect(wasRetrieved({ type: 'ReportFolder', fullName: 'Sales' }, new Set(), 'Report')).toBe(false);
  });

  it('only excuses components for a stated, known reason', () => {
    expect(unretrievableReason({ type: 'InstalledPackage', fullName: 'thsecurity' }, [])).toMatch(/installed package/);
    expect(unretrievableReason({ type: 'EmailFolder', fullName: 'unfiled$public' }, [])).toMatch(/built-in/);
    expect(unretrievableReason({ type: 'Layout', fullName: 'thsecurity__AppLog__c-AppLog Layout' }, [])).toMatch(/installed package/);
    expect(unretrievableReason({ type: 'CustomObject', fullName: 'ConversationEntryCopy' }, ['package.xml: Not a registered filter type: ConversationEntryCopy (see FilterType.java)'])).toMatch(/not a retrievable/);
    // an ordinary component that goes missing is NOT excused
    expect(unretrievableReason({ type: 'ApexClass', fullName: 'Foo' }, [])).toBeNull();
    expect(unretrievableReason({ type: 'Layout', fullName: 'Account-Account Layout' }, [])).toBeNull();
  });
});

function metadataGateway(over: Partial<SfGateway>): SfGateway {
  return {
    apiVersion: '62.0',
    describeGlobal: async () => [],
    describeFields: async () => [],
    countRows: async () => 0,
    queryPages: async function* () {},
    bulkQueryPages: async function* () {},
    describeMetadataTypes: async () => [],
    listMetadata: async () => [],
    retrieveMetadata: async () => ({ zip: Buffer.from('zip'), found: [], warnings: [] }),
    ...over,
  };
}

describe('copying metadata types', () => {
  it('copies Settings fully when Salesforce uses its own key names', async () => {
    const gw = metadataGateway({
      listMetadata: async (type) => ['Account', 'Security'].map((n) => ({ type, fullName: n, manageableState: null })),
      retrieveMetadata: async (types) => {
        expect(types).toEqual({ Settings: ['Account', 'Security'] });
        return { zip: Buffer.from('zip'), found: ['AccountSettings/Account', 'SecuritySettings/Security'], warnings: [] };
      },
    });
    const r = await exportMetadataType(gw, 'Settings', false, 'test-meta/settings');
    expect(r.status).toBe('SUCCEEDED');
    expect(r.rowCount).toBe(2);
    expect(r.expectedCount).toBe(2);
  });

  it('asks for folders as members of the base type and checks them', async () => {
    let asked: Record<string, string[]> = {};
    const gw = metadataGateway({
      listMetadata: async () => [
        { type: 'ReportFolder', fullName: 'Sales', manageableState: null },
        { type: 'Report', fullName: 'Sales/Pipeline', manageableState: 'unmanaged' },
      ],
      retrieveMetadata: async (types) => {
        asked = types;
        return { zip: Buffer.from('zip'), found: ['Report/Sales', 'Report/Sales/Pipeline'], warnings: [] };
      },
    });
    const r = await exportMetadataType(gw, 'Report', true, 'test-meta/report');
    expect(asked).toEqual({ Report: ['Sales', 'Sales/Pipeline'] });
    expect(r.status).toBe('SUCCEEDED');
  });

  it('records known-unretrievable components with a reason and stays honest about the rest', async () => {
    const gw = metadataGateway({
      listMetadata: async (type) => ['thsecurity', 'Real'].map((n) => ({ type, fullName: n, manageableState: null })),
      retrieveMetadata: async () => ({ zip: Buffer.from('zip'), found: ['InstalledPackage/Real'], warnings: [] }),
    });
    const r = await exportMetadataType(gw, 'InstalledPackage', false, 'test-meta/pkg');
    expect(r.status).toBe('SUCCEEDED');
    expect(r.expectedCount).toBe(1);
    expect(r.note).toMatch(/thsecurity/);

    const gw2 = metadataGateway({
      listMetadata: async (type) => ['A', 'B'].map((n) => ({ type, fullName: n, manageableState: 'unmanaged' })),
      retrieveMetadata: async () => ({ zip: Buffer.from('zip'), found: ['ApexClass/A'], warnings: [] }),
    });
    const bad = await exportMetadataType(gw2, 'ApexClass', false, 'test-meta/apex');
    expect(bad.status).toBe('PARTIAL');
    expect(bad.error).toMatch(/1 of 2/);
  });

  it('treats a type Salesforce refuses to list as not copyable, with a note', async () => {
    const gw = metadataGateway({
      listMetadata: async () => {
        throw new Error("INVALID_FIELD: SELECT ... ManageableState ... No such column 'ManageableState'");
      },
    });
    const r = await exportMetadataType(gw, 'ContentWorkspace', false, 'test-meta/cw');
    expect(r.status).toBe('SUCCEEDED');
    expect(r.expectedCount).toBe(0);
    expect(r.note).toMatch(/cannot list/);
    // any other listing failure is still a failure
    const gw2 = metadataGateway({ listMetadata: async () => { throw new Error('REQUEST_LIMIT_EXCEEDED'); } });
    await expect(exportMetadataType(gw2, 'ApexClass', false, 'test-meta/x')).rejects.toThrow(/REQUEST_LIMIT/);
  });
});

describe('objects that cannot be read are listed as excluded, not failed', () => {
  it('excludes helper, outgoing-email and Data Cloud objects with a reason', () => {
    const o = (name: string) => ({ name, label: name, custom: false, queryable: true, deprecatedAndHidden: false });
    const { included, excluded } = classifyObjects([
      o('Account'), o('OutgoingEmail'), o('DatacloudCompany'), o('ExternalEncryptionRootKey'), o('FlowVersionView'), o('UserSharedFeature'),
    ]);
    expect(included.map((i) => i.name)).toEqual(['Account']);
    expect(excluded.map((e) => e.name).sort()).toEqual(['DatacloudCompany', 'ExternalEncryptionRootKey', 'FlowVersionView', 'OutgoingEmail', 'UserSharedFeature']);
    expect(excluded.every((e) => e.reason.length > 10)).toBe(true);
  });
});
