import { execFile } from 'node:child_process';
import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { z } from 'zod';
import {
  backupExecutorConfigSchema,
  backupExecutorLock,
  readPrivateBackupFile,
  restoredBackupUnknownReason,
} from './backup-console-executor.js';
import { allowedBackupDestination, allowedBackupMaintenanceWindow, backupPolicySchema } from './backup-console-routes.js';
import { backupTransaction } from './backup-console-store.js';
import {
  type BackupCredential,
  backupCredentialBinding,
  backupCredentialKeyId,
  type SealedBackupCredential,
} from './backup-credential-envelope.js';
import { openBackupCredential } from './backup-credential-worker.js';
import { readCodexiaEnvironment } from './environment.js';

const execute = promisify(execFile);
const uuid = z.uuid();
const sourceShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const imageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const manifestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const transferReceiptSchema = z.object({
  format: z.literal('codexia-backup-receipt/v1'),
  backupId: uuid,
  sourceIdentity: sourceShaSchema,
  sha256sumsSha256: manifestSchema,
  markerSha256: manifestSchema,
  verifiedAt: z.string().datetime({ offset: true }),
});
class RetryableControlError extends Error {
  readonly code = 75;
  constructor(readonly reasonCode: string) {
    super('Backup operation requires safe retry');
  }
}
class TerminalControlError extends Error {
  readonly code = 1;
}
class S3TransferFailure extends Error {
  constructor(
    readonly reasonCode: string,
    readonly retryable: boolean,
  ) {
    super('S3 transfer did not produce a verified receipt');
  }
}

interface Revision {
  revision: number;
  destination: {
    provider: 'aws-s3' | 's3-compatible';
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    addressing: 'path-style' | 'virtual-hosted-style';
    credentialMode: 'operator-role' | 'sealed-access-key';
    offVmPolicy: 'required' | 'secondary';
    schedule: 'disabled';
  };
  credential_id: string | null;
  key_id: string | null;
}
export class BackupConsoleControl {
  constructor(
    private readonly options: {
      pool: Pool;
      policy: z.infer<typeof backupPolicySchema>;
      config: z.infer<typeof backupExecutorConfigSchema>;
      python: string;
      transferScript: string;
      receiptDirectory: string;
      backupScript: string;
      independentMount?: string;
    },
  ) {}

  async deployStart(runId: string, sourceSha: string, imageDigest: string, candidateSha: string, candidateDigest: string) {
    this.validateStart(runId, sourceSha, imageDigest, candidateSha, candidateDigest);
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(66501)');
      const {
        rows: [existing],
      } = await client.query<{
        id: string;
        source_sha: string | null;
        image_digest: string | null;
        candidate_source_sha: string;
        candidate_image_digest: string;
      }>(
        "SELECT id, source_sha, image_digest, candidate_source_sha, candidate_image_digest FROM codexia_backup.runs WHERE id = $1 AND kind = 'deploy'",
        [runId],
      );
      if (existing) {
        if (
          existing.source_sha !== sourceSha ||
          existing.image_digest !== imageDigest ||
          existing.candidate_source_sha !== candidateSha ||
          existing.candidate_image_digest !== candidateDigest
        )
          throw new Error('Deployment run identity was reused');
        await client.query('COMMIT');
        return existing.id;
      }
      const {
        rows: [state],
      } = await client.query<{ active_revision: number | null; active_usable: boolean; active_health: string }>(
        'SELECT active_revision, active_usable, active_health FROM codexia_backup.state',
      );
      if (!state?.active_revision) throw new Error('Active off-VM backup destination is unavailable');
      const revision = await this.readRevision(client, state.active_revision);
      if (!revision || !allowedBackupDestination(revision.destination, this.options.policy))
        throw new Error('Active off-VM backup destination is unavailable');
      if (revision.destination.offVmPolicy === 'required' && (!state.active_usable || state.active_health !== 'ready'))
        throw new Error('Required off-VM backup destination is unavailable');
      const credential = await this.credential(client, revision);
      if (!credential && revision.destination.offVmPolicy === 'required')
        throw new Error('Required off-VM backup credential is unavailable');
      const { rowCount: operationCount } = await client.query(
        "SELECT 1 FROM codexia_backup.operations WHERE state IN ('QUEUED', 'RUNNING')",
      );
      if (operationCount) throw new Error('Backup configuration operation is in progress');
      const { rowCount } = await client.query(
        "SELECT 1 FROM codexia_backup.runs WHERE state IN ('QUEUED', 'RUNNING') OR (state = 'UNKNOWN' AND reason_code = $1)",
        [restoredBackupUnknownReason],
      );
      if (rowCount) throw new Error('Another backup run requires recovery');
      await client.query(
        `INSERT INTO codexia_backup.runs (id, request_id, kind, revision, source_sha, image_digest, candidate_source_sha, candidate_image_digest, state, phase)
         VALUES ($1, $2, 'deploy', $3, $4, $5, $6, $7, 'RUNNING', 'admission')`,
        [runId, 'deploy:' + runId, revision.revision, sourceSha, imageDigest, candidateSha, candidateDigest],
      );
      await client.query('COMMIT');
      return runId;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async manualStart(runId: string, sourceSha: string, imageDigest: string) {
    if (
      !uuid.safeParse(runId).success ||
      !sourceShaSchema.safeParse(sourceSha).success ||
      !imageDigestSchema.safeParse(imageDigest).success
    )
      throw new Error('Manual run identity is invalid');
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(66501)');
      const {
        rows: [run],
      } = await client.query<{
        revision: number;
        maintenance_window_id: string;
        kind: 'manual' | 'scheduled';
        state: string;
        source_sha: string | null;
        image_digest: string | null;
      }>(
        "SELECT revision, maintenance_window_id, kind, state, source_sha, image_digest FROM codexia_backup.runs WHERE id = $1 AND kind IN ('manual', 'scheduled') FOR UPDATE",
        [runId],
      );
      if (!run || !['QUEUED', 'RUNNING'].includes(run.state)) throw new Error('Manual run is not claimable');
      if (run.kind === 'scheduled' && this.options.policy.scheduleWindowId !== run.maintenance_window_id)
        throw new Error('Scheduled backup is not operator-enabled');
      if (!allowedBackupMaintenanceWindow(this.options.policy, run.maintenance_window_id)) throw new Error('Maintenance window is closed');
      const {
        rows: [state],
      } = await client.query<{ active_revision: number | null }>('SELECT active_revision FROM codexia_backup.state');
      if (state?.active_revision !== run.revision) throw new Error('Active backup revision changed');
      if (run.source_sha && (run.source_sha !== sourceSha || run.image_digest !== imageDigest))
        throw new Error('Manual run source identity changed');
      await client.query(
        "UPDATE codexia_backup.runs SET state = 'RUNNING', phase = 'quiescing', source_sha = $2, image_digest = $3, reason_code = NULL, observed_at = clock_timestamp() WHERE id = $1",
        [runId, sourceSha, imageDigest],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async finish(runId: string, artifactDirectory: string, expectedManifestSha: string, kind: 'manual' | 'scheduled' | 'deploy') {
    if (!uuid.safeParse(runId).success || !isAbsolute(artifactDirectory) || !manifestSchema.safeParse(expectedManifestSha).success)
      throw new Error('Backup receipt input is invalid');
    const client = await this.options.pool.connect();
    try {
      const kindClause = kind === 'manual' || kind === 'scheduled' ? "kind IN ('manual', 'scheduled')" : "kind = 'deploy'";
      const {
        rows: [run],
      } = await client.query<{
        revision: number | null;
        state: string;
        source_sha: string | null;
        manifest_sha256: string | null;
        evidence: Record<string, unknown> | null;
      }>(`SELECT revision, state, source_sha, manifest_sha256, evidence FROM codexia_backup.runs WHERE id = $1 AND ${kindClause}`, [runId]);
      if (!run || !run.revision || !run.source_sha) throw new Error('Backup run is not eligible to finish');
      if (
        run.manifest_sha256 === expectedManifestSha &&
        (run.state === 'REMOTE_VERIFIED' || (run.state === 'FAILED' && run.evidence?.offVmMethod === 'independent_mount'))
      )
        return;
      if (run.state !== 'RUNNING' && !((kind === 'manual' || kind === 'scheduled') && run.state === 'UNKNOWN'))
        throw new Error('Backup run is not eligible to finish');
      const revision = await this.readRevision(client, run.revision);
      if (!revision || !allowedBackupDestination(revision.destination, this.options.policy))
        throw new Error('Pinned backup destination is unavailable');
      const sums = await readFile(join(artifactDirectory, 'SHA256SUMS'));
      const sumsSha = createHash('sha256').update(sums).digest('hex');
      if (sumsSha !== expectedManifestSha || (run.manifest_sha256 !== null && run.manifest_sha256 !== sumsSha)) {
        await client.query(
          "UPDATE codexia_backup.runs SET state = 'FAILED', phase = 'failed', reason_code = 'manifest_digest_mismatch', observed_at = clock_timestamp() WHERE id = $1 AND state IN ('RUNNING', 'UNKNOWN')",
          [runId],
        );
        throw new Error('Backup manifest digest differs from the runner receipt');
      }
      const { rowCount: pinned } = await client.query(
        "UPDATE codexia_backup.runs SET manifest_sha256 = $2, phase = 'transferring', observed_at = clock_timestamp() WHERE id = $1 AND state IN ('RUNNING', 'UNKNOWN') AND (manifest_sha256 IS NULL OR manifest_sha256 = $2)",
        [runId, sumsSha],
      );
      if (pinned !== 1) throw new Error('Backup manifest digest could not be pinned');
      const credential = await this.credential(client, revision);
      let evidence: Record<string, unknown>;
      let finalState: 'REMOTE_VERIFIED' | 'FAILED' = 'REMOTE_VERIFIED';
      let reasonCode: string | null = null;
      try {
        if (!credential) throw new Error('Pinned backup credential is unavailable');
        const transfer = await this.upload(runId, artifactDirectory, run.source_sha, sumsSha, revision, credential);
        evidence = {
          offVmMethod: 's3',
          backupId: runId,
          markerSha256: transfer.markerSha256,
          receiptSha256: transfer.receiptSha256,
          manifestSha256: sumsSha,
          verifiedAt: transfer.verifiedAt,
        };
      } catch (error) {
        const s3Failure = error instanceof S3TransferFailure ? error : new S3TransferFailure('transfer_failed', true);
        const secondaryMount = revision.destination.offVmPolicy === 'secondary' ? this.options.independentMount : undefined;
        const independentVerified = secondaryMount && (await this.verifyIndependentArtifact(secondaryMount, artifactDirectory, sumsSha));
        if (!independentVerified) {
          const failedState = s3Failure.retryable ? 'UNKNOWN' : 'FAILED';
          const reason = secondaryMount && !s3Failure.retryable ? 'independent_artifact_invalid' : s3Failure.reasonCode;
          await client.query(
            "UPDATE codexia_backup.runs SET state = $2, phase = $3, reason_code = $4, observed_at = clock_timestamp() WHERE id = $1 AND state IN ('RUNNING', 'UNKNOWN')",
            [runId, failedState, s3Failure.retryable ? 'recovery_required' : 'failed', reason],
          );
          if (s3Failure.retryable) throw new RetryableControlError(reason);
          throw new Error(
            secondaryMount
              ? 'S3 and independent artifact verification failed'
              : revision.destination.offVmPolicy === 'required'
                ? 'Required S3 ciphertext readback failed'
                : 'S3 backup failed and no secondary protection is configured',
          );
        }
        finalState = 'FAILED';
        reasonCode = s3Failure.reasonCode;
        evidence = {
          offVmMethod: 'independent_mount',
          independentArtifactSha256: sumsSha,
          s3Status: 'failed',
          s3ReasonCode: s3Failure.reasonCode,
        };
      }
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(66501)');
      const { rowCount } = await client.query(
        "UPDATE codexia_backup.runs SET state = $5, phase = 'complete', reason_code = $6, manifest_sha256 = $2, evidence = $3, observed_at = clock_timestamp() WHERE id = $1 AND state IN ('RUNNING', 'UNKNOWN') AND (($4 = 'deploy' AND kind = 'deploy') OR ($4 <> 'deploy' AND kind IN ('manual', 'scheduled')))",
        [runId, sumsSha, evidence, kind, finalState, reasonCode],
      );
      if (rowCount !== 1) throw new Error('Backup receipt could not be committed');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async verifyIndependentArtifact(mountPath: string, artifactDirectory: string, manifestSha: string): Promise<boolean> {
    try {
      const mount = await realpath(mountPath);
      const artifact = await realpath(artifactDirectory);
      if (dirname(artifact) !== mount) return false;
      const { stdout } = await execute(this.options.backupScript, ['validate-independent-artifact', mount, artifact], {
        timeout: 15_000,
        maxBuffer: 1024,
        killSignal: 'SIGKILL',
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      });
      return stdout === manifestSha || stdout === manifestSha + '\n';
    } catch {
      return false;
    }
  }

  async terminate(runId: string, kind: 'manual' | 'deploy', state: 'FAILED' | 'UNKNOWN', reasonCode: string) {
    if (!uuid.safeParse(runId).success || !/^[a-z][a-z0-9_]{1,63}$/u.test(reasonCode))
      throw new Error('Backup run termination input is invalid');
    await this.options.pool.query(
      `UPDATE codexia_backup.runs SET state = $3, phase = CASE WHEN $3 = 'UNKNOWN' THEN 'recovery_required' ELSE 'failed' END,
       reason_code = $4, observed_at = clock_timestamp() WHERE id = $1 AND (($2 = 'deploy' AND kind = 'deploy') OR ($2 <> 'deploy' AND kind IN ('manual', 'scheduled'))) AND state IN ('QUEUED', 'RUNNING', 'UNKNOWN')`,
      [runId, kind, state, reasonCode],
    );
  }

  async deployInterrupted(runId: string) {
    await this.terminate(runId, 'deploy', 'UNKNOWN', 'deployment_interrupted');
  }
  async manualInterrupted(runId: string) {
    await this.terminate(runId, 'manual', 'UNKNOWN', 'manual_interrupted');
  }
  async deployFail(runId: string, reason: string) {
    await this.terminate(runId, 'deploy', 'FAILED', reason);
  }
  async manualFail(runId: string, reason: string) {
    await this.terminate(runId, 'manual', 'FAILED', reason);
  }

  async recordRestore(runId: string, receiptPath: string) {
    if (!uuid.safeParse(runId).success || !isAbsolute(receiptPath)) throw new Error('Restore receipt input is invalid');
    const receiptBytes = await readPrivateBackupFile(receiptPath);
    const receipt = z
      .strictObject({
        format: z.literal('codexia-restore-receipt/v1'),
        checksumManifestSha256: manifestSchema,
        readyImageDigest: imageDigestSchema.optional(),
        verifiedLedger: imageDigestSchema.optional(),
      })
      .refine(value => Boolean(value.readyImageDigest) === Boolean(value.verifiedLedger))
      .parse(JSON.parse(receiptBytes));
    const {
      rows: [run],
    } = await this.options.pool.query<{
      source_sha: string | null;
      image_digest: string | null;
      manifest_sha256: string | null;
      state: string;
    }>(
      'SELECT source_sha, COALESCE(image_digest, candidate_image_digest) AS image_digest, manifest_sha256, state FROM codexia_backup.runs WHERE id = $1',
      [runId],
    );
    if (
      !run?.source_sha ||
      !run.manifest_sha256 ||
      run.manifest_sha256 !== receipt.checksumManifestSha256 ||
      run.state !== 'REMOTE_VERIFIED'
    ) {
      throw new Error('Restore receipt does not match a remotely verified source run');
    }
    if (receipt.readyImageDigest && receipt.readyImageDigest !== run.image_digest) {
      throw new Error('Restore readiness receipt identifies a different backup source image');
    }
    const receiptSha = createHash('sha256').update(receiptBytes).digest('hex');
    await this.options.pool.query(
      `INSERT INTO codexia_backup.restore_drills (id, run_id, source_sha, manifest_sha256, receipt_sha256, api_ready)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (run_id, receipt_sha256) DO NOTHING`,
      [randomUUID(), runId, run.source_sha, receipt.checksumManifestSha256, receiptSha, Boolean(receipt.readyImageDigest)],
    );
  }

  async reconcileRestoredJournal(receiptPath: string, approvedReceiptSha: string, executorFenceSha: string): Promise<void> {
    if (!isAbsolute(receiptPath)) throw new Error('Restore transfer receipt path must be absolute');
    manifestSchema.parse(approvedReceiptSha);
    manifestSchema.parse(executorFenceSha);
    const bytes = await readPrivateBackupFile(receiptPath);
    if (createHash('sha256').update(bytes).digest('hex') !== approvedReceiptSha) {
      throw new Error('Restore transfer receipt digest does not match the approved evidence');
    }
    const receipt = transferReceiptSchema.parse(JSON.parse(bytes));
    const client = await this.options.pool.connect();
    try {
      await backupTransaction(client, async () => {
        const {
          rows: [lock],
        } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [backupExecutorLock]);
        if (!lock?.locked) throw new Error('Backup executor must stop before restoring the journal');
        const {
          rows: [selected],
        } = await client.query<{
          state: string;
          source_sha: string | null;
          manifest_sha256: string | null;
          evidence: Record<string, unknown> | null;
        }>('SELECT state, source_sha, manifest_sha256, evidence FROM codexia_backup.runs WHERE id = $1 FOR UPDATE', [receipt.backupId]);
        if (
          !selected ||
          selected.source_sha !== receipt.sourceIdentity ||
          (selected.manifest_sha256 !== null && selected.manifest_sha256 !== receipt.sha256sumsSha256)
        ) {
          throw new Error('Restore transfer receipt does not match the selected journal run');
        }
        if (selected.state === 'REMOTE_VERIFIED') {
          if (selected.evidence?.receiptSha256 !== approvedReceiptSha || selected.evidence?.executorFenceSha256 !== executorFenceSha) {
            throw new Error('Restored journal was reconciled against different evidence');
          }
          return;
        }
        if (selected.state !== 'RUNNING' && selected.state !== 'UNKNOWN') throw new Error('Restored journal run cannot be reconciled');
        await client.query(
          `UPDATE codexia_backup.runs SET state = 'REMOTE_VERIFIED', phase = 'complete', reason_code = NULL,
             manifest_sha256 = $2, evidence = $3, observed_at = clock_timestamp() WHERE id = $1`,
          [
            receipt.backupId,
            receipt.sha256sumsSha256,
            {
              offVmMethod: 's3',
              backupId: receipt.backupId,
              markerSha256: receipt.markerSha256,
              manifestSha256: receipt.sha256sumsSha256,
              receiptSha256: approvedReceiptSha,
              verifiedAt: receipt.verifiedAt,
              executorFenceSha256: executorFenceSha,
            },
          ],
        );
        await client.query(
          `UPDATE codexia_backup.runs SET state = 'BLOCKED', phase = 'blocked',
             reason_code = 'restored_request_not_replayed', observed_at = clock_timestamp() WHERE state = 'QUEUED'`,
        );
        await client.query(
          `UPDATE codexia_backup.runs SET state = 'UNKNOWN', phase = 'recovery_required', reason_code = $1,
             evidence = COALESCE(evidence, '{}'::jsonb) || jsonb_build_object('restoredReasonCode', reason_code),
             observed_at = clock_timestamp() WHERE state IN ('RUNNING', 'UNKNOWN')`,
          [restoredBackupUnknownReason],
        );
        await client.query(
          `UPDATE codexia_backup.operations SET state = 'BLOCKED', reason_code = 'restored_request_not_replayed',
             observed_at = clock_timestamp() WHERE state IN ('QUEUED', 'RUNNING')`,
        );
        await client.query('UPDATE codexia_backup.state SET active_usable = false, run_executor_enabled = false, executor_seen_at = NULL');
      });
    } finally {
      client.release();
    }
  }

  private validateStart(runId: string, sourceSha: string, imageDigest: string, candidateSha: string, candidateDigest: string) {
    if (
      !uuid.safeParse(runId).success ||
      !sourceShaSchema.safeParse(sourceSha).success ||
      !imageDigestSchema.safeParse(imageDigest).success ||
      !sourceShaSchema.safeParse(candidateSha).success ||
      !imageDigestSchema.safeParse(candidateDigest).success
    )
      throw new Error('Deployment identity is invalid');
  }

  private async readRevision(client: import('pg').PoolClient, revision: number) {
    const {
      rows: [row],
    } = await client.query<Revision>('SELECT * FROM codexia_backup.revisions WHERE revision = $1', [revision]);
    return row ?? null;
  }

  private async credential(client: import('pg').PoolClient, revision: Revision): Promise<BackupCredential | null> {
    const { destination } = revision;
    if (destination.credentialMode === 'operator-role') {
      const value = this.options.config.operatorCredential;
      return value?.origin === destination.endpoint
        ? {
            accessKeyId: value.accessKeyId,
            secretAccessKey: value.secretAccessKey,
            ...(value.sessionToken ? { sessionToken: value.sessionToken } : {}),
          }
        : null;
    }
    if (!revision.key_id || !revision.credential_id) return null;
    const {
      rows: [record],
    } = await client.query<{ envelope: SealedBackupCredential }>('SELECT envelope FROM codexia_backup.credentials WHERE id = $1', [
      revision.credential_id,
    ]);
    for (const file of this.options.config.privateKeyFiles) {
      const pem = await readPrivateBackupFile(file);
      if (backupCredentialKeyId(createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString()) !== revision.key_id) continue;
      try {
        return openBackupCredential(pem, record.envelope, backupCredentialBinding(destination));
      } catch {
        return null;
      }
    }
    return null;
  }

  private async upload(
    runId: string,
    artifactDirectory: string,
    sourceSha: string,
    expectedManifestSha: string,
    revision: Revision,
    credential: BackupCredential,
  ) {
    const { destination } = revision;
    const origin = destination.provider === 's3-compatible' ? destination.endpoint : undefined;
    const profile = {
      schemaVersion: 1,
      provider: destination.provider,
      region: destination.region,
      bucket: destination.bucket,
      prefix: destination.prefix,
      endpointUrl: origin ?? null,
      allowedOrigins: origin ? [origin] : [],
      addressingStyle: destination.addressing === 'path-style' ? 'path' : 'virtual',
      ...(origin && this.options.config.transportByOrigin[origin]?.caBundle
        ? { caBundle: this.options.config.transportByOrigin[origin].caBundle }
        : {}),
      ...(origin && this.options.config.transportByOrigin[origin]?.allowedPrivateAddresses
        ? { allowedPrivateAddresses: this.options.config.transportByOrigin[origin].allowedPrivateAddresses }
        : {}),
    };
    const receiptPath = join(this.options.receiptDirectory, `${runId}.json`);
    const temp = await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), 'codexia-backup-')));
    try {
      const fs = await import('node:fs/promises');
      const profilePath = join(temp, 'profile.json');
      await fs.writeFile(profilePath, JSON.stringify(profile), { mode: 0o600, flag: 'wx' });
      const result = await new Promise<{ markerSha256: string; receiptSha256: string; verifiedAt: string }>(
        (resolveResult, rejectResult) => {
          const child = execFile(
            this.options.python,
            [
              this.options.transferScript,
              'upload',
              '--profile',
              profilePath,
              '--artifact-dir',
              artifactDirectory,
              '--backup-id',
              runId,
              '--source-identity',
              sourceSha,
              '--receipt',
              receiptPath,
              '--credential-stdin',
              '--machine-result',
            ],
            {
              timeout: 60 * 60_000,
              maxBuffer: 8192,
              killSignal: 'SIGKILL',
              env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
            },
            async (error, stdout) => {
              try {
                if (error) {
                  const outcome = z
                    .strictObject({
                      status: z.enum(['FAILED', 'UNKNOWN']),
                      reasonCode: z.enum(['credentials_unavailable', 's3_unavailable', 'transfer_failed', 'artifact_invalid']),
                    })
                    .safeParse(JSON.parse(stdout || '{}'));
                  if (outcome.success) {
                    throw new S3TransferFailure(outcome.data.reasonCode, outcome.data.status === 'UNKNOWN');
                  }
                  throw new S3TransferFailure('s3_unavailable', true);
                }
                const output = JSON.parse(stdout) as { status?: string; markerSha256?: string };
                if (output.status !== 'VERIFIED' || typeof output.markerSha256 !== 'string')
                  throw new Error('S3 verification receipt is missing');
                const bytes = await readPrivateBackupFile(receiptPath);
                const receipt = transferReceiptSchema.parse(JSON.parse(bytes));
                if (
                  receipt.backupId !== runId ||
                  receipt.sourceIdentity !== sourceSha ||
                  receipt.sha256sumsSha256 !== expectedManifestSha ||
                  receipt.markerSha256 !== output.markerSha256
                )
                  throw new S3TransferFailure('artifact_invalid', false);
                resolveResult({
                  markerSha256: receipt.markerSha256,
                  receiptSha256: createHash('sha256').update(bytes).digest('hex'),
                  verifiedAt: receipt.verifiedAt,
                });
              } catch (failure) {
                rejectResult(failure);
              }
            },
          );
          child.stdin?.on('error', () => undefined);
          child.stdin?.end(JSON.stringify(credential));
        },
      );
      return result;
    } finally {
      const fs = await import('node:fs/promises');
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
}

async function main(argv: string[]) {
  const databaseUrl = readCodexiaEnvironment('BACKUP_EXECUTOR_DATABASE_URL');
  const policyPath = readCodexiaEnvironment('BACKUP_POLICY_FILE');
  const configPath = readCodexiaEnvironment('BACKUP_EXECUTOR_CONFIG_FILE');
  const python = readCodexiaEnvironment('BACKUP_PYTHON');
  const transferScript = readCodexiaEnvironment('BACKUP_TRANSFER_SCRIPT');
  const receiptDirectory = readCodexiaEnvironment('BACKUP_RECEIPT_DIRECTORY');
  const backupScript = readCodexiaEnvironment('BACKUP_SCRIPT') ?? '/home/codexia/.local/bin/codexia-backup';
  const independentMount = readCodexiaEnvironment('BACKUP_SECONDARY_INDEPENDENT_MOUNT');
  if (
    !databaseUrl ||
    !policyPath ||
    !configPath ||
    !python ||
    !transferScript ||
    !receiptDirectory ||
    !isAbsolute(python) ||
    !isAbsolute(transferScript) ||
    !isAbsolute(receiptDirectory) ||
    !isAbsolute(backupScript) ||
    (independentMount && !isAbsolute(independentMount))
  )
    throw new Error('Backup control settings are incomplete');
  const policy = backupPolicySchema.parse(JSON.parse(await readFile(policyPath, 'utf8')));
  const config = backupExecutorConfigSchema.parse(JSON.parse(await readPrivateBackupFile(configPath)));
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 8_000 });
  const control = new BackupConsoleControl({
    pool,
    policy,
    config,
    python,
    transferScript,
    receiptDirectory,
    backupScript,
    ...(independentMount ? { independentMount } : {}),
  });
  try {
    const [command, ...args] = argv;
    let output = '';
    if (command === 'deploy-start' && args.length === 5)
      output = await control.deployStart(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!);
    else if (command === 'deploy-finish' && args.length === 3) await control.finish(args[0]!, args[1]!, args[2]!, 'deploy');
    else if (command === 'deploy-interrupted' && args.length === 1) await control.deployInterrupted(args[0]!);
    else if (command === 'deploy-fail' && args.length === 2) await control.deployFail(args[0]!, args[1]!);
    else if (command === 'manual-start' && args.length === 3) await control.manualStart(args[0]!, args[1]!, args[2]!);
    else if (command === 'manual-finish' && args.length === 3) {
      try {
        await control.finish(args[0]!, args[1]!, args[2]!, 'manual');
      } catch (error) {
        if (error instanceof RetryableControlError) throw error;
        let current: { state: string; manifest_sha256: string | null; evidence: Record<string, unknown> | null } | undefined;
        try {
          const {
            rows: [row],
          } = await pool.query<{ state: string; manifest_sha256: string | null; evidence: Record<string, unknown> | null }>(
            "SELECT state, manifest_sha256, evidence FROM codexia_backup.runs WHERE id = $1 AND kind IN ('manual', 'scheduled')",
            [args[0]],
          );
          current = row;
        } catch {
          throw new RetryableControlError('manual_finish_unresolved');
        }
        if (current?.manifest_sha256 === args[2] && current.state === 'REMOTE_VERIFIED') return;
        if (current?.manifest_sha256 === args[2] && current.state === 'FAILED' && current.evidence?.offVmMethod === 'independent_mount')
          return;
        if (current?.state === 'FAILED') throw new TerminalControlError('Backup run failed with a durable receipt');
        throw new RetryableControlError('manual_finish_unresolved');
      }
    } else if (command === 'manual-interrupted' && args.length === 1) await control.manualInterrupted(args[0]!);
    else if (command === 'manual-fail' && args.length === 2) await control.manualFail(args[0]!, args[1]!);
    else if (command === 'record-restore' && args.length === 2) await control.recordRestore(args[0]!, args[1]!);
    else if (command === 'reconcile-restored-journal' && args.length === 3) {
      await control.reconcileRestoredJournal(args[0]!, args[1]!, args[2]!);
    } else if (command === 'recover' && args.length === 0) {
      // The host runner owns durable intent replay and service restoration. Unknown rows are
      // not rewritten here: recovery must attach a validated receipt or remain visibly unknown.
      await pool.query("SELECT 1 FROM codexia_backup.runs WHERE state = 'UNKNOWN' LIMIT 1");
    } else throw new Error('Unsupported backup control command');
    if (output) process.stdout.write(output + '\n');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main(process.argv.slice(2)).catch(error => {
    process.stderr.write('Backup control operation failed.\n');
    process.exitCode = error instanceof RetryableControlError ? error.code : error instanceof TerminalControlError ? error.code : 1;
  });
}
