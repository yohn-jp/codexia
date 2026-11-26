import { execFile } from 'node:child_process';
import { createPublicKey, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { allowedBackupDestination, type BackupPolicy, backupMaintenanceWindowSlot, backupPolicySchema } from './backup-console-routes.js';
import {
  type BackupOperation,
  type BackupRevision,
  type BackupRun,
  backupRetentionProven,
  backupTransaction,
  readBackupRevision,
  readBackupState,
  readCurrentBackupProbe,
} from './backup-console-store.js';
import {
  type BackupCredential,
  backupCredentialBinding,
  backupCredentialKeyId,
  type SealedBackupCredential,
} from './backup-credential-envelope.js';
import { openBackupCredential } from './backup-credential-worker.js';
import { readCodexiaEnvironment } from './environment.js';

interface ProbeEvidence {
  bucketVersioning?: 'enabled' | 'disabled' | 'suspended' | 'unknown';
  objectLock?: 'enabled' | 'disabled' | 'unknown';
  defaultRetentionDays?: number | null;
  cleanupStatus?: 'removed' | 'orphaned_unique_probe_key' | 'retained_by_policy' | 'unknown_maybe_orphaned';
}
type ProbeResult = { state: 'PASSED' | 'FAILED' | 'BLOCKED'; reason: string | null; evidence?: ProbeEvidence };
interface ExecutorOptions {
  pool: Pool;
  policy: BackupPolicy;
  privateKeys: ReadonlyMap<string, string>;
  operatorCredential?: { origin: string; credential: BackupCredential };
  probe: (revision: BackupRevision, credential: BackupCredential) => Promise<ProbeResult>;
  run?: (runId: string) => Promise<void>;
  recoverRuns?: () => Promise<void>;
  scheduleWindowId?: string;
}

const executorLock = 66502;

export class BackupConsoleExecutor {
  constructor(private readonly options: ExecutorOptions) {}

  async processNext(): Promise<boolean> {
    const { pool, privateKeys } = this.options;
    const client = await pool.connect();
    let locked = false;
    try {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [executorLock]);
      locked = rows[0]?.locked ?? false;
      if (!locked) return false;
      const operation = await backupTransaction(client, async () => {
        const { active_revision } = await readBackupState(client);
        const active = await readBackupRevision(client, active_revision);
        const usable =
          active &&
          allowedBackupDestination(active.destination, this.options.policy) &&
          (active.destination.credentialMode === 'sealed-access-key'
            ? Boolean(active.key_id && privateKeys.has(active.key_id))
            : this.options.operatorCredential?.origin === active.destination.endpoint);
        await client.query(
          `UPDATE codexia_backup.state
           SET executor_seen_at = clock_timestamp(), executor_key_ids = $1, active_usable = $2, executor_operator_origin = $3, run_executor_enabled = $4`,
          [[...privateKeys.keys()], Boolean(usable), this.options.operatorCredential?.origin ?? null, Boolean(this.options.run)],
        );
        // A surviving RUNNING row is from an interrupted worker. Never infer success.
        await client.query(
          `UPDATE codexia_backup.operations SET state = 'BLOCKED', reason_code = 'executor_interrupted',
           observed_at = clock_timestamp() WHERE state = 'RUNNING'`,
        );
        const {
          rows: [queued],
        } = await client.query<BackupOperation>(
          "SELECT * FROM codexia_backup.operations WHERE state = 'QUEUED' ORDER BY created_at, id LIMIT 1",
        );
        if (queued) await this.record(client, queued.id, 'RUNNING', null);
        return queued;
      });
      if (!operation) {
        if (!this.options.run) return false;
        try {
          await this.options.recoverRuns?.();
          // The fixed host runner acquires the host lock and repairs its durable intent first.
          // Only after it reports idle can an unjournaled worker claim be retired safely.
          await backupTransaction(client, async () => {
            await client.query(
              "UPDATE codexia_backup.runs SET state = 'FAILED', phase = 'failed', reason_code = 'runner_not_started', observed_at = clock_timestamp() WHERE kind IN ('manual', 'scheduled') AND state = 'RUNNING' AND phase = 'starting'",
            );
            await client.query(
              "UPDATE codexia_backup.runs SET state = 'UNKNOWN', phase = 'recovery_required', reason_code = 'runner_recovery_unresolved', observed_at = clock_timestamp() WHERE kind IN ('manual', 'scheduled') AND state = 'RUNNING' AND phase <> 'starting'",
            );
          });
        } catch {
          return false;
        }
        if (this.options.scheduleWindowId) {
          await backupTransaction(client, async () => {
            const slot = backupMaintenanceWindowSlot(this.options.policy, this.options.scheduleWindowId!);
            if (!slot?.open) return;
            const {
              rows: [state],
            } = await client.query<{ active_revision: number | null; active_usable: boolean }>(
              'SELECT active_revision, active_usable FROM codexia_backup.state',
            );
            const { rowCount: operationCount } = await client.query(
              "SELECT 1 FROM codexia_backup.operations WHERE state IN ('QUEUED', 'RUNNING')",
            );
            const { rowCount: runCount } = await client.query("SELECT 1 FROM codexia_backup.runs WHERE state IN ('QUEUED', 'RUNNING')");
            if (operationCount || runCount) return;
            const stateValue = !state?.active_revision ? 'BLOCKED' : state.active_usable ? 'QUEUED' : 'BLOCKED';
            const reason = !state?.active_revision
              ? 'active_destination_missing'
              : state.active_usable
                ? null
                : 'active_destination_unavailable';
            await client.query(
              `INSERT INTO codexia_backup.runs (id, request_id, kind, revision, maintenance_window_id, schedule_slot_key, state, phase, reason_code)
               VALUES ($1, $2, 'scheduled', $3, $4, $5, $6, $7, $8) ON CONFLICT (schedule_slot_key) DO NOTHING`,
              [
                randomUUID(),
                `schedule:${this.options.scheduleWindowId}:${slot.localDate}`,
                state?.active_revision ?? null,
                this.options.scheduleWindowId,
                slot.slotKey,
                stateValue,
                stateValue === 'QUEUED' ? 'queued' : 'blocked',
                reason,
              ],
            );
          });
        }
        const run = await backupTransaction(client, async () => {
          const {
            rows: [queued],
          } = await client.query<BackupRun>(
            "SELECT * FROM codexia_backup.runs WHERE state = 'QUEUED' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED",
          );
          if (!queued) return null;
          await client.query(
            "UPDATE codexia_backup.runs SET state = 'RUNNING', phase = 'starting', reason_code = NULL, observed_at = clock_timestamp() WHERE id = $1",
            [queued.id],
          );
          return queued;
        });
        if (!run) return false;
        try {
          await this.options.run(run.id);
        } catch (error) {
          const code = (error as { code?: string | number }).code;
          await backupTransaction(client, async () => {
            if (code === 75 || code === '75') {
              const {
                rows: [current],
              } = await client.query<{ state: string }>('SELECT state FROM codexia_backup.runs WHERE id = $1', [run.id]);
              if (current?.state === 'RUNNING')
                await client.query(
                  "UPDATE codexia_backup.runs SET state = 'QUEUED', phase = 'queued', reason_code = 'host_lock_busy', observed_at = clock_timestamp() WHERE id = $1 AND state = 'RUNNING'",
                  [run.id],
                );
            } else {
              await client.query(
                "UPDATE codexia_backup.runs SET state = 'UNKNOWN', phase = 'recovery_required', reason_code = 'runner_interrupted', observed_at = clock_timestamp() WHERE id = $1 AND state = 'RUNNING'",
                [run.id],
              );
            }
          });
          return true;
        }
        const {
          rows: [result],
        } = await client.query<{ state: string }>('SELECT state FROM codexia_backup.runs WHERE id = $1', [run.id]);
        if (result?.state === 'RUNNING') {
          await client.query(
            "UPDATE codexia_backup.runs SET state = 'UNKNOWN', phase = 'recovery_required', reason_code = 'receipt_missing', observed_at = clock_timestamp() WHERE id = $1 AND state = 'RUNNING'",
            [run.id],
          );
        }
        return true;
      }
      const revision = await readBackupRevision(client, operation.revision);
      const before = await this.blockedReason(client, operation, revision);
      const verdict = before
        ? { state: 'BLOCKED' as const, reason: before }
        : operation.kind === 'disable'
          ? { state: 'PASSED' as const, reason: null }
          : await this.runProbe(client, revision!);
      await backupTransaction(client, async () => {
        const after = await this.blockedReason(client, operation, revision);
        const evidence = 'evidence' in verdict ? verdict.evidence : undefined;
        const retentionProven = backupRetentionProven(revision?.destination.retentionRequest, evidence);
        const blocked =
          after ?? (operation.kind === 'activate' && !retentionProven && verdict.state === 'PASSED' ? 'retention_unverified' : null);
        if (blocked || verdict.state !== 'PASSED' || operation.kind === 'probe') {
          if (!blocked && operation.kind === 'probe') {
            await client.query('UPDATE codexia_backup.state SET active_health = $1 WHERE active_revision = $2', [
              verdict.state === 'PASSED' ? 'ready' : 'degraded',
              operation.revision,
            ]);
          }
          await this.record(client, operation.id, blocked ? 'BLOCKED' : verdict.state, blocked ?? verdict.reason, evidence);
          return;
        }
        // The executor owns the applied pointer. Commit the result and the pointer together.
        await client.query(
          `UPDATE codexia_backup.state SET active_revision = $1, applied_at = clock_timestamp(),
           active_health = $2, active_usable = ($1::integer IS NOT NULL)`,
          operation.kind === 'activate' ? [operation.revision, 'ready'] : [null, 'unknown'],
        );
        await this.record(client, operation.id, 'APPLIED', null, evidence);
      });
      return true;
    } finally {
      let discard = false;
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [executorLock]);
        } catch {
          discard = true;
        }
      }
      client.release(discard);
    }
  }

  private async blockedReason(client: PoolClient, operation: BackupOperation, revision: BackupRevision | null) {
    if (!revision) return 'revision_missing';
    const state = await readBackupState(client);
    if (operation.kind === 'disable') {
      if (state.active_revision !== operation.revision) return 'revision_changed';
      return revision.destination.offVmPolicy === 'required' ? 'required_protection' : null;
    }
    if (state.draft_revision !== operation.revision) return 'revision_changed';
    if (!allowedBackupDestination(revision.destination, this.options.policy)) return 'destination_not_allowed';
    if (operation.kind === 'activate') {
      if (state.active_revision === operation.revision) return 'already_applied';
      const active = await readBackupRevision(client, state.active_revision);
      if (active?.destination.offVmPolicy === 'required' && revision.destination.offVmPolicy === 'secondary') {
        return 'required_protection';
      }
      if (!operation.probe_id || !(await readCurrentBackupProbe(client, operation.probe_id, operation.revision))) {
        return 'probe_expired';
      }
    }
    return null;
  }

  private async runProbe(client: PoolClient, revision: BackupRevision): Promise<ProbeResult> {
    const { operatorCredential, privateKeys } = this.options;
    let credential = operatorCredential?.origin === revision.destination.endpoint ? operatorCredential.credential : undefined;
    if (revision.destination.credentialMode === 'sealed-access-key') {
      const key = revision.key_id ? privateKeys.get(revision.key_id) : undefined;
      if (!key || !revision.credential_id) return { state: 'BLOCKED', reason: 'worker_key_unavailable' };
      const {
        rows: [record],
      } = await client.query<{ envelope: SealedBackupCredential }>('SELECT envelope FROM codexia_backup.credentials WHERE id = $1', [
        revision.credential_id,
      ]);
      try {
        if (!record || record.envelope.keyId !== revision.key_id) return { state: 'BLOCKED', reason: 'credential_unavailable' };
        credential = openBackupCredential(key, record.envelope, backupCredentialBinding(revision.destination));
      } catch {
        return { state: 'BLOCKED', reason: 'credential_unavailable' };
      }
    }
    if (!credential) return { state: 'BLOCKED', reason: 'credential_unavailable' };
    return this.options.probe(revision, credential);
  }

  private record(client: PoolClient, id: string, state: BackupOperation['state'], reason: string | null, evidence?: ProbeEvidence) {
    return client.query(
      'UPDATE codexia_backup.operations SET state = $2, reason_code = $3, evidence = $4, observed_at = clock_timestamp() WHERE id = $1',
      [id, state, reason, evidence ?? null],
    );
  }
}

export function protectedBackupRunner(executable: string, timeoutMs = 30 * 60_000) {
  if (!isAbsolute(executable)) throw new Error('Backup runner must be an absolute operator-provisioned path');
  const environment: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: process.env.HOME ?? '/home/codexia',
    ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
    ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
    ...(process.env.CODEXIA_BACKUP_DESTINATION ? { CODEXIA_BACKUP_DESTINATION: process.env.CODEXIA_BACKUP_DESTINATION } : {}),
    ...(process.env.CODEXIA_BACKUP_AGE_RECIPIENT ? { CODEXIA_BACKUP_AGE_RECIPIENT: process.env.CODEXIA_BACKUP_AGE_RECIPIENT } : {}),
  };
  const invoke = (args: string[]) =>
    new Promise<void>((resolveRun, rejectRun) => {
      execFile(
        executable,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 4096,
          killSignal: 'SIGKILL',
          env: environment,
        },
        error => {
          if (error) rejectRun(error);
          else resolveRun();
        },
      );
    });
  return {
    run: (runId: string) => invoke([runId]),
    recover: () => invoke(['recover']),
  };
}

const probeReasons = z.enum([
  'access_denied',
  'transport_failed',
  'transport_unavailable',
  'invalid_destination',
  'bucket_not_allowed',
  'prefix_not_allowed',
  'endpoint_not_allowed',
  'readback_failed',
  'readback_mismatch',
  'cleanup_failed',
  'orphaned_unique_probe_key',
  'credentials_unavailable',
  'invalid_credentials',
  'destination_not_allowed',
  'invalid_operator_policy',
  'destination_policy_unavailable',
  'invalid_retention_request',
  'redirect_rejected',
  'dns_validation_failed',
  'egress_policy_blocked',
]);
const probeResponse = z.object({
  status: z.enum(['PASSED', 'FAILED', 'BLOCKED']),
  reasonCode: probeReasons.nullable(),
  cleanupStatus: z.enum(['removed', 'orphaned_unique_probe_key', 'retained_by_policy', 'unknown_maybe_orphaned']).optional(),
  bucketVersioning: z.enum(['enabled', 'disabled', 'suspended', 'unknown']).optional(),
  objectLock: z.enum(['enabled', 'disabled', 'unknown']).optional(),
  defaultRetentionDays: z.number().int().nonnegative().nullable().optional(),
});

const transportConfig = z.strictObject({
  caBundle: z.string().optional(),
  allowedPrivateAddresses: z.array(z.string()).optional(),
  allowProbeCleanup: z.boolean().optional(),
});

export function pythonBackupProbe(
  python: string,
  script: string,
  policy: BackupPolicy,
  transportByOrigin: Readonly<Record<string, z.infer<typeof transportConfig>>> = {},
): ExecutorOptions['probe'] {
  return (revision, credential) =>
    new Promise(resolveResult => {
      const { destination } = revision;
      const aws = destination.provider === 'aws-s3';
      const child = execFile(
        python,
        [script],
        {
          timeout: 45_000,
          maxBuffer: 8192,
          killSignal: 'SIGKILL',
          env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1', LANG: 'C.UTF-8' },
        },
        (error, stdout) => {
          try {
            const result = probeResponse.parse(JSON.parse(stdout));
            const { cleanupStatus, bucketVersioning, objectLock, defaultRetentionDays } = result;
            const evidence = { cleanupStatus, bucketVersioning, objectLock, defaultRetentionDays };
            if (result.status === 'PASSED' && !error) {
              resolveResult({
                state: 'PASSED',
                reason: cleanupStatus === 'orphaned_unique_probe_key' ? cleanupStatus : null,
                evidence,
              });
              return;
            }
            const reason = result.reasonCode ?? 'transport_failed';
            const blocked = ['redirect_rejected', 'dns_validation_failed', 'egress_policy_blocked', 'destination_not_allowed'].includes(
              reason,
            );
            resolveResult({ state: result.status === 'BLOCKED' || blocked ? 'BLOCKED' : 'FAILED', reason, evidence });
          } catch {
            resolveResult({ state: 'FAILED', reason: 'transport_failed' });
          }
        },
      );
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(
        JSON.stringify({
          draft: { ...destination, endpoint: aws ? null : destination.endpoint, addressingStyle: aws ? 'virtual' : 'path', credential },
          operatorPolicy: {
            destinations: policy.destinations.map(rule => {
              const origin = rule.provider === 'aws-s3' ? `https://s3.${rule.region}.amazonaws.com` : rule.endpoint;
              return {
                ...(origin ? transportByOrigin[origin] : undefined),
                provider: rule.provider,
                bucket: rule.bucket,
                prefix: rule.prefix,
                origin,
              };
            }),
          },
        }),
      );
    });
}

export async function readPrivateBackupFile(path: string) {
  if (!isAbsolute(path)) throw new Error('Executor secrets must be protected files');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || ![0o400, 0o600].includes(metadata.mode & 0o777)) {
      throw new Error('Executor secrets must be protected files');
    }
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

export const backupExecutorConfigSchema = z.strictObject({
  privateKeyFiles: z.array(z.string()).max(8).default([]),
  operatorCredential: z
    .strictObject({
      origin: z.string().url(),
      accessKeyId: z.string().min(1).max(128),
      secretAccessKey: z.string().min(1).max(256),
      sessionToken: z.string().min(1).max(4096).optional(),
    })
    .optional(),
  transportByOrigin: z.record(z.string().url(), transportConfig).default({}),
});

async function main() {
  const databaseUrl = readCodexiaEnvironment('BACKUP_EXECUTOR_DATABASE_URL');
  const policyFile = readCodexiaEnvironment('BACKUP_POLICY_FILE');
  const configFile = readCodexiaEnvironment('BACKUP_EXECUTOR_CONFIG_FILE');
  const python = readCodexiaEnvironment('BACKUP_PYTHON');
  const script = readCodexiaEnvironment('BACKUP_PROBE_SCRIPT');
  const runnerPath = readCodexiaEnvironment('BACKUP_RUNNER');
  if (!databaseUrl || !policyFile || !configFile || !python || !script || !isAbsolute(python) || !isAbsolute(script)) {
    throw new Error('Backup executor settings are incomplete');
  }
  const policy = backupPolicySchema.parse(JSON.parse(await readFile(policyFile, 'utf8')));
  const config = backupExecutorConfigSchema.parse(JSON.parse(await readPrivateBackupFile(configFile)));
  const keys = new Map<string, string>();
  for (const path of config.privateKeyFiles) {
    const pem = await readPrivateBackupFile(path);
    if (!/^-----BEGIN (RSA )?PRIVATE KEY-----/u.test(pem)) throw new Error('Invalid executor private key');
    keys.set(backupCredentialKeyId(createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString()), pem);
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 8_000 });
  pool.on('error', () => undefined);
  const credential = config.operatorCredential;
  const worker = new BackupConsoleExecutor({
    pool,
    policy,
    privateKeys: keys,
    ...(credential
      ? {
          operatorCredential: {
            origin: credential.origin,
            credential: {
              accessKeyId: credential.accessKeyId,
              secretAccessKey: credential.secretAccessKey,
              ...(credential.sessionToken ? { sessionToken: credential.sessionToken } : {}),
            },
          },
        }
      : {}),
    probe: pythonBackupProbe(python, script, policy, config.transportByOrigin),
    ...(runnerPath ? { ...protectedBackupRunner(runnerPath), scheduleWindowId: policy.scheduleWindowId } : {}),
  });
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
  try {
    while (!stop.signal.aborted) {
      try {
        if (await worker.processNext()) continue;
      } catch {
        process.stderr.write('Backup control plane executor could not process the queue.\n');
      }
      await setTimeout(2000, undefined, { signal: stop.signal }).catch(() => undefined);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch(() => {
    process.stderr.write('Backup control plane executor could not start.\n');
    process.exitCode = 1;
  });
}
