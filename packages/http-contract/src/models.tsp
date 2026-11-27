import "@typespec/http";
import "@typespec/openapi";
import "@typespec/openapi3";

using TypeSpec.Http;
using TypeSpec.OpenAPI;

namespace Codexia.Http;

alias JsonObject = Record<unknown>;
alias OwnerSessionCookie = ApiKeyAuth<ApiKeyLocation.cookie, "__Secure-better-auth.session_token">;

// Native persistence uses PostgreSQL UUID identities. Portable archives
// require the lowercase canonical representation emitted by the exporter.
@format("uuid")
scalar PersistenceId extends string;
@pattern("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
scalar ArchiveId extends string;
@minValue(1)
scalar PositiveVersion extends int32;
@minValue(0) @maxValue(1)
scalar UnitConfidence extends float64;
@minLength(1) @maxLength(200) @pattern(".*\\S.*")
scalar PersistenceIdempotencyKey extends string;
@minLength(1) @maxLength(128) @pattern(".*\\S.*")
scalar PersistenceClientId extends string;

model ApiError {
  error: string;
  code: string;
  details?: JsonObject | null;
  ...Record<never>;
}

model Project {
  id: string;
  title: string;
  settings: JsonObject;
  version: int32;
  createdAt: utcDateTime;
  updatedAt: utcDateTime;
  ...Record<never>;
}

model ProjectPageResponse {
  projects: Project[];
  nextCursor: string | null;
  ...Record<never>;
}

model PersistenceStatusResponse {
  available: boolean;
  provider: "postgres" | null;
  ...Record<never>;
}

model PublicShareScope {
  kind: "project" | "volume" | "chapter" | "scene";
  id: string;
  ...Record<never>;
}

model PublicShareSnapshot {
  projectId: string;
  projectVersion: int32;
  ...Record<never>;
}

model PublicShareSceneSummary {
  id: string;
  title: string;
  ...Record<never>;
}

model PublicShareTreeChapter {
  chapter: PublicShareSceneSummary;
  scenes: PublicShareSceneSummary[];
  ...Record<never>;
}

model PublicShareTreeVolume {
  volume: PublicShareSceneSummary;
  chapters: PublicShareTreeChapter[];
  ...Record<never>;
}

model PublicShareIndexBody {
  snapshot: PublicShareSnapshot;
  label: string;
  scope: PublicShareScope;
  expiresAt: utcDateTime;
  sceneCount: int32;
  rootScenes: PublicShareSceneSummary[];
  tree: PublicShareTreeVolume[];
  ...Record<never>;
}

model PublicShareSceneBody {
  snapshot: PublicShareSnapshot;
  id: string;
  title: string;
  body: string;
  ...Record<never>;
}

model PublicShareIndexResponse {
  @header("Cache-Control") cacheControl: "no-store";
  @header("X-Robots-Tag") robotsTag: "noindex, nofollow";
  @header("Referrer-Policy") referrerPolicy: "no-referrer";
  @header("X-Content-Type-Options") contentTypeOptions: "nosniff";
  @body body: PublicShareIndexBody;
}

model PublicShareSceneResponse {
  @header("Cache-Control") cacheControl: "no-store";
  @header("X-Robots-Tag") robotsTag: "noindex, nofollow";
  @header("Referrer-Policy") referrerPolicy: "no-referrer";
  @header("X-Content-Type-Options") contentTypeOptions: "nosniff";
  @body body: PublicShareSceneBody;
}

model OwnerSessionRequest {
  ...Record<never>;
}

model OwnerSessionResponse {
  @header("Cache-Control") cacheControl: "no-store";
  @body body: OwnerSessionBody;
}

model OwnerSessionBody {
  authenticated: true;
  ...Record<never>;
}

model AuthMethodsBody {
  passkey: true;
  upstreamOidc: boolean;
  ...Record<never>;
}

model AuthMethodsResponse {
  @header contentType: "application/json";
  @body body: AuthMethodsBody;
}

// Response details are optional/open where compatibility requires the previous
// unconstrained JSON object schema. These DTOs record observed wire members.
model OAuthConsentContextBody {
  client?: { name?: string; ...Record<unknown>; };
  requestedScopes?: string[];
  redirectUri?: string;
  ...Record<unknown>;
}

model ApiSessionBody {
  authenticated: true;
  authorScope: string;
  ...Record<unknown>;
}

model PublicJobBody {
  id: string;
  type: string;
  status: "queued" | "running" | "done" | "error";
  progress: float64 | null;
  result: unknown;
  error: string | null;
  errorCode?: string;
  retryable?: boolean;
  createdAt: utcDateTime;
  updatedAt: utcDateTime;
  finishedAt: utcDateTime | null;
  ...Record<unknown>;
}

@minValue(0.0) @maxValue(1.0)
scalar JobProgress extends float64;

model InboxItemBody {
  id: string;
  kind: "job-complete";
  jobId: string;
  jobType: string;
  title: string;
  body: string;
  status: "done" | "error";
  read: boolean;
  userId: string | null;
  projectKey: string;
  createdAt: utcDateTime;
  ...Record<unknown>;
}

model InboxListBody {
  items: InboxItemBody[];
  unreadCount: int32;
  ...Record<unknown>;
}

model InboxReadAllBody {
  marked: int32;
  ...Record<unknown>;
}

model InboxReadItemBody {
  item: InboxItemBody;
  ...Record<unknown>;
}

model RecentActivityItemBody {
  sceneId: string;
  sentenceOffset: int32 | null;
  pageIndex?: int32 | null;
  deviceType: "desktop" | "mobile";
  updatedAt: utcDateTime;
  ...Record<unknown>;
}

model RecentActivityBody {
  items: RecentActivityItemBody[];
  ...Record<unknown>;
}

// Desktop Web wire row schemas are emitted as components for the generated
// client; the published operations retain their approved legacy envelopes.
model DesktopModuleResponseItem {
  id: "story" | "diagnostics" | "nlp" | "semantic" | "speaker" | "assistant" | "publishing" | "mcp" | "search";
  availability: "not-included" | "disabled" | "enabled-idle" | "active";
  version?: string;
  activeJobs: int32;
  ...Record<unknown>;
}

model DesktopContributionResponseItem {
  contractVersion?: 1;
  kind?: "panel" | "editor-adornment" | "context-action";
  contexts?: ("workspace" | "editor" | "reading")[];
  multipleInstances?: boolean;
  id: string;
  module: "story" | "diagnostics" | "nlp" | "semantic" | "speaker" | "assistant" | "publishing" | "mcp" | "search";
  slot: "editor" | "dock" | "inspection" | "review" | "settings";
  title: string;
  action: string;
  ...Record<unknown>;
}

model DesktopPublicJobBody {
  ...OmitProperties<PublicJobBody, "progress">;
  progress: JobProgress | null;
}

model DesktopJobList is Array<DesktopPublicJobBody>;
model DesktopModuleList is Array<DesktopModuleResponseItem>;
model DesktopContributionList is Array<DesktopContributionResponseItem>;

model ProjectObservationBody {
  snapshot?: { projectId?: string; projectVersion?: int32; ...Record<unknown>; };
  observedAt?: utcDateTime;
  state?: "fresh" | "failed" | "unknown";
  ...Record<unknown>;
}

model ProjectReadBody {
  project?: Project;
  observation?: ProjectObservationBody;
  ...Record<unknown>;
}

model ProjectTreeSceneBody {
  id?: string;
  title?: string;
  ...Record<unknown>;
}

model ProjectTreeChapterBody {
  id?: string;
  title?: string;
  scenes?: ProjectTreeSceneBody[];
  ...Record<unknown>;
}

model ProjectTreeVolumeBody {
  id?: string;
  title?: string;
  chapters?: ProjectTreeChapterBody[];
  ...Record<unknown>;
}

model ProjectTreeBody {
  title?: string;
  volumes?: ProjectTreeVolumeBody[];
  ...Record<unknown>;
}

model ProjectTreeResponse {
  snapshot?: JsonObject;
  tree?: ProjectTreeBody;
  ...Record<unknown>;
}

model ProjectSceneBody {
  id?: string;
  title?: string;
  text?: string;
  revision?: string;
  ...Record<unknown>;
}

model ProjectSceneResponse {
  snapshot?: JsonObject;
  scene?: ProjectSceneBody;
  document?: { path?: string; content?: string; revision?: string; ...Record<unknown>; };
  metadata?: { path?: string; content?: string; revision?: string; ...Record<unknown>; };
  ...Record<unknown>;
}

model ProjectSnapshotResponse {
  snapshot: SnapshotIdBody;
  document: { path: string; @pattern("^[0-9a-f]{64}$") revision: string; ...Record<unknown>; } | null;
  ...Record<unknown>;
}

model ProjectStatusBody {
  projectId?: string;
  projectVersion?: int32;
  state?: "durable";
  ...Record<unknown>;
}

model KnowledgeNodeBody {
  id?: string; projectId?: string; type?: string; name?: string; attributes?: JsonObject;
  status?: "proposed" | "confirmed" | "retired"; version?: int32;
  deletedAt?: utcDateTime | null; createdAt?: utcDateTime; updatedAt?: utcDateTime;
  ...Record<unknown>;
}

model KnowledgeAliasBody {
  id?: string; projectId?: string; nodeId?: string; surface?: string; normalized?: string;
  scope?: string | null; status?: "proposed" | "confirmed" | "ambiguous" | "retired";
  createdAt?: utcDateTime; updatedAt?: utcDateTime;
  ...Record<unknown>;
}

model KnowledgeRelationBody {
  id?: string; projectId?: string; sourceId?: string; targetId?: string; type?: string;
  attributes?: JsonObject; validity?: JsonObject;
  status?: "proposed" | "confirmed" | "rejected" | "retired"; version?: int32;
  createdAt?: utcDateTime; updatedAt?: utcDateTime;
  ...Record<unknown>;
}

model PersistenceNodeListBody {
  nodes?: KnowledgeNodeBody[];
  nextCursor?: string | null;
  projectVersion?: int32;
  ...Record<unknown>;
}

// The public route serves both its legacy unfiltered node list and its newer
// versioned browse page. Desktop only calls the browse form and validates the
// stricter shape through the generated response projection.
model DesktopPersistenceNodeListBody {
  nodes: KnowledgeNodeBody[];
  nextCursor: string | null;
  projectVersion: int32;
  ...Record<unknown>;
}

model PersistenceNodeBody {
  node?: KnowledgeNodeBody;
  aliases?: KnowledgeAliasBody[];
  relations?: KnowledgeRelationBody[];
  ...Record<unknown>;
}

model EvidenceAnchorBody {
  id?: string; projectId?: string; documentId?: string; revisionId?: string;
  fromUtf16?: int32; toUtf16?: int32; quoteSha256?: string;
  status?: "proposed" | "confirmed" | "needs_review" | "orphaned"; version?: int32;
  createdAt?: utcDateTime; updatedAt?: utcDateTime;
  ...Record<unknown>;
}

model EvidenceQuoteSourceBody {
  revisionId?: string; fromUtf16?: int32; toUtf16?: int32; quoteSha256?: string;
  status?: "proposed" | "confirmed" | "needs_review" | "orphaned"; historical?: boolean;
  ...Record<unknown>;
}

model EvidenceMentionBody {
  link?: PersistenceMentionLink;
  node?: KnowledgeNodeBody | null;
  ...Record<unknown>;
}

model EvidenceAssertionLinkBody {
  link?: JsonObject;
  assertion?: JsonObject | null;
  ...Record<unknown>;
}

model EvidenceAnchorDetailBody {
  anchor?: EvidenceAnchorBody;
  quote?: string;
  quoteSource?: EvidenceQuoteSourceBody | null;
  mentions?: EvidenceMentionBody[];
  assertions?: EvidenceAssertionLinkBody[];
  history?: JsonObject[];
  ...Record<unknown>;
}

model DocumentEvidenceListBody {
  revisionId?: string | null;
  anchors?: EvidenceAnchorDetailBody[];
  ...Record<unknown>;
}

model NodeEvidenceListBody {
  evidence?: EvidenceAnchorDetailBody[];
  ...Record<unknown>;
}

model PersistenceAssertionBody {
  id?: string; projectId?: string; proposition?: JsonObject; modality?: string; perspective?: string;
  narrativeTime?: JsonObject; confidence?: float64 | null;
  status?: "proposed" | "confirmed" | "rejected" | "retired"; version?: int32;
  createdAt?: utcDateTime; updatedAt?: utcDateTime;
  ...Record<unknown>;
}

model AssertionResponseBody {
  assertion?: PersistenceAssertionBody;
  evidence?: JsonObject[];
  ...Record<unknown>;
}

model AssertionEvidenceListBody {
  evidence?: JsonObject[];
  ...Record<unknown>;
}

model PersistenceChangeSetBody {
  id?: string; projectId?: string; authorId?: string;
  status?: "proposed" | "approved" | "applied" | "rejected";
  operations?: JsonObject[]; readSet?: JsonObject[]; writeSet?: JsonObject[]; provenance?: JsonObject;
  version?: int32; idempotencyKey?: string; createdAt?: utcDateTime;
  approvedAt?: utcDateTime | null; approvedBy?: string | null; appliedAt?: utcDateTime | null;
  rejectedAt?: utcDateTime | null; rejectedBy?: string | null;
  ...Record<unknown>;
}

model PersistenceChangeSetDesktopReadEntry {
  resource: "document" | "module_record" | "knowledge_node" | "knowledge_alias" | "knowledge_relation" | "evidence_anchor" | "mention_link" | "assertion" | "assertion_evidence";
  id: string;
  expectedVersion: int32 | null;
  expectedRevisionId?: string | null;
}

model PersistenceChangeSetDesktopWriteEntry {
  resource: "document" | "module_record" | "knowledge_node" | "knowledge_alias" | "knowledge_relation" | "evidence_anchor" | "mention_link" | "assertion" | "assertion_evidence";
  id: string;
}

model PersistenceChangeSetDesktopProvenance {
  source: string;
  actorId: string | null;
  details: JsonObject;
}

model PersistenceChangeSetDesktopHierarchyParent {
  documentId: string;
  lookupId: string;
}

model PersistenceChangeSetDesktopHierarchy {
  kind: "volume" | "chapter" | "scene";
  logicalId: string;
  volume?: PersistenceChangeSetDesktopHierarchyParent;
  chapter?: PersistenceChangeSetDesktopHierarchyParent;
}

model PersistenceChangeSetDesktopDocumentCreate {
  type: "document.create";
  command: {
    projectId: string;
    documentId?: string;
    parentId?: string | null;
    kind: string;
    title: string;
    orderKey: string;
    appendToEnd?: boolean;
    markdown: string;
    authorId: string;
    idempotencyKey: string;
  };
  hierarchy?: PersistenceChangeSetDesktopHierarchy;
}

model PersistenceChangeSetDesktopDocumentUpdate {
  type: "document.update";
  command: {
    projectId: string;
    documentId: string;
    @minValue(1) expectedVersion: int32;
    parentId?: string | null;
    title?: string;
    orderKey?: string;
  };
}

model PersistenceChangeSetDesktopDocumentDelete {
  type: "document.delete";
  command: { projectId: string; documentId: string; @minValue(1) expectedVersion: int32; };
}

model PersistenceChangeSetDesktopDocumentSave {
  type: "document.save";
  command: {
    projectId: string;
    documentId: string;
    baseRevisionId: string;
    changes: DocumentChange[];
    @pattern("^[0-9a-f]{64}$") resultingSha256: string;
    authorId: string;
    clientId: string;
    idempotencyKey: string;
  };
}

model PersistenceChangeSetDesktopDocumentRestore {
  type: "document.restore";
  command: {
    projectId: string;
    documentId: string;
    baseRevisionId: string;
    sourceRevisionId: string;
    authorId: string;
    idempotencyKey: string;
  };
}

model PersistenceChangeSetDesktopModuleRecordSave {
  type: "module.record.save";
  command: { projectId: string; moduleId: string; key: string; value: JsonObject; expectedVersion: int32 | null; };
}

model PersistenceChangeSetDesktopKnowledgeNodeSave {
  type: "knowledge.node.save";
  command: {
    projectId: string; id: string; type: string; name: string; attributes: JsonObject;
    status: "proposed" | "confirmed" | "retired"; expectedVersion: int32 | null;
  };
}

model PersistenceChangeSetDesktopKnowledgeAliasSave {
  type: "knowledge.alias.save";
  command: {
    projectId: string; id: string; nodeId: string; surface: string; normalized: string; scope: string | null;
    status: "proposed" | "confirmed" | "ambiguous" | "retired";
  };
}

model PersistenceChangeSetDesktopKnowledgeRelationSave {
  type: "knowledge.relation.save";
  command: {
    projectId: string; id: string; sourceId: string; targetId: string; type: string;
    attributes: JsonObject; validity: JsonObject;
    status: "proposed" | "confirmed" | "rejected" | "retired"; expectedVersion: int32 | null;
  };
}

model PersistenceChangeSetDesktopEvidenceAnchorSave {
  type: "evidence.anchor.save";
  command: {
    projectId: string; id: string; documentId: string; revisionId: string;
    @minValue(0) fromUtf16: int32; @minValue(0) toUtf16: int32;
    @pattern("^[0-9a-f]{64}$") quoteSha256: string;
    status: "proposed" | "confirmed" | "needs_review" | "orphaned";
    expectedVersion: int32 | null;
  };
}

model PersistenceChangeSetDesktopEvidenceMentionSave {
  type: "evidence.mention.save";
  command: {
    projectId: string; evidenceId: string; nodeId: string; source: string;
    confidence: float64 | null; extractorVersion: string | null;
    status: "proposed" | "confirmed" | "ambiguous" | "rejected";
  };
}

model PersistenceChangeSetDesktopEvidenceAssertionSave {
  type: "evidence.assertion.save";
  command: {
    projectId: string; id: string; proposition: JsonObject; modality: string; perspective: string;
    narrativeTime: JsonObject; confidence: float64 | null;
    status: "proposed" | "confirmed" | "rejected" | "retired"; expectedVersion: int32 | null;
  };
}

model PersistenceChangeSetDesktopEvidenceAssertionLink {
  type: "evidence.assertion.link";
  command: {
    projectId: string; assertionId: string; evidenceId: string;
    role: "supports" | "contradicts" | "quotes" | "context";
  };
}

model PersistenceChangeSetDesktopKnowledgeMerge {
  type: "knowledge.merge";
  command: {
    projectId: string; sourceId: string; targetId: string; @minValue(1) projectVersion: int32;
    @pattern("^[0-9a-f]{64}$") previewDigest: string; actorId: string;
    origin: "author" | "external-agent"; auditId: string; generatedAliasId: string; plan: JsonObject;
  };
}

union PersistenceChangeSetDesktopOperation {
  documentCreate: PersistenceChangeSetDesktopDocumentCreate,
  documentUpdate: PersistenceChangeSetDesktopDocumentUpdate,
  documentDelete: PersistenceChangeSetDesktopDocumentDelete,
  documentSave: PersistenceChangeSetDesktopDocumentSave,
  documentRestore: PersistenceChangeSetDesktopDocumentRestore,
  moduleRecordSave: PersistenceChangeSetDesktopModuleRecordSave,
  knowledgeNodeSave: PersistenceChangeSetDesktopKnowledgeNodeSave,
  knowledgeAliasSave: PersistenceChangeSetDesktopKnowledgeAliasSave,
  knowledgeRelationSave: PersistenceChangeSetDesktopKnowledgeRelationSave,
  evidenceAnchorSave: PersistenceChangeSetDesktopEvidenceAnchorSave,
  evidenceMentionSave: PersistenceChangeSetDesktopEvidenceMentionSave,
  evidenceAssertionSave: PersistenceChangeSetDesktopEvidenceAssertionSave,
  evidenceAssertionLink: PersistenceChangeSetDesktopEvidenceAssertionLink,
  knowledgeMerge: PersistenceChangeSetDesktopKnowledgeMerge,
}

model PersistenceChangeSetDesktopBody {
  id: string;
  projectId: string;
  authorId: string;
  status: "proposed" | "approved" | "applied" | "rejected";
  operations: PersistenceChangeSetDesktopOperation[];
  readSet: PersistenceChangeSetDesktopReadEntry[];
  writeSet: PersistenceChangeSetDesktopWriteEntry[];
  provenance: PersistenceChangeSetDesktopProvenance;
  @minValue(1) version: int32;
  idempotencyKey: string;
  createdAt: utcDateTime;
  approvedAt: utcDateTime | null;
  approvedBy: string | null;
  appliedAt: utcDateTime | null;
  rejectedAt: utcDateTime | null;
  rejectedBy: string | null;
}

model PersistenceChangeSetDesktopListBody {
  changeSets: PersistenceChangeSetDesktopBody[];
}

model PersistenceChangeSetDesktopResponseBody {
  changeSet: PersistenceChangeSetDesktopBody;
  receipt?: PersistenceChangeSetDesktopApplicationBody | null;
}

model PersistenceChangeSetDesktopApprovalBody {
  changeSet: PersistenceChangeSetDesktopBody;
}

model PersistenceChangeSetDesktopApplicationBody {
  changeSet: PersistenceChangeSetDesktopBody;
  results: JsonObject[];
  replayed: boolean;
}

model DesktopCoreReviewFeedItem {
  kind: "core-proposal";
  id: string;
  projectId: string;
  createdAt: utcDateTime;
  state: "proposed" | "partially_approved" | "approved" | "applied";
  approvalModel: "per-operation";
  applicationModel: "per-operation";
  status: CoreProposalStatusBody;
  receipts: ProposalApplyReceiptBody[];
  stale: boolean;
}

model DesktopNativeReviewFeedItem {
  kind: "native-change-set";
  id: string;
  projectId: string;
  createdAt: utcDateTime;
  state: "proposed" | "approved" | "applied" | "rejected";
  approvalModel: "whole-change-set";
  applicationModel: "transaction";
  changeSet: PersistenceChangeSetDesktopBody;
  receipt: PersistenceChangeSetDesktopApplicationBody | null;
}

union DesktopReviewFeedItem {
  coreProposal: DesktopCoreReviewFeedItem,
  nativeChangeSet: DesktopNativeReviewFeedItem,
}

model DesktopReviewFeedBody {
  items: DesktopReviewFeedItem[];
}

model PersistenceChangeSetListBody {
  changeSets?: PersistenceChangeSetBody[];
  ...Record<unknown>;
}

model PersistenceChangeSetResponseBody {
  changeSet?: PersistenceChangeSetBody;
  receipt?: JsonObject | null;
  ...Record<unknown>;
}

model PersistenceChangeSetResultBody {
  changeSet?: PersistenceChangeSetBody;
  replayed?: boolean;
  ...Record<unknown>;
}

model PersistenceChangeSetApplicationBody {
  changeSet?: PersistenceChangeSetBody;
  results?: JsonObject[];
  replayed?: boolean;
  ...Record<unknown>;
}

model PersistenceChangeSetApprovalBody {
  changeSet?: PersistenceChangeSetBody;
  ...Record<unknown>;
}

model KnowledgeMergePreviewBody {
  projectVersion?: int32;
  source?: KnowledgeNodeBody;
  target?: KnowledgeNodeBody;
  sourceAliases?: KnowledgeAliasBody[];
  targetAliases?: KnowledgeAliasBody[];
  sourceRelations?: KnowledgeRelationBody[];
  targetRelations?: KnowledgeRelationBody[];
  sourceMentions?: JsonObject[];
  targetMentions?: JsonObject[];
  assertions?: PersistenceAssertionBody[];
  conflicts?: string[];
  previewDigest?: string;
  ...Record<unknown>;
}

model KnowledgeMergeResultBody {
  target?: KnowledgeNodeBody;
  source?: KnowledgeNodeBody;
  auditId?: string;
  ...Record<unknown>;
}

model SnapshotIdBody {
  projectId: string;
  @minValue(1)
  projectVersion: int32;
  ...Record<unknown>;
}

model CoreChangeProposalBody {
  id: string;
  snapshot: SnapshotIdBody;
  operations: JsonObject[];
  source: "author" | "module" | "mcp";
  evidence?: CoreProposalEvidenceBody[];
  ...Record<unknown>;
}

model CoreProposalFileRevisionBody {
  path: string;
  revision: string | null;
  ...Record<unknown>;
}

model CoreProposalEvidenceBody {
  id: string;
  snapshot: SnapshotIdBody;
  module: "story" | "diagnostics" | "nlp" | "semantic" | "speaker" | "assistant" | "publishing" | "mcp" | "search";
  kind: string;
  paths: CoreProposalFileRevisionBody[];
  details: unknown;
  ...Record<unknown>;
}

model CoreProposalStatusBody {
  proposal: CoreChangeProposalBody;
  payloadComplete?: boolean;
  originalDigest?: string;
  operationIds?: string[];
  state: "proposed" | "partially_approved" | "approved" | "applied";
  approvedOperationIds: string[];
  approvedByOperationId?: Record<string>;
  applications: ProposalApplyReceiptBody[];
  appliedOperationIds: string[];
  stale: boolean;
  ...Record<unknown>;
}

model ProposalListBody {
  proposals: CoreProposalStatusBody[];
  ...Record<unknown>;
}

model ProjectReviewQueueBody {
  snapshot?: JsonObject;
  proposals?: CoreProposalStatusBody[];
  ...Record<unknown>;
}

model GlobalReviewQueueItemBody {
  projectId?: string;
  proposal?: CoreProposalStatusBody;
  ...Record<unknown>;
}

model GlobalReviewQueueBody {
  unresolvedCount?: int32;
  items?: GlobalReviewQueueItemBody[];
  ...Record<unknown>;
}

model ProjectActionDescriptorBody {
  id?: string;
  module?: string;
  effect?: "read" | "compute" | "propose";
  job?: boolean;
  ...Record<unknown>;
}

model ProjectActionsBody {
  actions?: ProjectActionDescriptorBody[];
  ...Record<unknown>;
}

model ManuscriptSnapshotMetaBody {
  id?: string; sceneId?: string; manuscriptId?: string; createdAt?: int64;
  charCount?: int32; source?: "postgres"; label?: string;
  trigger?: "manual" | "submit" | "idle";
  ...Record<unknown>;
}

model ManuscriptSnapshotListBody {
  snapshot?: JsonObject;
  snapshots?: ManuscriptSnapshotMetaBody[];
  ...Record<unknown>;
}

model ManuscriptSnapshotReadBody {
  snapshot?: JsonObject;
  manuscriptSnapshot?: {
    id?: string; sceneId?: string; manuscriptId?: string; createdAt?: int64; charCount?: int32;
    source?: "postgres"; label?: string; trigger?: "manual" | "submit" | "idle";
    body?: string; document?: { path?: string; content?: string; revision?: string; ...Record<unknown>; };
    ...Record<unknown>;
  };
  ...Record<unknown>;
}

model SearchResultBody {
  id?: string; type?: "scene" | "chapter" | "volume" | "manuscript";
  name?: string; snippet?: string; filePath?: string; score?: float64;
  field?: "body" | "name"; offset?: int32; length?: int32;
  ...Record<unknown>;
}

model ProjectSearchBody {
  snapshot?: JsonObject;
  query?: string;
  results?: SearchResultBody[];
  ...Record<unknown>;
}

model SceneWritingStatsBody {
  sceneId?: string; charCount?: int32; pages400?: float64; status?: string;
  ...Record<unknown>;
}

model ChapterWritingStatsBody {
  chapterId?: string; charCount?: int32; pages400?: float64; scenes?: SceneWritingStatsBody[];
  ...Record<unknown>;
}

model VolumeWritingStatsBody {
  volumeId?: string; charCount?: int32; pages400?: float64; chapters?: ChapterWritingStatsBody[];
  ...Record<unknown>;
}

model WritingStatsBody {
  totalCharCount?: int32; totalPages400?: float64; volumes?: VolumeWritingStatsBody[];
  sceneById?: Record<SceneWritingStatsBody>;
  ...Record<unknown>;
}

model WritingStatsResponseBody {
  snapshot?: JsonObject;
  stats?: WritingStatsBody;
  ...Record<unknown>;
}

model ProposalApplyReceiptBody {
  operationId: string;
  generation: int32;
  @minValue(1)
  projectVersion: int32;
  revisions: CoreProposalFileRevisionBody[];
  ...Record<unknown>;
}

model AuthorReviewItemBody {
  kind?: "core-proposal" | "native-change-set";
  id?: string; projectId?: string; createdAt?: utcDateTime;
  state?: "proposed" | "partially_approved" | "approved" | "applied" | "rejected";
  approvalModel?: "per-operation" | "whole-change-set";
  applicationModel?: "per-operation" | "transaction";
  status?: CoreProposalStatusBody;
  receipts?: JsonObject[];
  stale?: boolean;
  changeSet?: PersistenceChangeSetBody;
  receipt?: PersistenceChangeSetApplicationBody | null;
  ...Record<unknown>;
}

model PersistenceReviewFeedBody {
  items?: AuthorReviewItemBody[];
  ...Record<unknown>;
}

model ScratchAttachmentBody {
  filename?: string; path?: string; mimeType?: string;
  ...Record<unknown>;
}

model ScratchCreateBody {
  id?: string; path?: string; createdAt?: utcDateTime;
  source?: "voice" | "camera" | "text"; sceneId?: string | null;
  attachments?: ScratchAttachmentBody[];
  proposal?: JsonObject; receipt?: ProposalApplyReceiptBody;
  ...Record<unknown>;
}

model ActionResultBody {
  ok?: boolean;
  snapshot?: JsonObject;
  data?: unknown;
  proposals?: JsonObject[];
  error?: JsonObject;
  ...Record<unknown>;
}

// Desktop Web requests the synchronous result variant only. Async 202 job
// responses remain an explicit operation result, but are rejected by its
// generated client schema and handled through the job APIs.
model DesktopActionSuccessBody {
  ok: true;
  snapshot: SnapshotIdBody;
  data: unknown;
  proposals?: CoreChangeProposalBody[];
  ...Record<unknown>;
}

model DesktopActionFailureBody {
  ok: false;
  snapshot: SnapshotIdBody;
  error: { code: string; message: string; retryable: boolean; ...Record<unknown>; };
  ...Record<unknown>;
}

union DesktopActionResultBody {
  success: DesktopActionSuccessBody;
  failure: DesktopActionFailureBody;
}

model CoreProjectCreateRequest {
  @pattern(".*\\S.*")
  @minLength(1)
  title: string;
  ...Record<never>;
}

model PersistenceProjectCreateRequest {
  id?: PersistenceId;
  @pattern(".*\\S.*")
  @minLength(1)
  @maxLength(256)
  title: string;
  settings?: JsonObject;
  ...Record<never>;
}

model PersistenceProjectUpdateRequest {
  @minValue(1)
  expectedVersion: int32;
  @pattern(".*\\S.*")
  @minLength(1)
  @maxLength(256)
  title?: string;
  settings?: JsonObject;
  ...Record<never>;
}

model PersistenceDocumentCreateRequest {
  documentId?: PersistenceId;
  parentId?: PersistenceId | null;
  @minLength(1) @maxLength(64) @pattern(".*\\S.*")
  kind: string;
  @minLength(1) @maxLength(256) @pattern(".*\\S.*")
  title: string;
  @maxLength(512)
  orderKey?: string;
  appendToEnd?: boolean;
  markdown: string;
  ...Record<never>;
}

model PersistenceDocumentMetadataRequest {
  @minValue(1)
  expectedVersion: int32;
  parentId?: PersistenceId | null;
  @minLength(1) @maxLength(256) @pattern(".*\\S.*")
  title?: string;
  @minLength(1) @maxLength(256) @pattern(".*\\S.*")
  orderKey?: string;
  ...Record<never>;
}

model PersistenceDocumentDeleteRequest {
  @minValue(1)
  expectedVersion: int32;
  ...Record<never>;
}

model PersistenceDocumentRestoreRequest {
  baseRevisionId: PersistenceId;
  sourceRevisionId: PersistenceId;
  ...Record<never>;
}

model PersistenceAnchorCreateRequest {
  id?: PersistenceId;
  revisionId: PersistenceId;
  @minValue(0)
  fromUtf16: int32;
  @minValue(0)
  toUtf16: int32;
  status?: "proposed" | "confirmed";
  nodeId?: PersistenceId;
  ...Record<never>;
}

model PersistenceAnchorUpdateRequest {
  revisionId: PersistenceId;
  @minValue(0)
  fromUtf16: int32;
  @minValue(0)
  toUtf16: int32;
  status: "proposed" | "confirmed";
  @minValue(1)
  expectedVersion: int32;
  ...Record<never>;
}

model PersistenceAnchorAssertionRequest {
  id: PersistenceId;
  nodeId: PersistenceId;
  @minLength(1) @maxLength(4000) @pattern(".*\\S.*")
  statement: string;
  modality: "fact" | "belief" | "disclosure" | "hypothesis";
  @minLength(1) @maxLength(128) @pattern(".*\\S.*")
  perspective: string;
  revisionId: PersistenceId;
  @minValue(1)
  expectedAnchorVersion: int32;
  ...Record<never>;
}

model PersistenceMentionCreateRequest {
  nodeId: PersistenceId;
  status?: "proposed" | "confirmed" | "ambiguous" | "rejected";
  ...Record<never>;
}

model PersistenceKnowledgeNodeUpdateRequest {
  @minLength(1) @maxLength(64) @pattern(".*\\S.*")
  type: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  name: string;
  attributes: JsonObject;
  status: "proposed" | "confirmed" | "retired";
  expectedVersion?: PositiveVersion | null;
  ...Record<never>;
}

model PersistenceKnowledgeAliasCreateRequest {
  id?: PersistenceId;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  surface: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  normalized: string;
  scope?: string | null;
  status?: "proposed" | "confirmed" | "ambiguous" | "retired";
  ...Record<never>;
}

model PersistenceKnowledgeRelationCreateRequest {
  id?: PersistenceId;
  targetId: PersistenceId;
  @minLength(1) @maxLength(128) @pattern(".*\\S.*")
  type: string;
  attributes?: JsonObject;
  validity?: JsonObject;
  status?: "proposed" | "confirmed" | "rejected" | "retired";
  expectedVersion?: PositiveVersion | null;
  ...Record<never>;
}

model PersistenceAssertionUpdateRequest {
  proposition: JsonObject;
  @minLength(1) @maxLength(128) @pattern(".*\\S.*")
  modality: string;
  @minLength(1) @maxLength(128) @pattern(".*\\S.*")
  perspective: string;
  narrativeTime?: JsonObject;
  confidence?: UnitConfidence | null;
  status: "proposed" | "confirmed" | "rejected" | "retired";
  expectedVersion: PositiveVersion | null;
  ...Record<never>;
}

model PersistenceAssertionEvidenceCreateRequest {
  evidenceId: PersistenceId;
  role: "supports" | "contradicts" | "quotes" | "context";
  ...Record<never>;
}

model PersistenceAssertionEnvelope {
  assertion: JsonObject;
  ...Record<never>;
}

model PersistenceKnowledgeNodeEnvelope {
  node: JsonObject;
  ...Record<never>;
}

model PersistenceKnowledgeAliasEnvelope {
  @encodedName("application/json", "alias") aliasValue: JsonObject;
  ...Record<never>;
}

model PersistenceKnowledgeRelationEnvelope {
  relation: JsonObject;
  ...Record<never>;
}

model PersistenceEvidenceEnvelope {
  evidence: JsonObject;
  ...Record<never>;
}

model PersistenceMentionLink {
  projectId: string;
  evidenceId: string;
  nodeId: string;
  status: "proposed" | "confirmed" | "ambiguous" | "rejected";
  source: string;
  confidence: float64 | null;
  extractorVersion: string | null;
  createdAt: utcDateTime;
  updatedAt: utcDateTime;
  ...Record<never>;
}

@maxLength(1024)
scalar ArchiveOmittedRecord extends string;

model WorkArchiveExportProject {
  @minLength(1) @maxLength(512)
  title: string;
  settings: JsonObject;
  ...Record<never>;
}

model WorkArchiveExportDocument {
  id: ArchiveId;
  parentId: ArchiveId | null;
  @minLength(1) @maxLength(512)
  kind: string;
  @minLength(1) @maxLength(512)
  title: string;
  @maxLength(512)
  orderKey: string;
  markdown: string;
  revisionId: ArchiveId;
  ...Record<never>;
}

model WorkArchiveExportKnowledgeNode {
  id: ArchiveId;
  @minLength(1) @maxLength(512)
  type: string;
  @minLength(1) @maxLength(512)
  name: string;
  attributes: JsonObject;
  status: "proposed" | "confirmed" | "retired";
  ...Record<never>;
}

model WorkArchiveExportKnowledgeAlias {
  id: ArchiveId;
  nodeId: ArchiveId;
  @minLength(1) @maxLength(512)
  surface: string;
  @minLength(1) @maxLength(512)
  normalized: string;
  scope: string | null;
  status: "proposed" | "confirmed" | "ambiguous" | "retired";
  ...Record<never>;
}

model WorkArchiveExportKnowledgeRelation {
  id: ArchiveId;
  sourceId: ArchiveId;
  targetId: ArchiveId;
  @minLength(1) @maxLength(512)
  type: string;
  attributes: JsonObject;
  validity: JsonObject;
  status: "proposed" | "confirmed" | "rejected" | "retired";
  ...Record<never>;
}

model WorkArchiveExportKnowledge {
  @maxItems(999)
  nodes: WorkArchiveExportKnowledgeNode[];
  @maxItems(10000)
  aliases: WorkArchiveExportKnowledgeAlias[];
  @maxItems(10000)
  relations: WorkArchiveExportKnowledgeRelation[];
  ...Record<never>;
}

model WorkArchiveExportAnchor {
  id: ArchiveId;
  documentId: ArchiveId;
  revisionId: ArchiveId;
  @minValue(0) fromUtf16: int32;
  @minValue(0) toUtf16: int32;
  @pattern("^[0-9a-f]{64}$")
  quoteSha256: string;
  status: "proposed" | "confirmed" | "needs_review" | "orphaned";
  ...Record<never>;
}

model WorkArchiveExportMention {
  evidenceId: ArchiveId;
  nodeId: ArchiveId;
  status: "proposed" | "confirmed" | "ambiguous" | "rejected";
  @minLength(1) @maxLength(512)
  source: string;
  confidence: UnitConfidence | null;
  extractorVersion: string | null;
  ...Record<never>;
}

model WorkArchiveExportAssertion {
  id: ArchiveId;
  proposition: JsonObject;
  @minLength(1) @maxLength(512)
  modality: string;
  @minLength(1) @maxLength(512)
  perspective: string;
  narrativeTime: JsonObject;
  confidence: UnitConfidence | null;
  status: "proposed" | "confirmed" | "rejected" | "retired";
  ...Record<never>;
}

model WorkArchiveExportAssertionEvidence {
  assertionId: ArchiveId;
  evidenceId: ArchiveId;
  role: "supports" | "contradicts" | "quotes" | "context";
  ...Record<never>;
}

model WorkArchiveExportUnresolvedEvidence {
  @maxItems(20000)
  anchors: WorkArchiveExportAnchor[];
  @maxItems(40000)
  mentions: WorkArchiveExportMention[];
  @maxItems(40000)
  assertionEvidence: WorkArchiveExportAssertionEvidence[];
  ...Record<never>;
}

model WorkArchiveExportEvidence {
  @maxItems(10000)
  anchors: WorkArchiveExportAnchor[];
  @maxItems(40000)
  mentions: WorkArchiveExportMention[];
  @maxItems(999)
  assertions: WorkArchiveExportAssertion[];
  @maxItems(40000)
  assertionEvidence: WorkArchiveExportAssertionEvidence[];
  unresolved: WorkArchiveExportUnresolvedEvidence;
  ...Record<never>;
}

model WorkArchiveExportModuleRecord {
  @minLength(1) @maxLength(512)
  moduleId: string;
  @minLength(1) @maxLength(512)
  key: string;
  value: JsonObject;
  ...Record<never>;
}

model WorkArchiveExport {
  format: "codexia-work/v1";
  project: WorkArchiveExportProject;
  @maxItems(999)
  documents: WorkArchiveExportDocument[];
  knowledge: WorkArchiveExportKnowledge;
  evidence: WorkArchiveExportEvidence;
  @maxItems(10000)
  moduleRecords: WorkArchiveExportModuleRecord[];
  @maxItems(10000)
  omittedRecords: ArchiveOmittedRecord[];
  ...Record<never>;
}

// Import and export share the same portable v1 wire shape.
model WorkArchive is WorkArchiveExport;

model WorkImportResult {
  project: Project;
  replayed: boolean;
  unresolvedAnchors: int32;
  omittedRecords: int32;
  ...Record<never>;
}

model ProjectResponse {
  project: Project;
  ...Record<never>;
}

@minLength(1) @maxLength(512) @pattern(".*\\S.*")
scalar NativeOperationText extends string;

model NativeKnowledgeNodeSaveRequest {
  type: "knowledge.node.save";
  command: {
    projectId: PersistenceId; id: PersistenceId; type: NativeOperationText; name: NativeOperationText;
    attributes: JsonObject; status: "proposed" | "confirmed" | "retired"; expectedVersion: PositiveVersion | null;
    ...Record<never>;
  };
  ...Record<never>;
}

model NativeKnowledgeAliasSaveRequest {
  type: "knowledge.alias.save";
  command: {
    projectId: PersistenceId; id: PersistenceId; nodeId: PersistenceId; surface: NativeOperationText;
    normalized: NativeOperationText; scope: NativeOperationText | null; status: "proposed" | "confirmed" | "ambiguous" | "retired";
    ...Record<never>;
  };
  ...Record<never>;
}

model NativeKnowledgeRelationSaveRequest {
  type: "knowledge.relation.save";
  command: {
    projectId: PersistenceId; id: PersistenceId; sourceId: PersistenceId; targetId: PersistenceId;
    type: NativeOperationText; attributes: JsonObject; validity: JsonObject;
    status: "proposed" | "confirmed" | "rejected" | "retired"; expectedVersion: PositiveVersion | null;
    ...Record<never>;
  };
  ...Record<never>;
}

model NativeEvidenceAnchorSaveRequest {
  type: "evidence.anchor.save";
  command: {
    projectId: PersistenceId; id: PersistenceId; documentId: PersistenceId; revisionId: PersistenceId;
    @minValue(0) fromUtf16: int32; @minValue(1) toUtf16: int32; @pattern("^[0-9a-f]{64}$") quoteSha256: string;
    status: "proposed" | "confirmed" | "needs_review" | "orphaned"; expectedVersion: PositiveVersion | null;
    ...Record<never>;
  };
  ...Record<never>;
}

model NativeEvidenceMentionSaveRequest {
  type: "evidence.mention.save";
  command: {
    projectId: PersistenceId; evidenceId: PersistenceId; nodeId: PersistenceId;
    source: NativeOperationText; confidence: UnitConfidence | null; extractorVersion: NativeOperationText | null;
    status: "proposed" | "confirmed" | "ambiguous" | "rejected";
    ...Record<never>;
  };
  ...Record<never>;
}

model NativeEvidenceAssertionSaveRequest {
  type: "evidence.assertion.save";
  command: {
    projectId: PersistenceId; id: PersistenceId; proposition: JsonObject; modality: NativeOperationText;
    perspective: NativeOperationText; narrativeTime: JsonObject; confidence: UnitConfidence | null;
    status: "proposed" | "confirmed" | "rejected" | "retired"; expectedVersion: PositiveVersion | null;
    ...Record<never>;
  };
  ...Record<never>;
}

model NativeEvidenceAssertionLinkRequest {
  type: "evidence.assertion.link";
  command: {
    projectId: PersistenceId; assertionId: PersistenceId; evidenceId: PersistenceId;
    role: "supports" | "contradicts" | "quotes" | "context";
    ...Record<never>;
  };
  ...Record<never>;
}

union NativeChangeSetOperationRequest {
  nativeKnowledgeNodeSave: NativeKnowledgeNodeSaveRequest,
  nativeKnowledgeAliasSave: NativeKnowledgeAliasSaveRequest,
  nativeKnowledgeRelationSave: NativeKnowledgeRelationSaveRequest,
  nativeEvidenceAnchorSave: NativeEvidenceAnchorSaveRequest,
  nativeEvidenceMentionSave: NativeEvidenceMentionSaveRequest,
  nativeEvidenceAssertionSave: NativeEvidenceAssertionSaveRequest,
  nativeEvidenceAssertionLink: NativeEvidenceAssertionLinkRequest,
}

model ProposeChangeSetRequest {
  @minValue(1)
  projectVersion: int32;
  @minItems(1)
  @maxItems(50)
  @doc("Every command targets the path project; native write identities are unique, and operations are limited to 256,000 UTF-8 JSON bytes.")
  operations: NativeChangeSetOperationRequest[];
  ...Record<never>;
}

model ChangeSetActionRequest {
  @minValue(1)
  expectedVersion: int32;
  ...Record<never>;
}

model KnowledgeMergePreviewRequest {
  targetId: PersistenceId;
  ...Record<never>;
}

model KnowledgeMergeRequest {
  targetId: PersistenceId;
  confirm: true;
  @minValue(0)
  projectVersion: int32;
  @minLength(64)
  @maxLength(64)
  @pattern("^[0-9a-f]{64}$")
  previewDigest: string;
  ...Record<never>;
}

model NoAuth {
  type: "noAuth";
}

model HealthResponse {
  status: "ok";
  ...Record<never>;
}

model ReadinessResponse {
  ok: boolean;
  pendingRequests?: int32;
  persistenceReady?: boolean;
  started?: boolean;
  ...Record<never>;
}

model ReadinessSuccess {
  @header("Cache-Control") cacheControl: "no-store";
  @body body: ReadinessResponse;
}

model ReadinessUnavailable {
  @statusCode statusCode: 503;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: ReadinessResponse;
}

// HEAD responses retain applicable representation headers but never a body.
model HeadJsonResponse {
  @header contentType: "application/json";
}

model VersionResponse {
  name: "codexia";
  version: string;
  contractVersion: string;
  apiEpoch?: int32;
  profile: "core" | "full";
  auth: string[];
  runtime: JsonObject;
  modules: JsonObject[];
  ...Record<never>;
}

model DesktopVersionResponse {
  ...OmitProperties<VersionResponse, "contractVersion">;
  contractVersion: int32;
}

model EventStream {
  @header contentType: "text/event-stream";
  @header("Cache-Control") cacheControl?: string;
  @body body: string;
}

model McpEventStream {
  @header contentType: "text/event-stream";
  @header("MCP-Protocol-Version") protocolVersion?: string;
  @header("WWW-Authenticate") wwwAuthenticate?: string;
  @body body: string;
}

model McpJsonResponse {
  @header contentType: "application/json";
  @header("MCP-Protocol-Version") protocolVersion?: string;
  @header("WWW-Authenticate") wwwAuthenticate?: string;
  @body body: JsonObject;
}

model McpParseError {
  jsonrpc: "2.0";
  id: null;
  error: { code: -32700; message: string; };
  ...Record<never>;
}

model McpAdmissionBadRequest {
  @statusCode statusCode: 400;
  @body body: ApiError;
}

model McpAdmissionForbidden {
  @statusCode statusCode: 403;
  @body body: ApiError;
}

model McpAdmissionNotFound {
  @statusCode statusCode: 404;
  @body body: ApiError;
}

model McpAdmissionUnavailable {
  @statusCode statusCode: 503;
  @body body: ApiError;
}

model McpMethodDenied {
  @statusCode statusCode: 405;
  @body body: ApiError;
}

model McpAcceptedResponse {
  @statusCode statusCode: 202;
  @header("MCP-Protocol-Version") protocolVersion?: string;
  @body body?: JsonObject;
}

model JsonResponse {
  @body body: JsonObject;
}

model SaveDocumentRequest {
  baseRevisionId: PersistenceId;
  changes: DocumentChange[];
  @pattern("^[0-9a-f]{64}$")
  resultingSha256: string;
  clientId?: PersistenceClientId;
  ...Record<never>;
}

model DocumentChange {
  @minValue(0)
  fromUtf16: int32;
  @minValue(0)
  toUtf16: int32;
  insert: string;
  ...Record<never>;
}

model SaveDocumentResponse {
  document: PersistenceDocument;
  revision: PersistenceDocumentRevision;
  replayed: boolean;
  ...Record<never>;
}

model SaveConflictResponse {
  code: "PERSISTENCE_CONFLICT";
  error: string;
  details?: JsonObject | null;
  current: { document: PersistenceDocument; revision: PersistenceDocumentRevision | null; ...Record<unknown> } | null;
  ...Record<never>;
}

model SaveIdempotencyConflictResponse {
  code: "IDEMPOTENCY_CONFLICT";
  error: string;
  details?: JsonObject | null;
  ...Record<never>;
}

@oneOf
union SaveDocumentConflictResponse {
  staleBase: SaveConflictResponse,
  idempotencyKey: SaveIdempotencyConflictResponse,
}

model PersistenceDocument {
  id: string;
  projectId: string;
  parentId: string | null;
  kind: string;
  title: string;
  orderKey: string;
  headRevisionId: string | null;
  @minValue(0)
  version: int32;
  createdAt: utcDateTime;
  updatedAt: utcDateTime;
  ...Record<unknown>;
}

model PersistenceDocumentRevision {
  id: string;
  projectId: string;
  documentId: string;
  parentRevisionId: string | null;
  markdown: string;
  @pattern("^[0-9a-f]{64}$")
  sha256: string;
  authorId: string;
  createdAt: utcDateTime;
  ...Record<unknown>;
}

model PersistenceDocumentListResponse {
  documents: PersistenceDocument[];
  ...Record<unknown>;
}

model PersistenceDocumentGetResponse {
  document: PersistenceDocument;
  revision: PersistenceDocumentRevision | null;
  ...Record<unknown>;
}

model PersistenceDocumentEnvelope {
  document: PersistenceDocument;
  ...Record<unknown>;
}

model PersistenceEvidenceAnchor {
  id: string;
  projectId: string;
  documentId: string;
  revisionId: string;
  @minValue(0)
  fromUtf16: int32;
  @minValue(0)
  toUtf16: int32;
  @pattern("^[0-9a-f]{64}$")
  quoteSha256: string;
  status: "proposed" | "confirmed" | "needs_review" | "orphaned";
  @minValue(1)
  version: int32;
  createdAt: utcDateTime;
  updatedAt: utcDateTime;
  ...Record<unknown>;
}

model PersistenceAnchorCreatedResponse {
  anchor: PersistenceEvidenceAnchor;
  quote: string;
  nodeId: string | null;
  authorId: string;
  ...Record<never>;
}

model DocumentRevisionPageResponse {
  revisions: PersistenceDocumentRevision[];
  nextBefore: string | null;
  ...Record<unknown>;
}

model BackupDestinationView {
  provider: "aws-s3" | "s3-compatible";
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  addressing: "path-style" | "virtual-hosted-style";
  credentialMode: "operator-role" | "sealed-access-key";
  credentialConfigured: boolean;
  offVmPolicy: "required" | "secondary";
  retentionRequest?: JsonObject;
  schedule: "disabled";
  revision: int32;
  ...Record<never>;
}

model BackupConfigView {
  provider: "aws-s3" | "s3-compatible" | null;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  prefix: string | null;
  credentialConfigured: boolean;
  revision: int32;
  draft?: BackupDestinationView | null;
  active?: BackupDestinationView | null;
  ...Record<never>;
}

model BackupConfigResponse {
  @statusCode _: 200;
  @header("ETag") etag: string;
  @body body: BackupConfigView;
}

model AwsS3BackupConfigDraft {
  provider: "aws-s3";
  region: string;
  bucket: string;
  prefix: string;
  credentialMode: "operator-role" | "sealed-access-key";
  addressing?: "path-style" | "virtual-hosted-style";
  schedule?: "disabled";
  @extension("writeOnly", true)
  @extension("x-codexia-sensitive", "write-only; never return, persist in browser storage, or include in logs")
  accessKeyId?: string;
  @extension("writeOnly", true)
  @extension("x-codexia-sensitive", "write-only; never return, persist in browser storage, or include in logs")
  secretAccessKey?: string;
  @extension("writeOnly", true)
  @extension("x-codexia-sensitive", "write-only; never return, persist in browser storage, or include in logs")
  sessionToken?: string;
  offVmPolicy: "required" | "secondary";
  retentionRequest?: JsonObject;
  ...Record<never>;
}

model CompatibleS3BackupConfigDraft {
  provider: "s3-compatible";
  endpoint: string;
  region?: string;
  bucket: string;
  prefix: string;
  credentialMode: "operator-role" | "sealed-access-key";
  addressing?: "path-style" | "virtual-hosted-style";
  schedule?: "disabled";
  @extension("writeOnly", true)
  @extension("x-codexia-sensitive", "write-only; never return, persist in browser storage, or include in logs")
  accessKeyId?: string;
  @extension("writeOnly", true)
  @extension("x-codexia-sensitive", "write-only; never return, persist in browser storage, or include in logs")
  secretAccessKey?: string;
  @extension("writeOnly", true)
  @extension("x-codexia-sensitive", "write-only; never return, persist in browser storage, or include in logs")
  sessionToken?: string;
  offVmPolicy: "required" | "secondary";
  retentionRequest?: JsonObject;
  ...Record<never>;
}

@oneOf
union BackupConfigDraftRequest {
  AwsS3: AwsS3BackupConfigDraft,
  CompatibleS3: CompatibleS3BackupConfigDraft,
}

model BackupOperationReceipt {
  operationId: string;
  state: "queued";
  createdAt: utcDateTime;
  requestId?: string;
  status?: "QUEUED" | "RUNNING" | "PASSED" | "FAILED" | "BLOCKED" | "APPLIED";
  phase?: "probe" | "activate" | "disable";
  observedAt?: utcDateTime;
  reasonCode?: string | null;
  ...Record<never>;
}

model BackupProbeReceipt {
  probeId: string;
  state: "queued";
  createdAt: utcDateTime;
  requestId?: string;
  status?: "QUEUED" | "RUNNING" | "PASSED" | "FAILED" | "BLOCKED" | "APPLIED";
  phase?: "probe" | "activate" | "disable";
  observedAt?: utcDateTime;
  reasonCode?: string | null;
  ...Record<never>;
}

model BackupRunReceipt {
  runId: string;
  state: "queued";
  createdAt: utcDateTime;
  requestId?: string;
  status?: "QUEUED" | "RUNNING" | "UNKNOWN" | "FAILED" | "BLOCKED" | "REMOTE_VERIFIED";
  phase?: string;
  reasonCode?: string | null;
  observedAt?: utcDateTime;
  ...Record<never>;
}

model BackupOperationView {
  operationId: string;
  requestId: string;
  revision: int32;
  status: "QUEUED" | "RUNNING" | "PASSED" | "FAILED" | "BLOCKED" | "APPLIED";
  phase: "probe" | "activate" | "disable";
  reasonCode: string | null;
  observedAt: utcDateTime;
  ...Record<unknown>;
}

model BackupProbeView extends BackupOperationView {
  probeId: string;
  evidence: JsonObject | null;
}

model BackupRunView {
  runId: string;
  requestId: string;
  revision: int32 | null;
  maintenanceWindowId: string | null;
  status: "QUEUED" | "RUNNING" | "UNKNOWN" | "FAILED" | "BLOCKED" | "REMOTE_VERIFIED";
  phase: string;
  reasonCode: string | null;
  sourceSha: string | null;
  imageDigest: string | null;
  candidateSourceSha: string | null;
  candidateImageDigest: string | null;
  manifestSha256: string | null;
  offVmConfirmation: JsonObject | null;
  observedAt: utcDateTime;
  createdAt: utcDateTime;
  ...Record<unknown>;
}

model BackupRunPage {
  runs: BackupRunView[];
  nextCursor: string | null;
  ...Record<unknown>;
}

model BackupVerificationReference {
  runId: string;
  sourceSha: string | null;
  manifestSha256: string | null;
  observedAt: utcDateTime;
  ...Record<unknown>;
}

model BackupRestoreDrillReference extends BackupVerificationReference {
  receiptSha256: string;
}

model BackupRestoreDrillEvidence extends BackupRestoreDrillReference {
  status: "DRILL_PASSED" | "partial";
}

model BackupStatusView {
  activeRevision: int32 | null;
  enabled: boolean;
  status: "DISABLED" | "ACTIVE";
  degraded: boolean;
  appliedAt: utcDateTime | null;
  lastVerifiedOffVmBackup: BackupRunView | "unknown";
  restoreDrill: BackupRestoreDrillReference | "unknown";
  staging: string;
  operation?: BackupOperationView;
  run?: BackupRunView;
  ...Record<unknown>;
}

model BackupRecoveryView {
  status: "DRILL_PASSED" | "partial" | "stale" | "unknown";
  restoreDrill: BackupRestoreDrillEvidence | "unknown";
  lastVerifiedOffVmBackup: BackupVerificationReference | "unknown";
  missingConditions: string[];
  ...Record<unknown>;
}
