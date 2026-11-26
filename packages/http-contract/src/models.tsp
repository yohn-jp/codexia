import "@typespec/http";
import "@typespec/openapi";
import "@typespec/openapi3";

using TypeSpec.Http;
using TypeSpec.OpenAPI;

namespace Codexia.Http;

alias JsonObject = Record<unknown>;
alias OwnerSessionCookie = ApiKeyAuth<ApiKeyLocation.cookie, "__Secure-better-auth.session_token">;

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

model PersistenceChangeSetDesktopResultBody {
  changeSet: PersistenceChangeSetDesktopBody;
  replayed: boolean;
}

model PersistenceChangeSetDesktopApplyBody {
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
  id?: string;
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

@extension("x-codexia-validation-status", "Shape documented; runtime rejects missing or invalid fields. Required-property and strict-unknown-key claims remain incomplete pending an epoch-compatible contract change.")
model PersistenceDocumentCreateRequest {
  documentId?: string;
  parentId?: string | null;
  @minLength(1) @maxLength(64) @pattern(".*\\S.*")
  kind?: string;
  @minLength(1) @maxLength(256) @pattern(".*\\S.*")
  title?: string;
  @maxLength(512)
  orderKey?: string;
  appendToEnd?: boolean;
  markdown?: string;
  ...Record<unknown>;
}

@extension("x-codexia-validation-status", "Shape documented; runtime requires expectedVersion and validates optional metadata fields. Required-property and strict-unknown-key claims remain incomplete pending an epoch-compatible contract change.")
model PersistenceDocumentMetadataRequest {
  @minValue(1)
  expectedVersion?: int32;
  parentId?: string | null;
  @minLength(1) @maxLength(256) @pattern(".*\\S.*")
  title?: string;
  @minLength(1) @maxLength(256) @pattern(".*\\S.*")
  orderKey?: string;
  ...Record<unknown>;
}

@extension("x-codexia-validation-status", "Shape documented; runtime requires expectedVersion. Required-property and strict-unknown-key claims remain incomplete pending an epoch-compatible contract change.")
model PersistenceDocumentDeleteRequest {
  @minValue(1)
  expectedVersion?: int32;
  ...Record<unknown>;
}

@extension("x-codexia-validation-status", "Shape documented; runtime requires baseRevisionId and sourceRevisionId. Required-property and strict-unknown-key claims remain incomplete pending an epoch-compatible contract change.")
model PersistenceDocumentRestoreRequest {
  baseRevisionId?: string;
  sourceRevisionId?: string;
  ...Record<unknown>;
}

@extension("x-codexia-validation-status", "Shape documented; runtime requires revisionId and UTF-16 offsets. Required-property and strict-unknown-key claims remain incomplete pending an epoch-compatible contract change.")
model PersistenceAnchorCreateRequest {
  id?: string;
  revisionId?: string;
  @minValue(0)
  fromUtf16?: int32;
  @minValue(0)
  toUtf16?: int32;
  status?: "proposed" | "confirmed";
  nodeId?: string;
  ...Record<unknown>;
}

@extension("x-codexia-validation-status", "Shape documented; runtime requires all update fields. Required-property and strict-unknown-key claims remain incomplete pending an epoch-compatible contract change.")
model PersistenceAnchorUpdateRequest {
  revisionId?: string;
  @minValue(0)
  fromUtf16?: int32;
  @minValue(0)
  toUtf16?: int32;
  status?: "proposed" | "confirmed";
  @minValue(1)
  expectedVersion?: int32;
  ...Record<unknown>;
}

@extension("x-codexia-validation-status", "Shape documented; runtime requires the identity, statement, modality, perspective, revision and expected anchor version fields. Required-property and strict-unknown-key claims remain incomplete pending an epoch-compatible contract change.")
model PersistenceAnchorAssertionRequest {
  id?: string;
  nodeId?: string;
  @minLength(1) @maxLength(4000) @pattern(".*\\S.*")
  statement?: string;
  modality?: "fact" | "belief" | "disclosure" | "hypothesis";
  @minLength(1) @maxLength(128) @pattern(".*\\S.*")
  perspective?: string;
  revisionId?: string;
  @minValue(1)
  expectedAnchorVersion?: int32;
  ...Record<unknown>;
}

@extension("x-codexia-validation-status", "Shape documented; runtime requires nodeId and validates optional status. Required-property and strict-unknown-key claims remain incomplete pending an epoch-compatible contract change.")
model PersistenceMentionCreateRequest {
  nodeId?: string;
  status?: "proposed" | "confirmed" | "ambiguous" | "rejected";
  ...Record<unknown>;
}

@extension("x-codexia-validation-status", "Shape documented; runtime requires type, name, attributes and status; expectedVersion is nullable/optional. Required-property and strict-unknown-key claims remain incomplete pending an epoch-compatible contract change.")
model PersistenceKnowledgeNodeUpdateRequest {
  @minLength(1) @maxLength(64) @pattern(".*\\S.*")
  type?: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  name?: string;
  attributes?: JsonObject;
  status?: "proposed" | "confirmed" | "retired";
  expectedVersion?: int32 | null;
  ...Record<unknown>;
}

@extension("x-codexia-validation-status", "Shape documented; runtime requires surface and normalized. Optional id/scope/status are generated or defaulted. Required-property and strict-unknown-key claims remain incomplete pending an epoch-compatible contract change.")
model PersistenceKnowledgeAliasCreateRequest {
  id?: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  surface?: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  normalized?: string;
  scope?: string | null;
  status?: "proposed" | "confirmed" | "ambiguous" | "retired";
  ...Record<unknown>;
}

@extension("x-codexia-validation-status", "Shape documented; runtime requires targetId and type. Optional attributes, validity, id and status default on the server. Required-property and strict-unknown-key claims remain incomplete pending an epoch-compatible contract change.")
model PersistenceKnowledgeRelationCreateRequest {
  id?: string;
  targetId?: string;
  @minLength(1) @maxLength(128) @pattern(".*\\S.*")
  type?: string;
  attributes?: JsonObject;
  validity?: JsonObject;
  status?: "proposed" | "confirmed" | "rejected" | "retired";
  expectedVersion?: int32 | null;
  ...Record<unknown>;
}

@extension("x-codexia-validation-status", "Shape documented; runtime requires proposition, modality, perspective and status; expectedVersion is nullable. Required-property and strict-unknown-key claims remain incomplete pending an epoch-compatible contract change.")
model PersistenceAssertionUpdateRequest {
  proposition?: JsonObject;
  @minLength(1) @maxLength(128) @pattern(".*\\S.*")
  modality?: string;
  @minLength(1) @maxLength(128) @pattern(".*\\S.*")
  perspective?: string;
  narrativeTime?: JsonObject;
  confidence?: float64 | null;
  status?: "proposed" | "confirmed" | "rejected" | "retired";
  expectedVersion?: int32 | null;
  ...Record<unknown>;
}

@extension("x-codexia-validation-status", "Shape documented; runtime requires evidenceId and role. Required-property and strict-unknown-key claims remain incomplete pending an epoch-compatible contract change.")
model PersistenceAssertionEvidenceCreateRequest {
  evidenceId?: string;
  role?: "supports" | "contradicts" | "quotes" | "context";
  ...Record<unknown>;
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

model WorkArchiveProject {
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  title?: string;
  settings?: JsonObject;
  ...Record<unknown>;
}

model WorkArchiveDocument {
  id?: string;
  parentId?: string | null;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  kind?: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  title?: string;
  @maxLength(512)
  orderKey?: string;
  markdown?: string;
  revisionId?: string;
  ...Record<unknown>;
}

model WorkArchiveKnowledgeNode {
  id?: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  type?: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  name?: string;
  attributes?: JsonObject;
  status?: "proposed" | "confirmed" | "retired";
  ...Record<unknown>;
}

model WorkArchiveKnowledgeAlias {
  id?: string;
  nodeId?: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  surface?: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  normalized?: string;
  scope?: string | null;
  status?: "proposed" | "confirmed" | "ambiguous" | "retired";
  ...Record<unknown>;
}

model WorkArchiveKnowledgeRelation {
  id?: string;
  sourceId?: string;
  targetId?: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  type?: string;
  attributes?: JsonObject;
  validity?: JsonObject;
  status?: "proposed" | "confirmed" | "rejected" | "retired";
  ...Record<unknown>;
}

model WorkArchiveKnowledge {
  nodes?: WorkArchiveKnowledgeNode[];
  aliases?: WorkArchiveKnowledgeAlias[];
  relations?: WorkArchiveKnowledgeRelation[];
  ...Record<unknown>;
}

model WorkArchiveAnchor {
  id?: string;
  documentId?: string;
  revisionId?: string;
  @minValue(0) fromUtf16?: int32;
  @minValue(0) toUtf16?: int32;
  @pattern("^[0-9a-f]{64}$") quoteSha256?: string;
  status?: "proposed" | "confirmed" | "needs_review" | "orphaned";
  ...Record<unknown>;
}

model WorkArchiveMention {
  evidenceId?: string;
  nodeId?: string;
  status?: "proposed" | "confirmed" | "ambiguous" | "rejected";
  @minLength(1) @maxLength(512) @pattern(".*\\S.*") source?: string;
  confidence?: float64 | null;
  extractorVersion?: string | null;
  ...Record<unknown>;
}

model WorkArchiveAssertion {
  id?: string;
  proposition?: JsonObject;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*") modality?: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*") perspective?: string;
  narrativeTime?: JsonObject;
  confidence?: float64 | null;
  status?: "proposed" | "confirmed" | "rejected" | "retired";
  ...Record<unknown>;
}

model WorkArchiveAssertionEvidence {
  assertionId?: string;
  evidenceId?: string;
  role?: "supports" | "contradicts" | "quotes" | "context";
  ...Record<unknown>;
}

model WorkArchiveUnresolvedEvidence {
  @maxItems(20000)
  anchors?: WorkArchiveAnchor[];
  @maxItems(40000)
  mentions?: WorkArchiveMention[];
  @maxItems(40000)
  assertionEvidence?: WorkArchiveAssertionEvidence[];
  ...Record<unknown>;
}

model WorkArchiveEvidence {
  @maxItems(10000)
  anchors?: WorkArchiveAnchor[];
  @maxItems(40000)
  mentions?: WorkArchiveMention[];
  @maxItems(999)
  assertions?: WorkArchiveAssertion[];
  @maxItems(40000)
  assertionEvidence?: WorkArchiveAssertionEvidence[];
  unresolved?: WorkArchiveUnresolvedEvidence;
  ...Record<unknown>;
}

model WorkArchiveModuleRecord {
  @minLength(1) @maxLength(512) @pattern(".*\\S.*") moduleId?: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*") key?: string;
  value?: JsonObject;
  ...Record<unknown>;
}

@extension("x-codexia-validation-status", "The runtime enforces the strict codexia-work/v1 archive shape and size limits. OpenAPI fields remain optional/open while the approved compatibility baseline uses a generic JSON object; do not treat this schema as complete validation coverage.")
model WorkArchive {
  format?: "codexia-work/v1";
  project?: WorkArchiveProject;
  @maxItems(999)
  documents?: WorkArchiveDocument[];
  knowledge?: WorkArchiveKnowledge;
  evidence?: WorkArchiveEvidence;
  @maxItems(10000)
  moduleRecords?: WorkArchiveModuleRecord[];
  @maxItems(10000)
  omittedRecords?: string[];
  ...Record<unknown>;
}

// Export has a complete, validated archive shape. Keep import on the
// compatibility model above, whose optional fields and open object shapes are
// required for the existing import contract.
model WorkArchiveExportProject {
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  title: string;
  settings: JsonObject;
  ...Record<never>;
}

model WorkArchiveExportDocument extends WorkArchiveDocument {
  id: string;
  parentId: string | null;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  kind: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  title: string;
  @maxLength(512)
  orderKey: string;
  markdown: string;
  revisionId: string;
}

model WorkArchiveExportKnowledgeNode extends WorkArchiveKnowledgeNode {
  id: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  type: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  name: string;
  attributes: JsonObject;
  status: "proposed" | "confirmed" | "retired";
}

model WorkArchiveExportKnowledgeAlias extends WorkArchiveKnowledgeAlias {
  id: string;
  nodeId: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  surface: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  normalized: string;
  scope: string | null;
  status: "proposed" | "confirmed" | "ambiguous" | "retired";
}

model WorkArchiveExportKnowledgeRelation extends WorkArchiveKnowledgeRelation {
  id: string;
  sourceId: string;
  targetId: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  type: string;
  attributes: JsonObject;
  validity: JsonObject;
  status: "proposed" | "confirmed" | "rejected" | "retired";
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

model WorkArchiveExportAnchor extends WorkArchiveAnchor {
  id: string;
  documentId: string;
  revisionId: string;
  @minValue(0) fromUtf16: int32;
  @minValue(0) toUtf16: int32;
  @pattern("^[0-9a-f]{64}$")
  quoteSha256: string;
  status: "proposed" | "confirmed" | "needs_review" | "orphaned";
}

model WorkArchiveExportMention extends WorkArchiveMention {
  evidenceId: string;
  nodeId: string;
  status: "proposed" | "confirmed" | "ambiguous" | "rejected";
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  source: string;
  confidence: float64 | null;
  extractorVersion: string | null;
}

model WorkArchiveExportAssertion extends WorkArchiveAssertion {
  id: string;
  proposition: JsonObject;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  modality: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  perspective: string;
  narrativeTime: JsonObject;
  confidence: float64 | null;
  status: "proposed" | "confirmed" | "rejected" | "retired";
}

model WorkArchiveExportAssertionEvidence extends WorkArchiveAssertionEvidence {
  assertionId: string;
  evidenceId: string;
  role: "supports" | "contradicts" | "quotes" | "context";
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

model WorkArchiveExportModuleRecord extends WorkArchiveModuleRecord {
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  moduleId: string;
  @minLength(1) @maxLength(512) @pattern(".*\\S.*")
  key: string;
  value: JsonObject;
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
  omittedRecords: string[];
  ...Record<never>;
}

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

model ProposeChangeSetRequest {
  @minValue(1)
  projectVersion: int32;
  @minItems(1)
  @maxItems(50)
  operations: JsonObject[];
  ...Record<never>;
}

model ChangeSetActionRequest {
  @minValue(1)
  expectedVersion: int32;
  ...Record<never>;
}

model KnowledgeMergePreviewRequest {
  @minLength(1)
  @maxLength(512)
  targetId: string;
  ...Record<never>;
}

model KnowledgeMergeRequest {
  @minLength(1)
  @maxLength(512)
  targetId: string;
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
  baseRevisionId: string;
  changes: DocumentChange[];
  @doc("The runtime requires the lowercase SHA-256 of the resulting UTF-8 Markdown body; wire constraint detail remains incomplete at this baseline.")
  resultingSha256: string;
  @doc("The runtime accepts at most 128 characters when supplied; wire constraint detail remains incomplete at this baseline.")
  clientId?: string;
  ...Record<never>;
}

model DocumentChange {
  @doc("Nonnegative UTF-16 code-unit offset validated by the persistence runtime.")
  fromUtf16: int32;
  @doc("Nonnegative UTF-16 code-unit offset validated by the persistence runtime.")
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
