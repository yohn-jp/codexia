import "@typespec/http";
import "@typespec/openapi";
import "@typespec/openapi3";

using TypeSpec.Http;
using TypeSpec.OpenAPI;

namespace Codexia.Http;

alias JsonObject = Record<unknown>;

model ApiError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: JsonObject | null;
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
