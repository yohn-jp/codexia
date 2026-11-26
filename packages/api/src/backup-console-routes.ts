import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { BackupConsoleError, BackupConsoleStore, type BackupDestination } from './backup-console-store.js';
import {
  backupCredentialBinding,
  backupCredentialKeyId,
  type SealedBackupCredential,
  sealBackupCredential,
} from './backup-credential-envelope.js';
import type { createBetterAuthRuntime } from './better-auth.js';
import { readCodexiaEnvironment } from './environment.js';
import { httpContract } from './http-contract.js';

const origin = z
  .string()
  .max(300)
  .refine(value => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.origin === value &&
        /^[a-z0-9][a-z0-9.-]*\.[a-z0-9]+$/u.test(url.hostname) &&
        !url.hostname.endsWith('.localhost') &&
        !/^[\d.]+$/u.test(url.hostname)
      );
    } catch {
      return false;
    }
  });
const region = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u);
const bucket = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u)
  .refine(value => !value.includes('..') && !/^\d+(\.\d+){3}$/u.test(value));
const prefix = z
  .string()
  .max(900)
  .refine(value =>
    value
      .split('/')
      .every(part => /^[A-Za-z0-9._-]{1,128}$/u.test(part) && !part.includes('..') && part !== '.' && part !== '.codexia-probes'),
  );
const credentialMode = z.enum(['operator-role', 'sealed-access-key']);
const credentialValue = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/u);
const draftRequest = z.strictObject({
  provider: z.enum(['aws-s3', 's3-compatible']),
  endpoint: origin.optional(),
  region: region.optional(),
  bucket,
  prefix,
  addressing: z.enum(['path-style', 'virtual-hosted-style']).optional(),
  credentialMode,
  offVmPolicy: z.enum(['required', 'secondary']),
  retentionRequest: z
    .strictObject({
      days: z.number().int().min(1).max(3650).optional(),
      generations: z.number().int().min(1).max(10000).optional(),
    })
    .optional(),
  schedule: z.literal('disabled').default('disabled'),
  accessKeyId: credentialValue.max(128).optional(),
  secretAccessKey: credentialValue.max(256).optional(),
  sessionToken: credentialValue.optional(),
});

const allowedDestination = z.strictObject({
  provider: z.enum(['aws-s3', 's3-compatible']),
  endpoint: origin.optional(),
  region,
  bucket,
  prefix,
  credentialModes: z.array(credentialMode).min(1),
});
export const backupPolicySchema = z.object({ destinations: z.array(allowedDestination).min(1) });
export type BackupPolicy = z.infer<typeof backupPolicySchema>;

export function allowedBackupDestination(destination: BackupDestination, policy: BackupPolicy) {
  return policy.destinations.some(
    rule =>
      rule.provider === destination.provider &&
      rule.region === destination.region &&
      rule.bucket === destination.bucket &&
      rule.endpoint === (destination.provider === 's3-compatible' ? destination.endpoint : undefined) &&
      (rule.prefix === destination.prefix || destination.prefix.startsWith(rule.prefix + '/')) &&
      rule.credentialModes.includes(destination.credentialMode),
  );
}

export interface BackupConsoleOptions {
  store: BackupConsoleStore;
  policy: BackupPolicy;
  publicKeyPem?: string;
  closeStoreOnShutdown?: boolean;
}

export function loadBackupConsole(): BackupConsoleOptions | undefined {
  const databaseUrl = readCodexiaEnvironment('BACKUP_API_DATABASE_URL');
  if (!databaseUrl) return undefined;
  const policyPath = readCodexiaEnvironment('BACKUP_POLICY_FILE');
  if (!policyPath) throw new Error('Backup console requires CODEXIA_BACKUP_POLICY_FILE');
  const keyPath = readCodexiaEnvironment('BACKUP_PUBLIC_KEY_FILE');
  const publicKeyPem = keyPath ? readFileSync(keyPath, 'utf8') : undefined;
  if (publicKeyPem) {
    if (!publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('Backup console requires an executor public key');
    backupCredentialKeyId(publicKeyPem);
  }
  const policy = backupPolicySchema.parse(JSON.parse(readFileSync(policyPath, 'utf8')));
  const pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5_000, statement_timeout: 8_000 });
  pool.on('error', () => undefined);
  return { policy, store: new BackupConsoleStore(pool), ...(publicKeyPem ? { publicKeyPem } : {}), closeStoreOnShutdown: true };
}

const path = '/api/console/backups';
const requestIdPattern = /^[A-Za-z0-9_-]{16,128}$/u;
const uuid = z.uuid();
const revision = z.number().int().positive().max(2147483647);
const operationRequest = {
  probe: z.strictObject({ revision }),
  activate: z.strictObject({ revision, probeId: uuid, confirmed: z.literal(true) }),
  disable: z.strictObject({ revision, confirmed: z.literal(true) }),
};
const reject = (status: number, code: string): never => {
  throw new BackupConsoleError(status, code);
};
const invalid = () => reject(422, 'BACKUP_INPUT_INVALID');

function expectedRevision(request: FastifyRequest): number {
  const value = request.headers['if-match'];
  const match = typeof value === 'string' && /^"(0|[1-9][0-9]{0,9})"$/u.exec(value);
  if (!match || Number(match[1]) >= 2147483647) return reject(412, 'BACKUP_IF_MATCH_REQUIRED');
  return Number(match[1]);
}

export function registerBackupConsole(
  server: FastifyInstance,
  auth: ReturnType<typeof createBetterAuthRuntime>,
  options: BackupConsoleOptions | undefined,
  isDraining: () => boolean,
) {
  server.register(async app => {
    const wire = (operationId: string) => {
      const contract = httpContract.routes.find(route => route.operationId === 'backup_console_' + operationId);
      if (!contract) throw new Error('Backup HTTP operation schema is missing');
      return { schema: contract.schema, attachValidation: true };
    };
    app.setErrorHandler((error, _request, reply) => {
      const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
      const failure =
        error instanceof BackupConsoleError
          ? error
          : status === 413 || status === 415
            ? new BackupConsoleError(status, 'BACKUP_INPUT_INVALID')
            : status === 400
              ? new BackupConsoleError(422, 'BACKUP_INPUT_INVALID')
              : new BackupConsoleError(503, 'BACKUP_CONTROL_PLANE_UNAVAILABLE');
      void reply.code(failure.status).send({ error: failure.code, code: failure.code });
    });
    app.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const write = request.method !== 'GET';
      const result = await auth.checkOwnerSession(auth.toHeaders(request.raw.headers), {
        write,
        fresh: write && request.routeOptions.url !== path + '/config/probes',
      });
      if (result.status !== 200) reject(result.status, 'BACKUP_OWNER_SESSION_REQUIRED');
      if (write && request.headers['x-codexia-csrf'] !== '1') reject(403, 'BACKUP_CSRF_REQUIRED');
      if (write && isDraining()) reject(503, 'SHUTTING_DOWN');
      if (write && request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        reject(415, 'JSON_REQUIRED');
      }
      if (!options) reject(503, 'BACKUP_CONTROL_PLANE_UNAVAILABLE');
    });
    const configuration = () => options ?? reject(503, 'BACKUP_CONTROL_PLANE_UNAVAILABLE');
    const store = () => configuration().store;
    app.get(path + '/status', wire('status_get'), async request => {
      const query = z.strictObject({ requestId: z.string().regex(requestIdPattern).optional() }).safeParse(request.query);
      if (!query.success) return invalid();
      return store().status(query.data.requestId);
    });
    app.get(path + '/config', wire('config_get'), async (_request, reply) => {
      const config = await store().config();
      return reply.header('ETag', '"' + config.revision + '"').send(config);
    });
    app.put(path + '/config/draft', { ...wire('config_draft_put'), bodyLimit: 16_384 }, async (request, reply) => {
      const expected = expectedRevision(request);
      if (request.validationError) return invalid();
      const input = draftRequest.safeParse(request.body);
      if (!input.success) return invalid();
      const { accessKeyId, secretAccessKey, sessionToken, endpoint, addressing, region: inputRegion, ...fields } = input.data;
      const aws = fields.provider === 'aws-s3';
      const expectedAddressing = aws ? 'virtual-hosted-style' : 'path-style';
      if (
        (aws ? endpoint !== undefined || !inputRegion || fields.bucket.includes('.') : !endpoint) ||
        (addressing && addressing !== expectedAddressing)
      )
        return invalid();
      const destinationRegion = inputRegion ?? 'us-east-1';
      const destination: BackupDestination = {
        ...fields,
        region: destinationRegion,
        ...(fields.retentionRequest ? { retentionRequest: fields.retentionRequest } : {}),
        endpoint: aws ? `https://s3.${destinationRegion}.amazonaws.com` : (endpoint ?? invalid()),
        addressing: expectedAddressing,
      };
      if (!allowedBackupDestination(destination, configuration().policy)) return reject(422, 'BACKUP_DESTINATION_NOT_ALLOWED');
      const hasCredential = accessKeyId !== undefined || secretAccessKey !== undefined || sessionToken !== undefined;
      let envelope: SealedBackupCredential | undefined;
      if (hasCredential) {
        if (fields.credentialMode !== 'sealed-access-key' || !accessKeyId || !secretAccessKey) return invalid();
        const publicKey = configuration().publicKeyPem;
        if (!publicKey) return reject(503, 'BACKUP_EXECUTOR_KEY_UNAVAILABLE');
        envelope = sealBackupCredential(
          publicKey,
          { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
          backupCredentialBinding(destination),
        );
      }
      const config = await store().saveDraft(expected, destination, envelope);
      return reply.header('ETag', '"' + config.revision + '"').send(config);
    });
    app.get(path + '/config/probes/:probeId', wire('config_probe_get'), async request => {
      const params = z.object({ probeId: uuid }).safeParse(request.params);
      if (!params.success) return reject(404, 'BACKUP_PROBE_NOT_FOUND');
      return store().probe(params.data.probeId);
    });
    for (const kind of ['probe', 'activate', 'disable'] as const) {
      const leaf = kind === 'probe' ? 'probes' : kind;
      app.post(path + '/config/' + leaf, { ...wire('config_' + leaf + '_post'), bodyLimit: 4096 }, async (request, reply) => {
        if (request.validationError) return invalid();
        const id = request.headers['idempotency-key'];
        const body = operationRequest[kind].safeParse(request.body);
        if (typeof id !== 'string' || !requestIdPattern.test(id) || !body.success) return invalid();
        const operation = await store().enqueue(
          kind,
          id,
          body.data.revision,
          'probeId' in body.data && typeof body.data.probeId === 'string' ? body.data.probeId : undefined,
        );
        return reply.code(202).send({
          [kind === 'probe' ? 'probeId' : 'operationId']: operation.id,
          requestId: operation.request_id,
          state: 'queued',
          status: operation.state,
          phase: kind,
          createdAt: operation.created_at.toISOString(),
          observedAt: operation.observed_at.toISOString(),
          reasonCode: operation.reason_code,
        });
      });
    }
  });
}
