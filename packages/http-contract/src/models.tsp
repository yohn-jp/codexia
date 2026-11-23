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

model EventStream {
  @header contentType: "text/event-stream";
  @header("Cache-Control") cacheControl?: string;
  @body body: string;
}

model McpEventStream {
  @header contentType: "text/event-stream";
  @header("Mcp-Session-Id") mcpSessionId?: string;
  @header("MCP-Protocol-Version") protocolVersion?: string;
  @header("WWW-Authenticate") wwwAuthenticate?: string;
  @body body: string;
}

model McpJsonResponse {
  @header contentType: "application/json";
  @header("Mcp-Session-Id") mcpSessionId?: string;
  @header("MCP-Protocol-Version") protocolVersion?: string;
  @header("WWW-Authenticate") wwwAuthenticate?: string;
  @body body: JsonObject;
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

model PersistenceDocument {
  id: string;
  projectId: string;
  parentId: string | null;
  kind: string;
  title: string;
  orderKey: string;
  headRevisionId: string | null;
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

model BackupConfigView {
  provider: "aws-s3" | "s3-compatible" | null;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  prefix: string | null;
  credentialConfigured: boolean;
  revision: int32;
  ...Record<never>;
}

model AwsS3BackupConfigDraft {
  provider: "aws-s3";
  region: string;
  bucket: string;
  prefix: string;
  credentialMode: "operator-role" | "sealed-access-key";
  @extension("writeOnly", true)
  @extension("x-codexia-sensitive", "write-only; never return, persist in browser storage, or include in logs")
  accessKeyId?: string;
  @extension("writeOnly", true)
  @extension("x-codexia-sensitive", "write-only; never return, persist in browser storage, or include in logs")
  secretAccessKey?: string;
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
  @extension("writeOnly", true)
  @extension("x-codexia-sensitive", "write-only; never return, persist in browser storage, or include in logs")
  accessKeyId?: string;
  @extension("writeOnly", true)
  @extension("x-codexia-sensitive", "write-only; never return, persist in browser storage, or include in logs")
  secretAccessKey?: string;
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
  ...Record<never>;
}

model BackupProbeReceipt {
  probeId: string;
  state: "queued";
  createdAt: utcDateTime;
  ...Record<never>;
}

model BackupRunReceipt {
  runId: string;
  state: "queued";
  createdAt: utcDateTime;
  ...Record<never>;
}
