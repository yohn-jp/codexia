import "@typespec/http";
import "@typespec/openapi";
import "@typespec/openapi3";

using TypeSpec.Http;
using TypeSpec.OpenAPI;

namespace Codexia.Http;

alias JsonObject = Record<unknown>;

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
  resultingSha256: string;
  clientId?: string;
  ...Record<never>;
}

model DocumentChange {
  fromUtf16: int32;
  toUtf16: int32;
  insert: string;
  ...Record<never>;
}

model SaveDocumentResponse {
  document: JsonObject;
  revision: JsonObject;
  replayed: boolean;
  ...Record<never>;
}

model SaveConflictResponse {
  code: "PERSISTENCE_CONFLICT";
  error: string;
  details?: JsonObject | null;
  current: JsonObject | null;
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
