import { z } from 'zod';
import { ApiError } from '../api-error';
import {
  backupConsoleConfigActivatePost,
  backupConsoleConfigDisablePost,
  backupConsoleConfigDraftPut,
  backupConsoleConfigGet,
  backupConsoleConfigProbeGet,
  backupConsoleConfigProbesPost,
  backupConsoleRecoveryGet,
  backupConsoleRunGet,
  backupConsoleRunsGet,
  backupConsoleRunsPost,
  backupConsoleStatusGet,
} from '../generated/http/client';

export const backupId = z.uuid();
const observedAt = z.iso.datetime({ offset: true });
const digest = z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/u);
const sourceSha = z.string().regex(/^[0-9a-f]{40}$/u);

const operation = z.object({
  operationId: backupId,
  requestId: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(['QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'BLOCKED', 'APPLIED']),
  phase: z.enum(['probe', 'activate', 'disable']),
  reasonCode: z.string().nullable(),
  evidence: z
    .object({
      bucketVersioning: z.enum(['enabled', 'disabled', 'suspended', 'unknown']).optional(),
      objectLock: z.enum(['enabled', 'disabled', 'unknown']).optional(),
      defaultRetentionDays: z.number().int().nonnegative().nullable().optional(),
    })
    .nullable()
    .optional(),
  observedAt,
});

const verifiedPoint = z.object({
  runId: backupId,
  manifestSha256: digest,
  observedAt,
});

const run = z
  .object({
    runId: backupId,
    requestId: z.string(),
    revision: z.number().int().positive().nullable(),
    status: z.enum(['QUEUED', 'RUNNING', 'UNKNOWN', 'FAILED', 'BLOCKED', 'REMOTE_VERIFIED']),
    phase: z.string(),
    reasonCode: z.string().nullable(),
    sourceSha: sourceSha.nullable(),
    imageDigest: digest.nullable(),
    manifestSha256: digest.nullable(),
    offVmConfirmation: z
      .object({
        offVmMethod: z.enum(['s3', 'independent_mount']),
        receiptSha256: digest.optional(),
        markerSha256: digest.optional(),
        independentArtifactSha256: digest.optional(),
      })
      .nullable()
      .optional(),
    observedAt,
    createdAt: observedAt,
  })
  .refine(
    value =>
      value.status !== 'REMOTE_VERIFIED' ||
      Boolean(
        value.manifestSha256 &&
          value.offVmConfirmation?.offVmMethod === 's3' &&
          value.offVmConfirmation.receiptSha256 &&
          value.offVmConfirmation.markerSha256,
      ),
  );
export type BackupRun = z.infer<typeof run>;

const drill = verifiedPoint.extend({
  status: z.enum(['DRILL_PASSED', 'partial']),
  sourceSha,
  receiptSha256: digest,
});
const recovery = z.object({
  status: z.enum(['DRILL_PASSED', 'partial', 'stale', 'unknown']),
  restoreDrill: z.union([drill, z.literal('unknown')]),
  lastVerifiedOffVmBackup: z.union([verifiedPoint, z.literal('unknown')]),
  missingConditions: z.array(z.string()),
});

const status = z.object({
  activeRevision: z.number().int().positive().nullable(),
  enabled: z.boolean(),
  status: z.enum(['DISABLED', 'ACTIVE']),
  degraded: z.boolean(),
  staging: z.literal('unknown'),
  lastVerifiedOffVmBackup: z.union([run, z.literal('unknown')]),
  restoreDrill: z.union([verifiedPoint, z.literal('unknown')]),
  operation: operation.optional(),
});

const runPage = z.object({ runs: z.array(run), nextCursor: backupId.nullable() });

export type BackupDraftInput = Parameters<typeof backupConsoleConfigDraftPut>[0];
export type BackupConfiguration = Awaited<ReturnType<typeof backupConsoleConfigGet>>;
export type BackupOperation = z.infer<typeof operation>;

function displayData<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError('Invalid backup control response', 502, 'INVALID_RESPONSE');
  return result.data;
}

export function createBackupConsoleClient(fetcher: typeof fetch = fetch) {
  const readOptions = {
    cache: 'no-store',
    redirect: 'error',
    transport: { auth: 'same-origin' },
    fetcher,
  } as const;
  const options = (signal?: AbortSignal) => ({
    ...readOptions,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000),
  });
  const write = (headers: Record<string, string>) => ({
    ...options(),
    headers: { 'x-codexia-csrf': '1', ...headers },
  });
  const idempotent = (requestId: string) => write({ 'Idempotency-Key': requestId });
  return {
    async status(requestId?: string, signal?: AbortSignal) {
      const request = options(signal);
      // The admitted Fastify handler supports requestId. The published TypeSpec
      // operation still lacks that query parameter. Keep Orval as the route owner.
      const lookup: typeof fetch = (input, init) =>
        fetcher(String(input) + '?' + new URLSearchParams({ requestId: requestId ?? '' }), init);
      return displayData(status, await backupConsoleStatusGet(requestId ? { ...request, fetcher: lookup } : request));
    },
    config: (signal?: AbortSignal) => backupConsoleConfigGet(options(signal)),
    saveDraft: (body: BackupDraftInput, revision: number) => backupConsoleConfigDraftPut(body, write({ 'If-Match': '"' + revision + '"' })),
    probeRequest: (revision: number, requestId: string) => backupConsoleConfigProbesPost({ revision }, idempotent(requestId)),
    async probe(probeId: string, signal?: AbortSignal) {
      return displayData(operation, await backupConsoleConfigProbeGet(probeId, options(signal)));
    },
    activate: (revision: number, probeId: string, requestId: string) =>
      backupConsoleConfigActivatePost({ revision, probeId, confirmed: true }, idempotent(requestId)),
    disable: (revision: number, requestId: string) => backupConsoleConfigDisablePost({ revision, confirmed: true }, idempotent(requestId)),
    runRequest: (maintenanceWindowId: string, requestId: string) =>
      backupConsoleRunsPost({ maintenanceWindowId, confirmed: true }, idempotent(requestId)),
    async runs(cursor?: string, signal?: AbortSignal) {
      return displayData(runPage, await backupConsoleRunsGet(cursor ? { cursor } : undefined, options(signal)));
    },
    async run(runId: string, signal?: AbortSignal) {
      return displayData(run, await backupConsoleRunGet(runId, options(signal)));
    },
    async recovery(signal?: AbortSignal) {
      return displayData(recovery, await backupConsoleRecoveryGet(options(signal)));
    },
  };
}

export const backupConsoleClient = createBackupConsoleClient();
