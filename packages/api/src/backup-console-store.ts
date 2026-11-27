import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export interface BackupDestination {
  provider: 'aws-s3' | 's3-compatible';
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  addressing: 'path-style' | 'virtual-hosted-style';
  credentialMode: 'operator-role' | 'sealed-access-key';
  offVmPolicy: 'required' | 'secondary';
  retentionRequest?: { generations?: number; days?: number };
  schedule: 'disabled';
}

type Kind = 'probe' | 'activate' | 'disable';
type Phase = 'QUEUED' | 'RUNNING' | 'PASSED' | 'FAILED' | 'BLOCKED' | 'APPLIED';
export interface BackupOperation {
  id: string;
  request_id: string;
  revision: number;
  kind: Kind;
  probe_id: string | null;
  state: Phase;
  reason_code: string | null;
  evidence: Record<string, unknown> | null;
  created_at: Date;
  observed_at: Date;
}
export type BackupRunState = 'QUEUED' | 'RUNNING' | 'UNKNOWN' | 'FAILED' | 'BLOCKED' | 'REMOTE_VERIFIED';
export interface BackupRun {
  id: string;
  request_id: string;
  kind: 'manual' | 'scheduled' | 'deploy';
  revision: number | null;
  maintenance_window_id: string | null;
  state: BackupRunState;
  phase: string;
  reason_code: string | null;
  source_sha: string | null;
  image_digest: string | null;
  candidate_source_sha: string | null;
  candidate_image_digest: string | null;
  manifest_sha256: string | null;
  evidence: Record<string, unknown> | null;
  created_at: Date;
  observed_at: Date;
}
export interface BackupRevision {
  revision: number;
  destination: BackupDestination;
  credential_id: string | null;
  key_id: string | null;
}
interface State {
  draft_revision: number | null;
  active_revision: number | null;
  applied_at: Date | null;
  active_usable: boolean;
  active_health: 'ready' | 'degraded' | 'unknown';
  executor_live: boolean;
  executor_key_ids: string[];
  executor_operator_origin: string | null;
  run_executor_enabled: boolean;
}

export class BackupConsoleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const unavailable = () => new BackupConsoleError(503, 'BACKUP_CONTROL_PLANE_UNAVAILABLE');
const stale = () => new BackupConsoleError(412, 'BACKUP_REVISION_CHANGED');
const conflict = (code: string) => new BackupConsoleError(409, code);
const scope = 'codexia_backup.';
const mutationLock = 66501;
export const backupProbeLifetimeSeconds = 15 * 60;

export async function backupTransaction<T>(client: PoolClient, action: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [mutationLock]);
    const result = await action();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function readBackupState(client: Pool | PoolClient): Promise<State> {
  const {
    rows: [state],
  } = await client.query<State>(
    `SELECT *, COALESCE(executor_seen_at > clock_timestamp() - interval '90 seconds', false) AS executor_live
     FROM ${scope}state`,
  );
  if (!state) throw unavailable();
  return state;
}

export async function readBackupRevision(client: Pool | PoolClient, revision: number | null) {
  if (revision === null) return null;
  const {
    rows: [result],
  } = await client.query<BackupRevision>(`SELECT * FROM ${scope}revisions WHERE revision = $1`, [revision]);
  return result ?? null;
}

export async function readBackupOperation(client: Pool | PoolClient, id: string) {
  const {
    rows: [result],
  } = await client.query<BackupOperation>(`SELECT * FROM ${scope}operations WHERE id = $1`, [id]);
  return result ?? null;
}

export async function readCurrentBackupProbe(client: PoolClient, id: string, revision: number) {
  const {
    rows: [operation],
  } = await client.query<BackupOperation>(
    `SELECT * FROM ${scope}operations
     WHERE id = $1 AND kind = 'probe' AND state = 'PASSED' AND revision = $2
       AND observed_at > clock_timestamp() - make_interval(secs => $3)`,
    [id, revision, backupProbeLifetimeSeconds],
  );
  return operation;
}

export function backupRetentionProven(
  retention: BackupDestination['retentionRequest'],
  evidence: { objectLock?: unknown; defaultRetentionDays?: unknown } | null | undefined,
) {
  // S3 versioning alone says nothing about the number of retained backup generations.
  if (retention?.generations !== undefined) return false;
  if (retention?.days === undefined) return true;
  return (
    evidence?.objectLock === 'enabled' &&
    typeof evidence.defaultRetentionDays === 'number' &&
    evidence.defaultRetentionDays >= retention.days
  );
}

function viewOperation(operation: BackupOperation | null) {
  if (!operation) return null;
  return {
    operationId: operation.id,
    requestId: operation.request_id,
    revision: operation.revision,
    status: operation.state,
    phase: operation.kind,
    reasonCode: operation.reason_code,
    evidence: operation.evidence,
    observedAt: operation.observed_at.toISOString(),
  };
}

function viewRevision(row: BackupRevision | null, state: State) {
  if (!row) return null;
  const { endpoint, bucket, ...destination } = row.destination;
  return {
    ...destination,
    endpoint: row.destination.provider === 'aws-s3' ? endpoint : new URL(endpoint).protocol + '//[redacted]',
    bucket: bucket.slice(0, 2) + '…',
    revision: row.revision,
    credentialConfigured:
      row.destination.credentialMode === 'operator-role'
        ? state.executor_operator_origin === row.destination.endpoint
        : Boolean(row.key_id && state.executor_key_ids.includes(row.key_id)),
  };
}

export class BackupConsoleStore {
  constructor(private readonly pool: Pool) {}

  close() {
    return this.pool.end();
  }

  async config(client: Pool | PoolClient = this.pool) {
    const state = await readBackupState(client);
    const draft = viewRevision(await readBackupRevision(client, state.draft_revision), state);
    const active = viewRevision(await readBackupRevision(client, state.active_revision), state);
    const current = draft ?? active;
    return {
      provider: current?.provider ?? null,
      endpoint: current?.endpoint ?? null,
      region: current?.region ?? null,
      bucket: current?.bucket ?? null,
      prefix: current?.prefix ?? null,
      credentialConfigured: current?.credentialConfigured ?? false,
      revision: state.draft_revision ?? 0,
      draft,
      active,
    };
  }

  async status(requestId?: string) {
    const {
      rows: [state],
    } = await this.pool.query<
      State & {
        operation: Record<string, unknown> | null;
        run: BackupRun | null;
        last_verified_run: BackupRun | null;
        last_restore_drill: Record<string, unknown> | null;
      }
    >(
      `SELECT s.*, COALESCE(executor_seen_at > clock_timestamp() - interval '90 seconds', false) AS executor_live,
         CASE WHEN o.id IS NOT NULL THEN jsonb_build_object(
           'operationId', o.id, 'requestId', o.request_id, 'revision', o.revision, 'status', o.state,
           'phase', o.kind, 'reasonCode', o.reason_code, 'observedAt', o.observed_at
         ) END AS operation,
         to_jsonb(manual_run) AS run,
         (SELECT to_jsonb(r) FROM codexia_backup.runs r WHERE r.state = 'REMOTE_VERIFIED'
          ORDER BY r.observed_at DESC LIMIT 1) AS last_verified_run,
         (SELECT jsonb_build_object('runId', r.id, 'sourceSha', d.source_sha, 'manifestSha256', d.manifest_sha256,
           'receiptSha256', d.receipt_sha256, 'observedAt', d.observed_at)
          FROM codexia_backup.restore_drills d JOIN codexia_backup.runs r ON r.id = d.run_id
          ORDER BY d.observed_at DESC LIMIT 1) AS last_restore_drill
       FROM ${scope}state s
       LEFT JOIN ${scope}operations o ON o.request_id = $1
       LEFT JOIN ${scope}runs manual_run ON manual_run.request_id = $1 AND manual_run.kind = 'manual'`,
      [requestId ?? null],
    );
    if (!state) throw unavailable();
    if (requestId && !state.operation && !state.run) throw new BackupConsoleError(404, 'BACKUP_OPERATION_NOT_FOUND');
    return {
      activeRevision: state.active_revision,
      enabled: state.active_revision !== null,
      status: state.active_revision === null ? 'DISABLED' : 'ACTIVE',
      degraded: state.active_revision !== null && (!state.executor_live || !state.active_usable || state.active_health !== 'ready'),
      appliedAt: state.applied_at?.toISOString() ?? null,
      lastVerifiedOffVmBackup: state.last_verified_run ? viewRun(state.last_verified_run) : 'unknown',
      restoreDrill: state.last_restore_drill ?? 'unknown',
      staging: 'unknown',
      ...(state.operation ? { operation: state.operation } : {}),
      ...(state.run ? { run: viewRun(state.run) } : {}),
    };
  }

  async saveDraft(expected: number, destination: BackupDestination, envelope?: { keyId: string }) {
    return this.mutate(async client => {
      const state = await readBackupState(client);
      if ((state.draft_revision ?? 0) !== expected) throw stale();
      const previous = await readBackupRevision(client, state.draft_revision);
      let credentialId: string | null = null;
      let keyId: string | null = null;
      if (envelope) {
        credentialId = randomUUID();
        keyId = envelope.keyId;
        await client.query(`INSERT INTO ${scope}credentials (id, envelope) VALUES ($1, $2)`, [credentialId, envelope]);
      } else if (
        destination.credentialMode === 'sealed-access-key' &&
        previous &&
        (['provider', 'endpoint', 'region', 'bucket', 'prefix', 'addressing'] as const).every(
          key => destination[key] === previous.destination[key],
        )
      ) {
        credentialId = previous.credential_id;
        keyId = previous.key_id;
      }
      if (destination.credentialMode === 'sealed-access-key' && !credentialId) {
        throw new BackupConsoleError(422, 'BACKUP_CREDENTIAL_REQUIRED');
      }
      const revision = expected + 1;
      await client.query(`INSERT INTO ${scope}revisions (revision, destination, credential_id, key_id) VALUES ($1, $2, $3, $4)`, [
        revision,
        destination,
        credentialId,
        keyId,
      ]);
      await client.query(`UPDATE ${scope}state SET draft_revision = $1`, [revision]);
      return this.config(client);
    });
  }

  async probe(id: string) {
    const operation = await readBackupOperation(this.pool, id);
    if (operation?.kind !== 'probe') throw new BackupConsoleError(404, 'BACKUP_PROBE_NOT_FOUND');
    return { ...viewOperation(operation), probeId: operation.id };
  }

  async enqueueRun(requestId: string, maintenanceWindowId: string): Promise<BackupRun> {
    return this.mutate(async client => {
      const existing = await this.existingRun(requestId, maintenanceWindowId, client);
      if (existing) {
        return existing;
      }
      const state = await readBackupState(client);
      if (!state.executor_live || !state.run_executor_enabled) throw new BackupConsoleError(503, 'BACKUP_EXECUTOR_UNAVAILABLE');
      const settings = await readBackupRevision(client, state.active_revision);
      if (!settings) throw conflict('BACKUP_DESTINATION_MISSING');
      if (!state.active_usable || state.active_health !== 'ready') throw conflict('BACKUP_DESTINATION_UNAVAILABLE');
      const { rowCount: operationCount } = await client.query(
        "SELECT 1 FROM codexia_backup.operations WHERE state IN ('QUEUED', 'RUNNING')",
      );
      const { rowCount: runCount } = await client.query("SELECT 1 FROM codexia_backup.runs WHERE state IN ('QUEUED', 'RUNNING')");
      if (operationCount || runCount) throw conflict('BACKUP_OPERATION_IN_PROGRESS');
      const {
        rows: [run],
      } = await client.query<BackupRun>(
        `INSERT INTO codexia_backup.runs (id, request_id, kind, revision, maintenance_window_id)
         VALUES ($1, $2, 'manual', $3, $4) RETURNING *`,
        [randomUUID(), requestId, state.active_revision, maintenanceWindowId],
      );
      if (!run) throw unavailable();
      return run;
    });
  }

  async existingRun(requestId: string, maintenanceWindowId: string, client: Pool | PoolClient = this.pool) {
    const {
      rows: [existing],
    } = await client.query<BackupRun>('SELECT * FROM codexia_backup.runs WHERE request_id = $1', [requestId]);
    if (existing && (existing.kind !== 'manual' || existing.maintenance_window_id !== maintenanceWindowId))
      throw conflict('BACKUP_REQUEST_REUSED');
    return existing ?? null;
  }

  async listRuns(cursor?: string, limit = 50) {
    const { rows } = await this.pool.query<BackupRun>(
      `SELECT run.* FROM codexia_backup.runs run
       WHERE $1::uuid IS NULL OR (run.created_at, run.id) < (
         SELECT anchor.created_at, anchor.id FROM codexia_backup.runs anchor WHERE anchor.id = $1
       )
       ORDER BY run.created_at DESC, run.id DESC LIMIT $2`,
      [cursor ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    return { runs: page.map(viewRun), nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
  }

  async run(id: string) {
    const {
      rows: [run],
    } = await this.pool.query<BackupRun>('SELECT * FROM codexia_backup.runs WHERE id = $1', [id]);
    if (!run) throw new BackupConsoleError(404, 'BACKUP_RUN_NOT_FOUND');
    return viewRun(run);
  }

  async recovery() {
    const {
      rows: [drill],
    } = await this.pool.query<{
      run_id: string;
      source_sha: string;
      manifest_sha256: string;
      receipt_sha256: string;
      observed_at: Date;
      api_ready: boolean;
    }>(
      `SELECT run_id, source_sha, manifest_sha256, receipt_sha256, observed_at, api_ready FROM codexia_backup.restore_drills
       ORDER BY observed_at DESC LIMIT 1`,
    );
    const {
      rows: [latest],
    } = await this.pool.query<{ id: string; source_sha: string | null; manifest_sha256: string | null; observed_at: Date }>(
      "SELECT id, source_sha, manifest_sha256, observed_at FROM codexia_backup.runs WHERE state = 'REMOTE_VERIFIED' ORDER BY observed_at DESC LIMIT 1",
    );
    const evidence = drill
      ? {
          status: drill.api_ready ? 'DRILL_PASSED' : 'partial',
          runId: drill.run_id,
          sourceSha: drill.source_sha,
          manifestSha256: drill.manifest_sha256,
          receiptSha256: drill.receipt_sha256,
          observedAt: drill.observed_at.toISOString(),
        }
      : null;
    const current = Boolean(drill && latest && drill.run_id === latest.id && drill.manifest_sha256 === latest.manifest_sha256);
    const missingConditions = [
      ...(!latest ? ['verified_off_vm_backup'] : []),
      ...(!current ? ['independent_restore_drill_for_latest_backup'] : []),
      ...(current && !drill?.api_ready ? ['candidate_api_readiness'] : []),
    ];
    return {
      status: current && evidence ? evidence.status : evidence ? 'stale' : 'unknown',
      restoreDrill: evidence ?? 'unknown',
      lastVerifiedOffVmBackup: latest
        ? {
            runId: latest.id,
            sourceSha: latest.source_sha,
            manifestSha256: latest.manifest_sha256,
            observedAt: latest.observed_at.toISOString(),
          }
        : 'unknown',
      missingConditions,
    };
  }

  async enqueue(kind: Kind, requestId: string, revision: number, probeId?: string): Promise<BackupOperation> {
    return this.mutate(async client => {
      const existing = await this.request(requestId, client);
      if (existing) {
        if (existing.kind !== kind || existing.revision !== revision || existing.probe_id !== (probeId ?? null)) {
          throw conflict('BACKUP_REQUEST_REUSED');
        }
        return existing;
      }
      const state = await readBackupState(client);
      const current = kind === 'disable' ? state.active_revision : state.draft_revision;
      if (current !== revision) throw kind === 'probe' ? stale() : conflict('BACKUP_REVISION_CHANGED');
      const settings = await readBackupRevision(client, current);
      if (!settings) throw conflict('BACKUP_DESTINATION_MISSING');
      if (kind === 'activate') {
        const probe = probeId ? await readCurrentBackupProbe(client, probeId, revision) : undefined;
        if (state.active_revision === revision || !probe) throw conflict('BACKUP_PROBE_REQUIRED');
        if (!backupRetentionProven(settings.destination.retentionRequest, probe.evidence)) {
          throw conflict('BACKUP_RETENTION_UNVERIFIED');
        }
      }
      const active = kind === 'activate' ? await readBackupRevision(client, state.active_revision) : null;
      if (active?.destination.offVmPolicy === 'required' && settings.destination.offVmPolicy === 'secondary') {
        throw conflict('BACKUP_REQUIRED_PROTECTION');
      }
      if (kind === 'disable' && settings.destination.offVmPolicy === 'required') {
        throw conflict('BACKUP_REQUIRED_PROTECTION');
      }
      const { rowCount: runCount } = await client.query("SELECT 1 FROM codexia_backup.runs WHERE state IN ('QUEUED', 'RUNNING')");
      if (runCount) throw conflict('BACKUP_OPERATION_IN_PROGRESS');
      if (!state.executor_live) throw new BackupConsoleError(503, 'BACKUP_EXECUTOR_UNAVAILABLE');
      if (
        kind !== 'disable' &&
        (settings.destination.credentialMode === 'sealed-access-key'
          ? !settings.key_id || !state.executor_key_ids.includes(settings.key_id)
          : state.executor_operator_origin !== settings.destination.endpoint)
      ) {
        throw conflict('BACKUP_CREDENTIAL_UNAVAILABLE');
      }
      const { rowCount } = await client.query(`SELECT 1 FROM ${scope}operations WHERE state IN ('QUEUED', 'RUNNING')`);
      if (rowCount) throw conflict('BACKUP_OPERATION_IN_PROGRESS');
      const {
        rows: [operation],
      } = await client.query<BackupOperation>(
        `INSERT INTO ${scope}operations (id, request_id, kind, revision, probe_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [randomUUID(), requestId, kind, revision, probeId ?? null],
      );
      if (!operation) throw unavailable();
      return operation;
    });
  }

  private async request(requestId: string, client: Pool | PoolClient = this.pool) {
    const {
      rows: [result],
    } = await client.query<BackupOperation>(`SELECT * FROM ${scope}operations WHERE request_id = $1`, [requestId]);
    return result ?? null;
  }

  private async mutate<T>(action: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      return await backupTransaction(client, () => action(client));
    } finally {
      client.release();
    }
  }
}

function viewRun(run: BackupRun) {
  const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
  return {
    runId: run.id,
    requestId: run.request_id,
    revision: run.revision,
    maintenanceWindowId: run.maintenance_window_id,
    status: run.state,
    phase: run.phase,
    reasonCode: run.reason_code,
    sourceSha: run.source_sha,
    imageDigest: run.image_digest,
    candidateSourceSha: run.candidate_source_sha,
    candidateImageDigest: run.candidate_image_digest,
    manifestSha256: run.manifest_sha256,
    offVmConfirmation: run.evidence,
    observedAt: iso(run.observed_at),
    createdAt: iso(run.created_at),
  };
}
