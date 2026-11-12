/**
 * Sorts everything a backup can hold into plain-language sections, so people who do not know
 * Salesforce can still find their way around: "Security & Access", "Apex Code", "Sales, Service
 * & Marketing records", and so on.
 *
 * The same sections drive three things: what you tick when you start a backup, how a finished
 * backup is grouped on screen, and the folders of the Excel / CSV download.
 */

export type CategoryKind = 'data' | 'metadata';

export interface Category {
  id: string;
  kind: CategoryKind;
  /** Position inside its kind (also used to number download folders). */
  order: number;
  label: string;
  description: string;
}

export const CATEGORIES: Category[] = [
  // ---- Records (the data stored in the org's objects) ----
  { id: 'data.business', kind: 'data', order: 1, label: 'Sales, Service & Marketing', description: 'Accounts, contacts, leads, opportunities, cases, campaigns, products, orders, contracts and similar business records.' },
  { id: 'data.custom', kind: 'data', order: 2, label: 'Custom objects', description: 'Objects your organization created itself (names ending in __c), plus custom metadata and settings records.' },
  { id: 'data.activity', kind: 'data', order: 3, label: 'Activities, Files & Collaboration', description: 'Tasks, events, emails, notes, attachments, files, Chatter groups and posts.' },
  { id: 'data.users', kind: 'data', order: 4, label: 'Users & Access records', description: 'Users, roles, groups, permission set assignments, territories and login history.' },
  { id: 'data.history', kind: 'data', order: 5, label: 'History, Sharing & Feeds', description: 'Field history, sharing rows, feed and tag records that belong to other objects.' },
  { id: 'data.system', kind: 'data', order: 6, label: 'Other standard & system objects', description: 'Everything else Salesforce keeps: setup records, jobs, logs and platform objects.' },

  // ---- Configuration (metadata: how the org is set up) ----
  { id: 'meta.schema', kind: 'metadata', order: 1, label: 'Objects & Fields', description: 'The data model: objects, fields, record types, picklists, validation rules, custom labels and custom metadata.' },
  { id: 'meta.security', kind: 'metadata', order: 2, label: 'Security & Access', description: 'Profiles, permission sets, roles, groups, queues, sharing rules, territories and single sign-on settings.' },
  { id: 'meta.apex', kind: 'metadata', order: 3, label: 'Apex Code & Pages', description: 'Apex classes and triggers, Visualforce pages and components, test suites.' },
  { id: 'meta.automation', kind: 'metadata', order: 4, label: 'Automation & Workflows', description: 'Flows, workflow rules, approval processes, assignment, escalation and auto-response rules.' },
  { id: 'meta.ui', kind: 'metadata', order: 5, label: 'Layouts, Apps & Lightning UI', description: 'Page layouts, Lightning pages and apps, tabs, quick actions, Lightning and Aura components, static resources, sites.' },
  { id: 'meta.reports', kind: 'metadata', order: 6, label: 'Reports & Dashboards', description: 'Reports, report types, dashboards and their folders.' },
  { id: 'meta.comms', kind: 'metadata', order: 7, label: 'Email, Documents & Notifications', description: 'Email templates, letterheads, documents and notification types.' },
  { id: 'meta.integration', kind: 'metadata', order: 8, label: 'Integrations & Connections', description: 'Connected apps, named credentials, external data sources, remote sites and platform events.' },
  { id: 'meta.settings', kind: 'metadata', order: 9, label: 'Org Settings', description: 'The switches and preferences found in Setup (company, security, features).' },
  { id: 'meta.other', kind: 'metadata', order: 10, label: 'Other configuration', description: 'Any configuration type that does not fit the sections above.' },
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));
export const categoryById = (id: string): Category | undefined => BY_ID.get(id);
export const isCategoryId = (id: string) => BY_ID.has(id);

// -------------------------------------------------------------------------------------------
// Records
// -------------------------------------------------------------------------------------------

const BUSINESS = new Set([
  'Account', 'AccountContactRelation', 'AccountContactRole', 'AccountTeamMember', 'Contact', 'ContactPointAddress', 'ContactPointEmail', 'ContactPointPhone',
  'Lead', 'Opportunity', 'OpportunityLineItem', 'OpportunityContactRole', 'OpportunityTeamMember', 'OpportunityCompetitor', 'OpportunitySplit', 'OpportunityStage',
  'Campaign', 'CampaignMember', 'CampaignMemberStatus', 'Case', 'CaseComment', 'CaseContactRole', 'CaseTeamMember', 'CaseSolution', 'Solution',
  'Contract', 'ContractLineItem', 'ContractContactRole', 'Order', 'OrderItem', 'Quote', 'QuoteLineItem', 'QuoteDocument',
  'Product2', 'ProductCategory', 'Pricebook2', 'PricebookEntry', 'Asset', 'AssetRelationship', 'Entitlement', 'ServiceContract', 'Individual', 'Partner',
  'WorkOrder', 'WorkOrderLineItem', 'ServiceAppointment', 'ServiceResource', 'ServiceTerritory', 'Location', 'Idea', 'Customer', 'Opportunity__c',
]);

const ACTIVITY = new Set([
  'Task', 'Event', 'EventRelation', 'TaskRelation', 'EventWhoRelation', 'TaskWhoRelation', 'EmailMessage', 'EmailMessageRelation', 'EmailTemplate', 'ListEmail',
  'Note', 'ContentNote', 'Attachment', 'ContentVersion', 'ContentDocument', 'ContentWorkspace', 'ContentFolder', 'ContentAsset', 'Document', 'DocumentAttachmentMap',
  'CollaborationGroup', 'CollaborationGroupMember', 'CollaborationInvitation', 'FeedItem', 'FeedComment', 'Topic', 'TopicAssignment', 'Announcement', 'CalendarView',
]);

const USERS = new Set([
  'User', 'UserRole', 'Group', 'GroupMember', 'Profile', 'PermissionSet', 'PermissionSetAssignment', 'PermissionSetGroup', 'PermissionSetGroupComponent',
  'PermissionSetLicense', 'PermissionSetLicenseAssign', 'ObjectPermissions', 'FieldPermissions', 'SetupEntityAccess', 'PermissionSetTabSetting', 'UserLicense',
  'UserPackageLicense', 'LoginHistory', 'LoginGeo', 'LoginIp', 'AuthSession', 'Territory2', 'Territory2Model', 'Territory2Type', 'UserTerritory2Association',
  'ObjectTerritory2Association', 'UserLogin', 'UserPreference', 'UserAppInfo', 'OauthToken', 'ConnectedApplication', 'CustomPermission', 'CustomPermissionDependency',
  'DelegatedApprover', 'TwoFactorInfo', 'TwoFactorMethodsInfo', 'Network', 'NetworkMember',
]);

/** Which section an object's records belong to. Works from the object's API name alone. */
export function categoryOfObject(name: string): string {
  if (/(History|Share|Feed|Tag|ChangeEvent)$/.test(name) && !BUSINESS.has(name) && !USERS.has(name)) return 'data.history';
  if (BUSINESS.has(name)) return 'data.business';
  if (USERS.has(name) || /^PermissionSet|^Territory2/.test(name)) return 'data.users';
  if (ACTIVITY.has(name)) return 'data.activity';
  if (name.endsWith('__kav') || name.endsWith('__ka')) return 'data.business';
  if (name.includes('__')) return 'data.custom';
  return 'data.system';
}

// -------------------------------------------------------------------------------------------
// Metadata
// -------------------------------------------------------------------------------------------

const META: Record<string, string[]> = {
  'meta.schema': [
    'CustomObject', 'CustomField', 'CustomObjectTranslation', 'GlobalValueSet', 'GlobalValueSetTranslation', 'StandardValueSet', 'StandardValueSetTranslation',
    'CustomMetadata', 'CustomLabels', 'CustomLabel', 'BusinessProcess', 'RecordType', 'CompactLayout', 'ListView', 'FieldSet', 'SharingReason', 'ValidationRule',
    'WebLink', 'CustomIndex', 'Index', 'SearchLayouts', 'NamespaceRegistry', 'ExternalObject', 'PicklistValue',
  ],
  'meta.security': [
    'Profile', 'PermissionSet', 'PermissionSetGroup', 'MutingPermissionSet', 'CustomPermission', 'Role', 'Group', 'Queue', 'DelegateGroup', 'LoginFlow',
    'LoginIpRange', 'SamlSsoConfig', 'Certificate', 'SecuritySettings', 'NetworkAccess', 'IpAddressRange', 'RestrictionRule', 'ScopingRule', 'UserCriteria',
    'ProfilePasswordPolicy', 'ProfileSessionSetting', 'AccessControlPolicy', 'SecurityCustomBaseline', 'EventRelayConfig',
  ],
  'meta.apex': ['ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent', 'ApexTestSuite', 'ApexEmailNotifications', 'CustomApplicationComponent', 'Scontrol'],
  'meta.automation': [
    'Flow', 'FlowDefinition', 'FlowCategory', 'FlowTest', 'Workflow', 'WorkflowRule', 'WorkflowAlert', 'WorkflowFieldUpdate', 'WorkflowTask', 'WorkflowOutboundMessage',
    'WorkflowSend', 'WorkflowKnowledgePublish', 'WorkflowFlowAction', 'AssignmentRules', 'AssignmentRule', 'AutoResponseRules', 'AutoResponseRule', 'EscalationRules',
    'EscalationRule', 'ApprovalProcess', 'MilestoneType', 'EntitlementProcess', 'EntitlementTemplate', 'ProcessDefinition', 'EventSubscription', 'EventDelivery',
    'ActionPlanTemplate', 'DecisionMatrixDefinition', 'ExpressionSetDefinition', 'AutomatedContactsSettings', 'ManagedContentType',
  ],
  'meta.ui': [
    'Layout', 'FlexiPage', 'CustomTab', 'CustomApplication', 'QuickAction', 'AppMenu', 'HomePageLayout', 'HomePageComponent', 'LightningComponentBundle',
    'AuraDefinitionBundle', 'StaticResource', 'ContentAsset', 'CustomPageWebLink', 'PathAssistant', 'Network', 'Community', 'CustomSite', 'SiteDotCom',
    'ExperienceBundle', 'DigitalExperienceBundle', 'DigitalExperience', 'DigitalExperienceConfig', 'NavigationMenu', 'Translations', 'EmbeddedServiceConfig',
    'LightningExperienceTheme', 'LightningMessageChannel', 'LightningBolt', 'ConsoleDefinition', 'ProfileActionOverride', 'RecordActionDeployment', 'Skill',
    'ActionLauncherItemDef', 'BrandingSet', 'CustomHelpMenuSection', 'FieldRestrictionRule', 'ForecastingDisplayedFamily', 'MobileApplicationDetail', 'UiObjectRelationConfig',
  ],
  'meta.reports': ['Report', 'ReportType', 'Dashboard', 'DashboardFolder', 'ReportFolder', 'AnalyticSnapshot', 'WaveApplication', 'WaveDataset', 'WaveDashboard', 'WaveLens', 'WaveRecipe', 'WaveTemplateBundle', 'WaveXmd'],
  'meta.comms': ['EmailTemplate', 'EmailFolder', 'EmailServicesFunction', 'EmailTemplateFolder', 'Letterhead', 'Document', 'DocumentFolder', 'CustomNotificationType', 'NotificationTypeConfig', 'ChatterExtension'],
  'meta.integration': [
    'ConnectedApp', 'NamedCredential', 'ExternalCredential', 'ExternalDataSource', 'ExternalServiceRegistration', 'RemoteSiteSetting', 'CorsWhitelistOrigin',
    'CspTrustedSite', 'PlatformEventChannel', 'PlatformEventChannelMember', 'OutboundNetworkConnection', 'AuthProvider', 'ExternalClientApplication', 'OauthCustomScope',
  ],
  'meta.settings': ['Settings', 'CompanyProfile', 'BusinessHoursSettings', 'Holiday', 'BusinessProcessSettings', 'DataCategoryGroup', 'Language', 'CurrencySettings', 'Territory'],
};

const META_INDEX = new Map<string, string>();
for (const [cat, types] of Object.entries(META)) for (const t of types) if (!META_INDEX.has(t)) META_INDEX.set(t, cat);

/** Which section a metadata type (for example "ApexClass") belongs to. Unknown types land in "Other configuration". */
export function categoryOfMetadataType(xmlName: string): string {
  const exact = META_INDEX.get(xmlName);
  if (exact) return exact;
  if (/Settings$/.test(xmlName)) return 'meta.settings';
  if (/^(Profile|PermissionSet|Sharing|Territory|Muting)/.test(xmlName)) return 'meta.security';
  if (/^(Workflow|Assignment|AutoResponse|Escalation|Approval|Flow|Entitlement)/.test(xmlName)) return 'meta.automation';
  if (/^(Report|Dashboard|Analytic|Wave)/.test(xmlName)) return 'meta.reports';
  if (/^(Email|Document|Letterhead|CustomNotification)/.test(xmlName)) return 'meta.comms';
  if (/^(Connected|NamedCredential|External|Remote|Cors|Csp|PlatformEvent|Outbound)/.test(xmlName)) return 'meta.integration';
  if (/^(Apex)/.test(xmlName)) return 'meta.apex';
  if (/(Layout|Tab|FlexiPage|Lightning|Aura|Experience|Navigation|Theme|QuickAction|Application)$/.test(xmlName)) return 'meta.ui';
  if (/^(Custom(Object|Field|Label|Metadata))/.test(xmlName)) return 'meta.schema';
  return 'meta.other';
}

/** Plain names for the metadata types people see most. Anything else is shown as its API name split into words. */
const META_LABELS: Record<string, string> = {
  ApexClass: 'Apex classes', ApexTrigger: 'Apex triggers', ApexPage: 'Visualforce pages', ApexComponent: 'Visualforce components', ApexTestSuite: 'Apex test suites',
  CustomObject: 'Objects (with fields, rules and layouts inside)', CustomField: 'Custom fields', CustomLabels: 'Custom labels', CustomMetadata: 'Custom metadata records',
  GlobalValueSet: 'Global picklists', StandardValueSet: 'Standard picklists', RecordType: 'Record types', ValidationRule: 'Validation rules', ListView: 'List views',
  Profile: 'Profiles', PermissionSet: 'Permission sets', PermissionSetGroup: 'Permission set groups', CustomPermission: 'Custom permissions', Role: 'Roles',
  Group: 'Public groups', Queue: 'Queues', SharingRules: 'Sharing rules', SharingSet: 'Sharing sets', Territory2: 'Territories', Territory2Model: 'Territory models',
  Flow: 'Flows', FlowDefinition: 'Flow activation settings', Workflow: 'Workflow rules (by object)', ApprovalProcess: 'Approval processes', AssignmentRules: 'Lead / case assignment rules',
  AutoResponseRules: 'Auto-response rules', EscalationRules: 'Case escalation rules', Layout: 'Page layouts', FlexiPage: 'Lightning pages', CustomTab: 'Custom tabs',
  CustomApplication: 'Apps', QuickAction: 'Quick actions', LightningComponentBundle: 'Lightning web components', AuraDefinitionBundle: 'Aura components',
  StaticResource: 'Static resources', HomePageLayout: 'Home page layouts', HomePageComponent: 'Home page components', Report: 'Reports', ReportType: 'Custom report types',
  Dashboard: 'Dashboards', ReportFolder: 'Report folders', DashboardFolder: 'Dashboard folders', EmailTemplate: 'Email templates', EmailFolder: 'Email template folders',
  Letterhead: 'Letterheads', Document: 'Documents', DocumentFolder: 'Document folders', ConnectedApp: 'Connected apps', NamedCredential: 'Named credentials',
  ExternalDataSource: 'External data sources', RemoteSiteSetting: 'Remote site settings', CorsWhitelistOrigin: 'CORS allowed origins', CspTrustedSite: 'CSP trusted sites',
  AuthProvider: 'Authentication providers', SamlSsoConfig: 'Single sign-on (SAML) settings', Settings: 'Org settings (all Setup preferences)', Translations: 'Translations',
  InstalledPackage: 'Installed packages', Network: 'Experience Cloud networks', CustomSite: 'Sites', ExperienceBundle: 'Experience Cloud sites',
  PlatformEventChannel: 'Platform event channels', CustomNotificationType: 'Custom notification types', PathAssistant: 'Path (guidance) definitions',
  Territory: 'Territories (legacy)', DataCategoryGroup: 'Data category groups', ProcessDefinition: 'Process definitions',
};

const splitWords = (s: string) =>
  s
    .replace(/__c$|__mdt$|__e$|__x$|__kav$/, '')
    .replace(/_+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();

export function metadataTypeLabel(xmlName: string): string {
  return META_LABELS[xmlName] ?? splitWords(xmlName);
}

/** A readable column heading for a field that has no label on file (older backups): "LastModifiedDate" becomes "Last Modified Date". */
export function humanizeApiName(apiName: string): string {
  return splitWords(apiName) || apiName;
}

// -------------------------------------------------------------------------------------------
// What a backup run was asked to cover
// -------------------------------------------------------------------------------------------

export interface Selection {
  /** Copy record data. Default true. */
  includeRecords?: boolean;
  /** Copy configuration (metadata). Default true. */
  includeMetadata?: boolean;
  /** Section ids (see CATEGORIES). Every item in a chosen section is included, including ones created later. */
  categories?: string[];
  /** Individual objects by API name. */
  objects?: string[];
  /** Individual metadata types by API name. */
  metadataTypes?: string[];
}

export interface PlanFilter {
  records: boolean;
  metadata: boolean;
  /** null = no filter, take everything of that kind. */
  wantsObject: ((name: string) => boolean) | null;
  wantsMetadataType: ((xmlName: string) => boolean) | null;
}

/**
 * Turns a selection into yes/no questions the backup plan can ask about each object and type.
 *
 * A side (records or configuration) is filtered only when the selection names something for it,
 * either individual items or a section of that side. Otherwise it takes everything. To skip a side
 * completely, set includeRecords / includeMetadata to false.
 */
export function planFilter(sel: Selection): PlanFilter {
  const cats = new Set((sel.categories ?? []).filter(isCategoryId));
  const dataCats = new Set([...cats].filter((c) => c.startsWith('data.')));
  const metaCats = new Set([...cats].filter((c) => c.startsWith('meta.')));
  const objs = new Set(sel.objects ?? []);
  const types = new Set(sel.metadataTypes ?? []);
  return {
    records: sel.includeRecords !== false,
    metadata: sel.includeMetadata !== false,
    wantsObject: objs.size || dataCats.size ? (n) => objs.has(n) || dataCats.has(categoryOfObject(n)) : null,
    wantsMetadataType: types.size || metaCats.size ? (t) => types.has(t) || metaCats.has(categoryOfMetadataType(t)) : null,
  };
}

/** The section an item of a backup belongs to. */
export function categoryOfItem(kind: 'OBJECT' | 'METADATA', name: string): string {
  return kind === 'OBJECT' ? categoryOfObject(name) : categoryOfMetadataType(name);
}
