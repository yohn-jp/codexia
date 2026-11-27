import "@typespec/http";
import "@typespec/openapi";
using TypeSpec.Http;
using TypeSpec.OpenAPI;

namespace Codexia.Http;

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "target") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The accepted target requires OWNER-SESSION cookie only; keep this target visibly incomplete until an approved compatibility baseline correction.")
@route("/api/console/backups/status") @get @operationId("backup_console_status_get")
op getBackupConsoleStatus(
  @doc("Original Idempotency-Key of a configuration operation. When supplied, include its current receipt or return 404 if it is unknown. Omit it for the overall backup status.")
  @query @minLength(16) @maxLength(128) @pattern("^[A-Za-z0-9_-]+$") requestId?: string,
):
  | BackupStatusView
  | BackupConsoleAdmissionFailure
  | BackupConsoleNotFound
  | BackupConsoleInvalidInput;

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "target") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The accepted target requires OWNER-SESSION cookie only; keep this target visibly incomplete until an approved compatibility baseline correction.")
@route("/api/console/backups/config") @get @operationId("backup_console_config_get")
op getBackupConsoleConfig():
  | BackupConfigResponse
  | BackupConsoleAdmissionFailure;

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "target") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The accepted target requires OWNER-SESSION cookie only; keep this target visibly incomplete until an approved compatibility baseline correction.")
@route("/api/console/backups/config/draft") @put @operationId("backup_console_config_draft_put")
op putBackupConsoleConfigDraft(
  @body body: BackupConfigDraftRequest,
  @header("If-Match") ifMatch: string,
):
  | BackupConfigResponse
  | BackupConsoleAdmissionFailure
  | { @statusCode _: 412; @body body: ApiError; }
  | BackupConsoleInvalidInput;

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "target") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The accepted target requires OWNER-SESSION cookie only; keep this target visibly incomplete until an approved compatibility baseline correction.")
@route("/api/console/backups/config/probes") @post @operationId("backup_console_config_probes_post")
op createBackupConsoleConfigProbe(@body body: JsonObject, @header("Idempotency-Key") idempotencyKey?: string):
  | { @statusCode _: 202; @body body: BackupProbeReceipt; }
  | BackupConsoleAdmissionFailure
  | { @statusCode _: 409; @body body: ApiError; }
  | { @statusCode _: 412; @body body: ApiError; }
  | BackupConsoleInvalidInput;

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "target") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The accepted target requires OWNER-SESSION cookie only; keep this target visibly incomplete until an approved compatibility baseline correction.")
@route("/api/console/backups/config/probes/{probeId}") @get @operationId("backup_console_config_probe_get")
op getBackupConsoleConfigProbe(@path probeId: string):
  | BackupProbeView
  | BackupConsoleAdmissionFailure
  | BackupConsoleNotFound;

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "target") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The accepted target requires OWNER-SESSION cookie only; keep this target visibly incomplete until an approved compatibility baseline correction.")
@route("/api/console/backups/config/activate") @post @operationId("backup_console_config_activate_post")
op activateBackupConsoleConfig(@body body: JsonObject, @header("Idempotency-Key") idempotencyKey?: string):
  | { @statusCode _: 202; @body body: BackupOperationReceipt; }
  | BackupConsoleAdmissionFailure
  | { @statusCode _: 409; @body body: ApiError; }
  | { @statusCode _: 412; @body body: ApiError; }
  | BackupConsoleInvalidInput;

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "target") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The accepted target requires OWNER-SESSION cookie only; keep this target visibly incomplete until an approved compatibility baseline correction.")
@route("/api/console/backups/config/disable") @post @operationId("backup_console_config_disable_post")
op disableBackupConsoleConfig(@body body: JsonObject, @header("Idempotency-Key") idempotencyKey?: string):
  | { @statusCode _: 202; @body body: BackupOperationReceipt; }
  | BackupConsoleAdmissionFailure
  | { @statusCode _: 409; @body body: ApiError; }
  | { @statusCode _: 412; @body body: ApiError; }
  | BackupConsoleInvalidInput;

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "target") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The accepted target requires OWNER-SESSION cookie only; keep this target visibly incomplete until an approved compatibility baseline correction.")
@route("/api/console/backups/runs") @post @operationId("backup_console_runs_post")
op createBackupConsoleRun(@body body: JsonObject, @header("Idempotency-Key") idempotencyKey: string):
  | { @statusCode _: 202; @body body: BackupRunReceipt; }
  | BackupConsoleAdmissionFailure
  | { @statusCode _: 409; @body body: ApiError; }
  | { @statusCode _: 429; @body body: ApiError; }
  | BackupConsoleInvalidInput;

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "target") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The accepted target requires OWNER-SESSION cookie only; keep this target visibly incomplete until an approved compatibility baseline correction.")
@route("/api/console/backups/runs") @get @operationId("backup_console_runs_get")
op listBackupConsoleRuns(@query cursor?: string, @query limit?: int32):
  | BackupRunPage
  | BackupConsoleAdmissionFailure
  | BackupConsoleInvalidInput;

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "target") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The accepted target requires OWNER-SESSION cookie only; keep this target visibly incomplete until an approved compatibility baseline correction.")
@route("/api/console/backups/runs/{runId}") @get @operationId("backup_console_run_get")
op getBackupConsoleRun(@path runId: string):
  | BackupRunView
  | BackupConsoleAdmissionFailure
  | BackupConsoleNotFound;

@tag("backup-console") @useAuth(BearerAuth) @extension("x-codexia-contract-status", "target") @extension("x-codexia-principal", "OWNER-SESSION") @extension("x-codexia-security-deviation", "The approved baseline encodes BearerAuth. The accepted target requires OWNER-SESSION cookie only; keep this target visibly incomplete until an approved compatibility baseline correction.")
@route("/api/console/backups/recovery") @get @operationId("backup_console_recovery_get")
op getBackupConsoleRecovery():
  | BackupRecoveryView
  | BackupConsoleAdmissionFailure;

alias BackupConsoleAdmissionFailure =
  { @statusCode _: 401; @body body: ApiError; } |
  { @statusCode _: 403; @body body: ApiError; } |
  { @statusCode _: 503; @body body: ApiError; };

alias BackupConsoleNotFound = { @statusCode _: 404; @body body: ApiError; };
alias BackupConsoleInvalidInput = { @statusCode _: 422; @body body: ApiError; };
