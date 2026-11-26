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

export async function backupProbeIsCurrent(client: PoolClient, id: string, revision: number) {
  const { rowCount } = await client.query(
    `SELECT 1 FROM ${scope}operations
     WHERE id = $1 AND kind = 'probe' AND state = 'PASSED' AND revision = $2
       AND observed_at > clock_timestamp() - make_interval(secs => $3)`,
    [id, revision, backupProbeLifetimeSeconds],
  );
  return rowCount === 1;
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
    } = await this.pool.query<State & { operation: Record<string, unknown> | null }>(
      `SELECT s.*, COALESCE(executor_seen_at > clock_timestamp() - interval '90 seconds', false) AS executor_live,
         CASE WHEN o.id IS NOT NULL THEN jsonb_build_object(
           'operationId', o.id, 'requestId', o.request_id, 'revision', o.revision, 'status', o.state,
           'phase', o.kind, 'reasonCode', o.reason_code, 'observedAt', o.observed_at
         ) END AS operation
       FROM ${scope}state s LEFT JOIN ${scope}operations o ON o.request_id = $1`,
      [requestId ?? null],
    );
    if (!state) throw unavailable();
    if (requestId && !state.operation) throw new BackupConsoleError(404, 'BACKUP_OPERATION_NOT_FOUND');
    return {
      activeRevision: state.active_revision,
      enabled: state.active_revision !== null,
      status: state.active_revision === null ? 'DISABLED' : 'ACTIVE',
      degraded: state.active_revision !== null && (!state.executor_live || !state.active_usable || state.active_health !== 'ready'),
      appliedAt: state.applied_at?.toISOString() ?? null,
      lastVerifiedOffVmBackup: 'unknown',
      restoreDrill: 'unknown',
      staging: 'unknown',
      ...(requestId ? { operation: state.operation } : {}),
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
      if (
        kind === 'activate' &&
        (state.active_revision === revision || !probeId || !(await backupProbeIsCurrent(client, probeId, revision)))
      ) {
        throw conflict('BACKUP_PROBE_REQUIRED');
      }
      const active = kind === 'activate' ? await readBackupRevision(client, state.active_revision) : null;
      if (active?.destination.offVmPolicy === 'required' && settings.destination.offVmPolicy === 'secondary') {
        throw conflict('BACKUP_REQUIRED_PROTECTION');
      }
      if (kind === 'disable' && settings.destination.offVmPolicy === 'required') {
        throw conflict('BACKUP_REQUIRED_PROTECTION');
      }
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
