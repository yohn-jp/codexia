import "@typespec/http";
import "@typespec/openapi";
using TypeSpec.Http;
using TypeSpec.OpenAPI;

namespace Codexia.Http;

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "incomplete") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The runtime requires OWNER-SESSION cookie only. The public security declaration needs an approved compatibility baseline correction.")
@route("/api/console/backups/status") @get @operationId("backup_console_status_get")
op getBackupConsoleStatus(): JsonResponse | { @statusCode _: 401; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; };

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "incomplete") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The runtime requires OWNER-SESSION cookie only. The public security declaration needs an approved compatibility baseline correction.")
@route("/api/console/backups/config") @get @operationId("backup_console_config_get")
op getBackupConsoleConfig(): BackupConfigView | { @statusCode _: 401; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; };

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "incomplete") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The runtime requires OWNER-SESSION cookie only. The public security declaration needs an approved compatibility baseline correction.")
@route("/api/console/backups/config/draft") @put @operationId("backup_console_config_draft_put")
op putBackupConsoleConfigDraft(
  @body body: BackupConfigDraftRequest,
  @header("If-Match") ifMatch: string,
): BackupConfigView | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 412; @body body: ApiError; } | { @statusCode _: 422; @body body: ApiError; };

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "incomplete") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The runtime requires OWNER-SESSION cookie only. The public security declaration needs an approved compatibility baseline correction.")
@route("/api/console/backups/config/probes") @post @operationId("backup_console_config_probes_post")
op createBackupConsoleConfigProbe(@body body: JsonObject, @header("Idempotency-Key") idempotencyKey?: string): { @statusCode _: 202; @body body: BackupProbeReceipt; } | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 412; @body body: ApiError; } | { @statusCode _: 503; @body body: ApiError; };

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "incomplete") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The runtime requires OWNER-SESSION cookie only. The public security declaration needs an approved compatibility baseline correction.")
@route("/api/console/backups/config/probes/{probeId}") @get @operationId("backup_console_config_probe_get")
op getBackupConsoleConfigProbe(@path probeId: string): JsonResponse | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; };

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "incomplete") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The runtime requires OWNER-SESSION cookie only. The public security declaration needs an approved compatibility baseline correction.")
@route("/api/console/backups/config/activate") @post @operationId("backup_console_config_activate_post")
op activateBackupConsoleConfig(@body body: JsonObject, @header("Idempotency-Key") idempotencyKey?: string): { @statusCode _: 202; @body body: BackupOperationReceipt; } | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 412; @body body: ApiError; } | { @statusCode _: 503; @body body: ApiError; };

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "incomplete") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The runtime requires OWNER-SESSION cookie only. The public security declaration needs an approved compatibility baseline correction.")
@route("/api/console/backups/config/disable") @post @operationId("backup_console_config_disable_post")
op disableBackupConsoleConfig(@body body: JsonObject, @header("Idempotency-Key") idempotencyKey?: string): { @statusCode _: 202; @body body: BackupOperationReceipt; } | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 412; @body body: ApiError; } | { @statusCode _: 503; @body body: ApiError; };

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "incomplete") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The runtime requires OWNER-SESSION cookie only. The public security declaration needs an approved compatibility baseline correction.")
@route("/api/console/backups/runs") @post @operationId("backup_console_runs_post")
op createBackupConsoleRun(@body body: JsonObject, @header("Idempotency-Key") idempotencyKey: string): { @statusCode _: 202; @body body: BackupRunReceipt; } | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 429; @body body: ApiError; } | { @statusCode _: 503; @body body: ApiError; };

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "incomplete") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The runtime requires OWNER-SESSION cookie only. The public security declaration needs an approved compatibility baseline correction.")
@route("/api/console/backups/runs") @get @operationId("backup_console_runs_get")
op listBackupConsoleRuns(@query cursor?: string, @query limit?: int32): JsonResponse | { @statusCode _: 403; @body body: ApiError; };

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "incomplete") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The runtime requires OWNER-SESSION cookie only. The public security declaration needs an approved compatibility baseline correction.")
@route("/api/console/backups/runs/{runId}") @get @operationId("backup_console_run_get")
op getBackupConsoleRun(@path runId: string): JsonResponse | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; };

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "incomplete") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The runtime requires OWNER-SESSION cookie only. The public security declaration needs an approved compatibility baseline correction.")
@route("/api/console/backups/recovery") @get @operationId("backup_console_recovery_get")
op getBackupConsoleRecovery(): JsonResponse | { @statusCode _: 403; @body body: ApiError; };
