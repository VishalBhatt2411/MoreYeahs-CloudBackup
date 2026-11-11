import type { ObjectInfo } from '../salesforce/gateway.js';

export interface ExcludedObject {
  name: string;
  label: string;
  reason: string;
}

/**
 * Objects Salesforce will only return when you give a special filter (they are system / helper
 * objects, not your business data). Reading them without the filter fails, so we list them
 * as "excluded" with the reason instead of pretending to back them up.
 */
const NEEDS_FILTER = new Set([
  'AccountUserTerritory2View',
  'AppTabMember',
  'ColorDefinition',
  'ContentDocumentLink',
  'ContentFolderItem',
  'ContentFolderMember',
  'ContentHubItem',
  'DataType',
  'EntityDefinition',
  'EntityParticle',
  'FeedComment',
  'FeedLike',
  'FeedRevision',
  'FieldDefinition',
  'FlexQueueItem',
  'FolderedContentDocument',
  'IconDefinition',
  'IdeaComment',
  'ListViewChartInstance',
  'NetworkUserHistoryRecent',
  'OwnerChangeOptionInfo',
  'PicklistValueInfo',
  'PlatformAction',
  'RecentlyViewed',
  'RelationshipDomain',
  'RelationshipInfo',
  'SearchLayout',
  'SiteDetail',
  'UserAppMenuItem',
  'UserEntityAccess',
  'UserFieldAccess',
  'UserRecordAccess',
  'Vote',
]);

export function classifyObjects(all: ObjectInfo[]): { included: ObjectInfo[]; excluded: ExcludedObject[] } {
  const included: ObjectInfo[] = [];
  const excluded: ExcludedObject[] = [];
  for (const o of all) {
    const reason = exclusionReason(o);
    if (reason) excluded.push({ name: o.name, label: o.label, reason });
    else included.push(o);
  }
  included.sort((a, b) => a.name.localeCompare(b.name));
  excluded.sort((a, b) => a.name.localeCompare(b.name));
  return { included, excluded };
}

function exclusionReason(o: ObjectInfo): string | null {
  if (!o.queryable) return 'Salesforce does not allow this object to be read with a query.';
  if (o.deprecatedAndHidden) return 'Salesforce marks this object as deprecated and hidden.';
  if (o.name.endsWith('ChangeEvent')) return 'Change-event stream - it is a live feed, not stored records.';
  if (o.name.endsWith('__e')) return 'Platform event - it is a message stream, not stored records.';
  if (o.name.endsWith('__x')) return 'External object - the data lives in another system, not in Salesforce.';
  if (NEEDS_FILTER.has(o.name)) return 'System helper object - Salesforce only returns it when a special filter is used.';
  return null;
}

/** Field types we cannot copy as plain values. */
export const SKIPPED_FIELD_TYPES = new Set(['base64', 'address', 'location']);
