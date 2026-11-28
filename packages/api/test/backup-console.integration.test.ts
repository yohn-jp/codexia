import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { BackupConsoleControl } from '../src/backup-console-control.js';
import {
  BackupConsoleExecutor,
  backupExecutorConfigSchema,
  protectedBackupRunner,
  pythonBackupProbe,
} from '../src/backup-console-executor.js';
import { type BackupPolicy, registerBackupConsole } from '../src/backup-console-routes.js';
import { BackupConsoleStore } from '../src/backup-console-store.js';
import { backupCredentialKeyId } from '../src/backup-credential-envelope.js';
import { httpContract, httpContractSchemaController } from '../src/http-contract.js';
import { createServer } from '../src/server.js';
import { assertDisposableAuthFixtureDatabaseUrl, startBetterAuthFixture } from './fixtures/better-auth-server.js';

test('[TEST-OPS-004-001] [TEST-OPS-005-001] backup console requires owner proof, isolates credentials, and applies only verified executor results', async t => {
  const databaseUrl = process.env.CODEXIA_AUTH_TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'Set CODEXIA_AUTH_TEST_DATABASE_URL to a disposable PostgreSQL auth database');
  assertDisposableAuthFixtureDatabaseUrl(databaseUrl);
  const admin = new Pool({ connectionString: databaseUrl });
  const apiPool = new Pool({ connectionString: databaseUrl, options: '-c role=codexia_backup_api' });
  const workerPool = new Pool({ connectionString: databaseUrl, options: '-c role=codexia_backup_executor' });
  t.after(async () => {
    await Promise.all([apiPool.end(), workerPool.end()]);
    await admin.query('DROP SCHEMA IF EXISTS codexia_backup CASCADE');
    await admin.end();
  });
  await admin.query(await readFile(new URL('../../../deploy/backup/operational-schema.sql', import.meta.url), 'utf8'));
  const api = new BackupConsoleStore(apiPool);
  assert.equal((await api.config()).revision, 0);
  await assert.rejects(apiPool.query('SELECT envelope FROM codexia_backup.credentials'), { code: '42501' });
  await assert.rejects(apiPool.query('UPDATE codexia_backup.state SET active_revision = NULL'), { code: '42501' });
  await assert.rejects(apiPool.query("UPDATE codexia_backup.operations SET state = 'PASSED'"), { code: '42501' });
  await assert.rejects(apiPool.query("UPDATE codexia_backup.runs SET state = 'REMOTE_VERIFIED'"), { code: '42501' });
  await assert.rejects(workerPool.query('UPDATE codexia_backup.state SET draft_revision = NULL'), { code: '42501' });

  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  let publishedKey = keys.publicKey;
  const keyId = backupCredentialKeyId(keys.publicKey);
  const privateKeys = new Map([[keyId, keys.privateKey]]);
  const draft = {
    provider: 's3-compatible',
    endpoint: 'https://backups.fixture.test',
    region: 'us-east-1',
    bucket: 'codexia-fixture',
    prefix: 'install/backup',
    credentialMode: 'sealed-access-key',
    offVmPolicy: 'secondary',
    accessKeyId: 'test-fixture-access-key',
    secretAccessKey: 'test-fixture-secret-key',
  } as const;
  const policy: BackupPolicy = {
    scheduleWindowId: 'fixture-window',
    maintenanceWindows: [
      {
        id: 'fixture-window',
        timeZone: 'UTC',
        daysOfWeek: [new Date().getUTCDay()],
        start: `${String(Math.floor(new Date().getUTCHours() / 6) * 6).padStart(2, '0')}:00`,
        durationMinutes: 360,
      },
    ],
    destinations: [
      {
        provider: draft.provider,
        endpoint: draft.endpoint,
        region: draft.region,
        bucket: draft.bucket,
        prefix: draft.prefix,
        credentialModes: ['sealed-access-key'],
      },
    ],
  };
  const python = process.env.CODEXIA_BACKUP_TEST_PYTHON;
  const realProbe = python
    ? pythonBackupProbe(python, fileURLToPath(new URL('../../../deploy/backup/s3_probe_tls_fixture_adapter.py', import.meta.url)), policy)
    : undefined;
  let probes = 0;
  const worker = new BackupConsoleExecutor({
    pool: workerPool,
    policy,
    privateKeys,
    async run(runId) {
      await admin.query(
        "UPDATE codexia_backup.runs SET state = 'REMOTE_VERIFIED', phase = 'complete', source_sha = $2, image_digest = $3, manifest_sha256 = $4, evidence = $5, observed_at = clock_timestamp() WHERE id = $1",
        [runId, 'a'.repeat(40), 'sha256:' + 'b'.repeat(64), 'c'.repeat(64), { offVmMethod: 's3', markerSha256: 'd'.repeat(64) }],
      );
    },
    async probe(revision, credential) {
      assert.equal(revision.destination.endpoint, draft.endpoint);
      assert.equal(credential.accessKeyId, draft.accessKeyId);
      assert.equal(credential.secretAccessKey, revision.revision < 3 ? draft.secretAccessKey : 'test-rotated-credential');
      probes++;
      return realProbe ? realProbe(revision, credential) : { state: 'PASSED', reason: null };
    },
  });
  const restoreDirectory = await mkdtemp(join(tmpdir(), 'codexia-restore-receipt-'));
  t.after(() => rm(restoreDirectory, { recursive: true, force: true }));
  const privateKey = join(restoreDirectory, 'worker.pem');
  const transferScript = join(restoreDirectory, 'transfer.py');
  const control = new BackupConsoleControl({
    pool: workerPool,
    policy,
    config: backupExecutorConfigSchema.parse({ privateKeyFiles: [privateKey] }),
    python: '/usr/bin/python3',
    transferScript,
    receiptDirectory: restoreDirectory,
    backupScript: '/unused',
  });
  const sourceSha = 'a'.repeat(40);
  const sourceDigest = 'sha256:' + 'b'.repeat(64);
  const candidateSha = 'c'.repeat(40);
  const candidateDigest = 'sha256:' + 'd'.repeat(64);
  await assert.rejects(
    control.deployStart(randomUUID(), sourceSha, sourceDigest, candidateSha, candidateDigest),
    /Active off-VM backup destination is unavailable/u,
  );
  await assert.rejects(control.deployStart(randomUUID(), sourceSha, '-', sourceSha, candidateDigest), /Deployment identity is invalid/u);
  await writeFile(privateKey, keys.privateKey, { mode: 0o600 });
  // An interrupted host recovery must preserve the claim until the real runner reports idle.
  const orphan = randomUUID();
  const hostRunner = join(restoreDirectory, 'runner');
  const recoveryWorker = new BackupConsoleExecutor({
    pool: workerPool,
    policy,
    privateKeys,
    probe: async () => {
      throw new Error('Unexpected probe during recovery');
    },
    ...protectedBackupRunner(hostRunner),
  });
  await admin.query(
    "INSERT INTO codexia_backup.runs (id, request_id, kind, state, phase, maintenance_window_id) VALUES ($1::uuid, $2, 'manual', 'RUNNING', 'starting', 'fixture-window')",
    [orphan, orphan],
  );
  await writeFile(hostRunner, '#!/bin/sh\nexit 75\n', { mode: 0o700 });
  await recoveryWorker.processNext();
  assert.equal((await api.run(orphan)).status, 'RUNNING');
  await writeFile(hostRunner, '#!/bin/sh\ntest "$#" = 1 && test "$1" = recover\n');
  await recoveryWorker.processNext();
  assert.equal((await api.run(orphan)).reasonCode, 'runner_not_started');
  await admin.query('DELETE FROM codexia_backup.runs WHERE id = $1', [orphan]);
  await admin.query('DELETE FROM codexia_backup.runs WHERE id = $1', [orphan]);
  await worker.processNext();
  const fixture = await startBetterAuthFixture({
    databaseUrl,
    usePostgresPersistence: true,
    includeMcp: true,
    apiHostname: 'codexia-mcp-fixture.test',
    createApiServer: options => createServer({ ...options, backupConsole: { store: api, policy, publicKeyPem: publishedKey } }),
  });
  t.after(() => fixture.close());
  const base = fixture.apiOrigin + '/api/console/backups';
  const cookie = fixture.ownerSessionCookie();
  const writeHeaders = { cookie, origin: fixture.apiOrigin, 'x-codexia-csrf': '1', 'content-type': 'application/json' };
  const put = (body: unknown, etag = '"0"', headers = writeHeaders) =>
    fetch(base + '/config/draft', {
      method: 'PUT',
      headers: { ...headers, 'if-match': etag },
      body: JSON.stringify(body),
    });
  const post = (kind: string, body: unknown, id = randomUUID()) =>
    fetch(base + '/config/' + kind, {
      method: 'POST',
      headers: { ...writeHeaders, 'idempotency-key': id },
      body: JSON.stringify(body),
    });
  const get = (path: string) => fetch(base + path, { headers: { cookie } });

  const principals: Record<string, string>[] = [
    {},
    { authorization: 'Bearer ' + (await fixture.issueOwnerAccessToken()) },
    { authorization: 'Bearer ' + (await fixture.issueMcpAccessToken()).accessToken },
    { 'x-codexia-setup-key': 'fixture-setup', cookie: 'codexia_setup=fixture' },
    { 'x-codexia-share-token': 'fixture-share' },
    { 'cf-access-jwt-assertion': 'fixture-edge-ci' },
  ];
  const routes = [
    ['GET', '/status'],
    ['GET', '/config'],
    ['PUT', '/config/draft'],
    ['POST', '/config/probes'],
    ['GET', '/config/probes/' + randomUUID()],
    ['POST', '/config/activate'],
    ['POST', '/config/disable'],
    ['POST', '/runs'],
    ['GET', '/runs'],
    ['GET', `/runs/${randomUUID()}`],
    ['GET', '/recovery'],
  ];
  for (const [method, path] of routes) {
    for (const principal of principals) {
      const response = await fetch(base + path, { method, headers: { ...principal, origin: fixture.apiOrigin } });
      assert.ok([401, 403].includes(response.status), method + ' ' + path + ' ' + response.status);
      await response.text();
    }
  }
  assert.equal((await put(draft, '"0"', { ...writeHeaders, origin: 'https://other.example.test' })).status, 403);
  assert.equal((await put(draft, '"0"', { ...writeHeaders, 'x-codexia-csrf': '' })).status, 403);
  assert.equal((await put({ ...draft, endpoint: 'https://169.254.169.254' })).status, 422);
  assert.equal((await put({ ...draft, prefix: 'install/backup-other' })).status, 422);
  assert.equal((await put({ ...draft, staging: '/tmp/override' })).status, 422);
  for (const outOfScope of ['/restore', '/config/iam']) {
    assert.equal((await get(outOfScope)).status, 404);
  }
  const concurrent = await Promise.all([put(draft), put(draft)]);
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 412]);
  const saved = concurrent.find(response => response.status === 200)!;
  assert.equal(saved.headers.get('etag'), '"1"');
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  const configText = await saved.text();
  for (const value of [draft.accessKeyId, draft.secretAccessKey, draft.endpoint, draft.bucket, 'encryptedKey']) {
    assert.ok(!configText.includes(value));
  }
  const {
    rows: [stored],
  } = await admin.query<{ envelope: unknown }>('SELECT envelope FROM codexia_backup.credentials');
  assert.ok(stored && !JSON.stringify(stored.envelope).includes(draft.secretAccessKey));
  await admin.query(await readFile(new URL('../../../deploy/backup/operational-schema-667-upgrade.sql', import.meta.url), 'utf8'));
  assert.equal((await api.config()).revision, 1);
  assert.ok((await admin.query('SELECT envelope FROM codexia_backup.credentials')).rowCount === 1);

  const probeKey = randomUUID();
  const queued = await post('probes', { revision: 1 }, probeKey);
  assert.equal(queued.status, 202);
  const { probeId } = (await queued.json()) as { probeId: string };
  assert.equal((await post('activate', { revision: 1, probeId, confirmed: true })).status, 409);
  assert.equal(await worker.processNext(), true);
  assert.equal((await (await get('/config/probes/' + probeId)).json()).status, 'PASSED');
  assert.equal((await (await get('/status')).json()).activeRevision, null);

  const { accessKeyId: _access, secretAccessKey: _secret, ...nonSecret } = draft;
  assert.equal((await put(nonSecret, '"1"')).status, 200);
  assert.equal((await post('activate', { revision: 2, probeId, confirmed: true })).status, 409);
  assert.equal((await post('probes', { revision: 1 })).status, 412);
  const current = await post('probes', { revision: 2 });
  assert.equal(current.status, 202);
  const { probeId: currentProbe } = (await current.json()) as { probeId: string };
  await worker.processNext();
  const activationRequest = randomUUID();
  const activation = { revision: 2, probeId: currentProbe, confirmed: true };
  const statusQuery = '/status?' + new URLSearchParams({ requestId: activationRequest });
  const accepted = await post('activate', activation, activationRequest);
  assert.equal(accepted.status, 202);
  // The server accepted the POST, but the caller loses the receipt before reading it.
  await accepted.body?.cancel();
  const queuedLookup = await get(statusQuery);
  assert.equal(queuedLookup.status, 200);
  const queuedActivation = await queuedLookup.json();
  assert.equal(queuedActivation.activeRevision, null);
  assert.equal(queuedActivation.operation.requestId, activationRequest);
  assert.equal(queuedActivation.operation.status, 'QUEUED');
  assert.equal(queuedActivation.operation.phase, 'activate');
  const replay = await post('activate', activation, activationRequest);
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).operationId, queuedActivation.operation.operationId);
  assert.equal((await post('activate', activation)).status, 409);
  const overview = await get('/status');
  assert.equal(overview.status, 200);
  const overviewBody = await overview.json();
  assert.equal(overviewBody.activeRevision, null);
  assert.equal(overviewBody.operation, undefined);
  await worker.processNext();
  const appliedLookup = await get(statusQuery);
  assert.equal(appliedLookup.status, 200);
  const active = await appliedLookup.json();
  assert.equal(active.activeRevision, 2);
  assert.equal(active.operation.operationId, queuedActivation.operation.operationId);
  assert.equal(active.operation.requestId, activationRequest);
  assert.equal(active.operation.status, 'APPLIED');
  const deployRunId = randomUUID();
  assert.equal(await control.deployStart(deployRunId, sourceSha, sourceDigest, candidateSha, candidateDigest), deployRunId);
  assert.equal(await control.deployStart(deployRunId, sourceSha, sourceDigest, candidateSha, candidateDigest), deployRunId);
  await assert.rejects(
    control.deployStart(deployRunId, sourceSha, sourceDigest, sourceSha, candidateDigest),
    /Deployment run identity was reused/u,
  );
  const {
    rows: [deployRun],
  } = await workerPool.query(
    'SELECT revision, source_sha, image_digest, candidate_source_sha, candidate_image_digest FROM codexia_backup.runs WHERE id = $1',
    [deployRunId],
  );
  assert.deepEqual(deployRun, {
    revision: 2,
    source_sha: sourceSha,
    image_digest: sourceDigest,
    candidate_source_sha: candidateSha,
    candidate_image_digest: candidateDigest,
  });
  await control.deployFail(deployRunId, 'fixture_complete');
  assert.equal(active.lastVerifiedOffVmBackup, 'unknown');
  assert.equal(probes, 3);

  privateKeys.delete(keyId);
  await worker.processNext();
  assert.equal((await (await get('/status')).json()).degraded, true);
  assert.equal((await post('probes', { revision: 2 })).status, 409);
  assert.equal((await post('disable', { revision: 2, confirmed: true })).status, 202);
  assert.equal((await (await get('/status')).json()).activeRevision, 2);
  await worker.processNext();
  assert.equal((await (await get('/status')).json()).activeRevision, null);

  const rotated = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKeys.set(backupCredentialKeyId(rotated.publicKey), rotated.privateKey);
  publishedKey = rotated.publicKey;
  await worker.processNext();
  await fixture.restartApi();
  assert.equal((await put({ ...draft, secretAccessKey: 'test-rotated-credential', offVmPolicy: 'required' }, '"2"')).status, 200);
  assert.equal((await post('probes', { revision: 3 })).status, 202);
  const {
    rows: [rotationProbe],
  } = await admin.query<{ id: string }>("SELECT id FROM codexia_backup.operations WHERE kind = 'probe' AND revision = 3");
  assert.ok(rotationProbe);
  await worker.processNext();
  assert.equal((await post('activate', { revision: 3, probeId: rotationProbe.id, confirmed: true })).status, 202);
  await worker.processNext();
  assert.equal((await (await get('/status')).json()).activeRevision, 3);
  assert.equal((await post('disable', { revision: 3, confirmed: true })).status, 409);
  const missing = await get('/status?requestId=unrecognized-request-id');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'BACKUP_OPERATION_NOT_FOUND', code: 'BACKUP_OPERATION_NOT_FOUND' });
  for (const query of ['requestId=', 'requestId=invalid-request-id%21', 'requestId=' + 'x'.repeat(129)]) {
    const invalid = await get('/status?' + query);
    assert.equal(invalid.status, 422);
    assert.deepEqual(await invalid.json(), { error: 'BACKUP_INPUT_INVALID', code: 'BACKUP_INPUT_INVALID' });
  }
  assert.equal((await put({ ...nonSecret, offVmPolicy: 'required', retentionRequest: { days: 30 } }, '"3"')).status, 200);
  const retentionProbe = await post('probes', { revision: 4 });
  assert.equal(retentionProbe.status, 202);
  const { probeId: retentionProbeId } = (await retentionProbe.json()) as { probeId: string };
  await worker.processNext();
  assert.equal((await (await get('/config/probes/' + retentionProbeId)).json()).status, 'PASSED');
  const rejectedActivation = await post('activate', { revision: 4, probeId: retentionProbeId, confirmed: true });
  assert.equal(rejectedActivation.status, 409);
  assert.equal((await rejectedActivation.json()).code, 'BACKUP_RETENTION_UNVERIFIED');
  assert.equal((await (await get('/status')).json()).activeRevision, 3);
  await workerPool.query("UPDATE codexia_backup.operations SET observed_at = now() - interval '20 minutes' WHERE id = $1", [
    retentionProbeId,
  ]);
  assert.equal((await post('activate', { revision: 4, probeId: retentionProbeId, confirmed: true })).status, 409);

  const retainedWorker = new BackupConsoleExecutor({
    pool: workerPool,
    policy,
    privateKeys,
    probe: async () => ({ state: 'PASSED', reason: null, evidence: { objectLock: 'enabled', defaultRetentionDays: 30 } }),
  });
  const freshProbe = await post('probes', { revision: 4 });
  const { probeId: freshProbeId } = (await freshProbe.json()) as { probeId: string };
  assert.equal(await retainedWorker.processNext(), true);
  assert.equal((await post('activate', { revision: 4, probeId: freshProbeId, confirmed: true })).status, 202);
  assert.equal(await retainedWorker.processNext(), true);
  assert.equal((await (await get('/status')).json()).activeRevision, 4);
  await worker.processNext();

  await writeFile(privateKey, rotated.privateKey);
  await writeFile(
    transferScript,
    `import json, pathlib, sys
profile = json.loads(pathlib.Path(sys.argv[sys.argv.index("--profile") + 1]).read_text())
pathlib.Path(__file__).with_suffix(".profile").write_text(json.dumps(profile))
print('{"status":"UNKNOWN","reasonCode":"s3_unavailable"}')
raise SystemExit(75)
`,
  );
  const checksumManifest = 'backup manifest for an interrupted transfer';
  await writeFile(join(restoreDirectory, 'SHA256SUMS'), checksumManifest);
  const manifestSha = createHash('sha256').update(checksumManifest).digest('hex');
  const interruptedRun = randomUUID();
  await control.deployStart(interruptedRun, sourceSha, sourceDigest, candidateSha, candidateDigest);
  await assert.rejects(control.finish(interruptedRun, restoreDirectory, manifestSha, 'deploy'), {
    code: 75,
    reasonCode: 's3_unavailable',
  });
  const {
    rows: [interrupted],
  } = await workerPool.query('SELECT state, phase, reason_code, evidence FROM codexia_backup.runs WHERE id = $1', [interruptedRun]);
  assert.deepEqual(interrupted, { state: 'UNKNOWN', phase: 'recovery_required', reason_code: 's3_unavailable', evidence: null });
  const transferProfile = JSON.parse(await readFile(join(restoreDirectory, 'transfer.profile'), 'utf8'));
  assert.equal(transferProfile.retentionMode, 'BUCKET_DEFAULT');
  assert.equal(transferProfile.retentionDays, 30);
  // Other assertions below expect an independent run history.
  await admin.query('DELETE FROM codexia_backup.runs WHERE id = $1', [interruptedRun]);

  const oldScheduledId = randomUUID();
  await admin.query(
    `INSERT INTO codexia_backup.runs (id, request_id, kind, revision, maintenance_window_id, schedule_slot_key)
     VALUES ($1, $1::uuid::text, 'scheduled', 4, 'fixture-window', 'historical-slot')`,
    [oldScheduledId],
  );
  await assert.rejects(control.manualStart(oldScheduledId, sourceSha, sourceDigest), /not claimable/u);
  await worker.processNext();
  assert.deepEqual((await workerPool.query("SELECT state, reason_code FROM codexia_backup.runs WHERE kind = 'scheduled'")).rows, [
    { state: 'BLOCKED', reason_code: 'schedule_disabled' },
  ]);
  await admin.query('DELETE FROM codexia_backup.runs WHERE id = $1', [oldScheduledId]);

  const runRequestId = randomUUID();
  const runStatusQuery = '/status?' + new URLSearchParams({ requestId: runRequestId });
  const runBody = { maintenanceWindowId: 'fixture-window', confirmed: true };
  const runResponse = await fetch(base + '/runs', {
    method: 'POST',
    headers: { ...writeHeaders, 'idempotency-key': runRequestId },
    body: JSON.stringify(runBody),
  });
  assert.equal(runResponse.status, 202);
  // Lose the accepted response before reading its run ID.
  await runResponse.body?.cancel();
  const runLookup = await get(runStatusQuery);
  assert.equal(runLookup.status, 200);
  const queuedRun = await runLookup.json();
  assert.equal(queuedRun.operation, undefined);
  assert.equal(queuedRun.run.requestId, runRequestId);
  assert.equal(queuedRun.run.status, 'QUEUED');
  const runReplay = await fetch(base + '/runs', {
    method: 'POST',
    headers: { ...writeHeaders, 'idempotency-key': runRequestId },
    body: JSON.stringify(runBody),
  });
  assert.equal(runReplay.status, 202);
  const runReceipt = (await runReplay.json()) as { runId: string; state: string };
  assert.equal(runReceipt.runId, queuedRun.run.runId);
  assert.equal(runReceipt.state, 'queued');
  const queuedRunDetail = await get('/runs/' + runReceipt.runId);
  assert.equal(queuedRunDetail.status, 200);
  assert.deepEqual(queuedRun.run, await queuedRunDetail.json());
  const runHistory = (await (await get('/runs')).json()) as { runs: Array<{ runId: string; status: string }> };
  assert.ok(runHistory.runs.some(run => run.runId === runReceipt.runId && run.status === 'QUEUED'));
  assert.equal(await worker.processNext(), true);
  const finalRunLookup = await get(runStatusQuery);
  assert.equal(finalRunLookup.status, 200);
  const finalRun = (await finalRunLookup.json()).run;
  const finalRunDetail = await get('/runs/' + runReceipt.runId);
  assert.equal(finalRunDetail.status, 200);
  assert.equal(finalRun.status, 'REMOTE_VERIFIED');
  assert.deepEqual(finalRun, await finalRunDetail.json());
  assert.equal((await (await get('/status')).json()).run, undefined);

  const historyIds = [
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
  ];
  await admin.query(
    `INSERT INTO codexia_backup.runs (id, request_id, kind, maintenance_window_id, state, created_at)
     SELECT id, id::text, 'manual', 'fixture-window', 'FAILED',
       '2024-01-01T00:00:00.000001Z'::timestamptz + ((ordinality = 1)::integer * interval '1 microsecond')
     FROM unnest($1::uuid[]) WITH ORDINALITY AS fixture(id, ordinality)`,
    [historyIds],
  );
  let historyPagePath = '/runs?limit=1';
  for (const runId of [runReceipt.runId, deployRunId, ...historyIds]) {
    const response = await get(historyPagePath);
    assert.equal(response.status, 200);
    const page = (await response.json()) as { runs: Array<{ runId: string }>; nextCursor: string | null };
    assert.deepEqual(
      page.runs.map(run => run.runId),
      [runId],
    );
    if (runId === historyIds.at(-1)) {
      assert.equal(page.nextCursor, null);
    } else {
      assert.ok(page.nextCursor);
      historyPagePath = `/runs?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`;
    }
  }
  assert.equal(typeof (await (await get('/status')).json()).lastVerifiedOffVmBackup.manifestSha256, 'string');
  assert.deepEqual((await get('/recovery').then(response => response.json())).missingConditions, [
    'independent_restore_drill_for_latest_backup',
  ]);
  const restoreReceipt = join(restoreDirectory, 'receipt.json');
  await writeFile(restoreReceipt, JSON.stringify({ format: 'codexia-restore-receipt/v1', checksumManifestSha256: 'c'.repeat(64) }), {
    mode: 0o600,
  });

  await control.recordRestore(runReceipt.runId, restoreReceipt);
  const partial = await (await get('/recovery')).json();
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.missingConditions, ['candidate_api_readiness']);
  const readinessReceipt = {
    format: 'codexia-restore-receipt/v1',
    checksumManifestSha256: 'c'.repeat(64),
    readyImageDigest: 'sha256:' + 'e'.repeat(64),
    verifiedLedger: 'sha256:' + 'd'.repeat(64),
  };
  await writeFile(restoreReceipt, JSON.stringify(readinessReceipt));
  await assert.rejects(control.recordRestore(runReceipt.runId, restoreReceipt), /different backup source image/u);
  await writeFile(restoreReceipt, JSON.stringify({ ...readinessReceipt, readyImageDigest: 'sha256:' + 'b'.repeat(64) }));
  await control.recordRestore(runReceipt.runId, restoreReceipt);
  assert.equal((await (await get('/recovery')).json()).status, 'DRILL_PASSED');

  await fixture.expireOwnerFreshProof();
  assert.equal((await get('/config')).status, 200);
  assert.equal((await put(draft, '"4"')).status, 403);
  assert.equal((await post('disable', { revision: 2, confirmed: true })).status, 403);
  assert.equal((await post('activate', activation, activationRequest)).status, 403);
  assert.equal(
    (
      await fetch(base + '/runs', {
        method: 'POST',
        headers: { ...writeHeaders, 'idempotency-key': randomUUID() },
        body: JSON.stringify(runBody),
      })
    ).status,
    403,
  );

  const selectedRun = randomUUID();
  const unknownRun = randomUUID();
  const queuedOperation = randomUUID();
  await control.deployStart(selectedRun, sourceSha, sourceDigest, candidateSha, candidateDigest);
  await admin.query(
    `INSERT INTO codexia_backup.runs (id, request_id, kind, maintenance_window_id, state)
     VALUES ($1, $1::uuid::text, 'manual', 'fixture-window', 'UNKNOWN')`,
    [unknownRun],
  );
  await admin.query("INSERT INTO codexia_backup.operations (id, request_id, kind, revision) VALUES ($1, $1::uuid::text, 'probe', 2)", [
    queuedOperation,
  ]);
  const selectedTransferReceipt = join(restoreDirectory, 'transfer-receipt.json');
  const selectedTransferBytes = JSON.stringify({
    format: 'codexia-backup-receipt/v1',
    backupId: selectedRun,
    sourceIdentity: sourceSha,
    sha256sumsSha256: manifestSha,
    markerSha256: 'e'.repeat(64),
    verifiedAt: new Date().toISOString(),
  });
  await writeFile(selectedTransferReceipt, selectedTransferBytes, { mode: 0o600 });
  const selectedTransferSha = createHash('sha256').update(selectedTransferBytes).digest('hex');
  const executorFenceSha = 'f'.repeat(64);
  await assert.rejects(control.reconcileRestoredJournal(selectedTransferReceipt, '0'.repeat(64), executorFenceSha), /receipt digest/u);
  await control.reconcileRestoredJournal(selectedTransferReceipt, selectedTransferSha, executorFenceSha);
  const readRun = async (id: string) =>
    (await workerPool.query('SELECT state, reason_code, manifest_sha256 FROM codexia_backup.runs WHERE id = $1', [id])).rows[0];
  assert.deepEqual(await readRun(selectedRun), { state: 'REMOTE_VERIFIED', reason_code: null, manifest_sha256: manifestSha });
  assert.deepEqual(await readRun(unknownRun), { state: 'UNKNOWN', reason_code: 'restored_outcome_unknown', manifest_sha256: null });
  const operation = await workerPool.query('SELECT state FROM codexia_backup.operations WHERE id = $1', [queuedOperation]);
  assert.equal(operation.rows[0].state, 'BLOCKED');
  const newProbe = randomUUID();
  await admin.query("INSERT INTO codexia_backup.operations (id, request_id, kind, revision) VALUES ($1, $1::uuid::text, 'probe', 3)", [
    newProbe,
  ]);
  await control.reconcileRestoredJournal(selectedTransferReceipt, selectedTransferSha, executorFenceSha);
  assert.equal(await worker.processNext(), false);
  assert.equal((await workerPool.query('SELECT state FROM codexia_backup.operations WHERE id = $1', [newProbe])).rows[0].state, 'QUEUED');
  await control.manualFail(unknownRun, 'operator_reconciled');
  assert.deepEqual(await readRun(unknownRun), { state: 'UNKNOWN', reason_code: 'restored_outcome_unknown', manifest_sha256: null });
  const dispositionPath = join(restoreDirectory, 'run-disposition.json');
  const disposition = JSON.stringify({
    format: 'codexia-backup-run-disposition/v1',
    backupId: unknownRun,
    executorFenceSha256: executorFenceSha,
    conclusion: 'no_verified_transfer',
  });
  await writeFile(dispositionPath, disposition, { mode: 0o600 });
  const dispositionSha = createHash('sha256').update(disposition).digest('hex');
  await assert.rejects(control.reconcileRestoredAbsence(dispositionPath, '0'.repeat(64)), /digest/u);
  await control.reconcileRestoredAbsence(dispositionPath, dispositionSha);
  await control.reconcileRestoredAbsence(dispositionPath, dispositionSha);
  assert.deepEqual(await readRun(unknownRun), { state: 'FAILED', reason_code: 'restored_no_verified_transfer', manifest_sha256: null });
  assert.equal(await worker.processNext(), true);
});

test('a manual backup that misses its window is blocked while an admitted interruption stays unknown', async t => {
  const databaseUrl = process.env.CODEXIA_AUTH_TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'Set CODEXIA_AUTH_TEST_DATABASE_URL to a disposable PostgreSQL auth database');
  assertDisposableAuthFixtureDatabaseUrl(databaseUrl);
  const admin = new Pool({ connectionString: databaseUrl });
  const api = new Pool({ connectionString: databaseUrl, options: '-c role=codexia_backup_api' });
  const worker = new Pool({ connectionString: databaseUrl, options: '-c role=codexia_backup_executor' });
  const server = Fastify({ schemaController: httpContractSchemaController });
  for (const schema of httpContract.schemas) server.addSchema(schema);
  t.after(async () => {
    await server.close();
    await Promise.all([api.end(), worker.end()]);
    await admin.query('DROP SCHEMA IF EXISTS codexia_backup CASCADE');
    await admin.end();
  });
  await admin.query(await readFile(new URL('../../../deploy/backup/operational-schema.sql', import.meta.url), 'utf8'));
  const scope = {
    provider: 's3-compatible',
    endpoint: 'https://backups.fixture.test',
    region: 'us-east-1',
    bucket: 'codexia-fixture',
    prefix: 'manual/backup',
  } as const;
  const policy: BackupPolicy = {
    destinations: [{ ...scope, credentialModes: ['operator-role'] }],
    maintenanceWindows: [{ id: 'brief-window', timeZone: 'UTC', daysOfWeek: [1], start: '00:00', durationMinutes: 1 }],
  };
  await admin.query('INSERT INTO codexia_backup.revisions (revision, destination) VALUES (1, $1)', [
    { ...scope, addressing: 'path-style', credentialMode: 'operator-role', offVmPolicy: 'required', schedule: 'disabled' },
  ]);
  await admin.query("UPDATE codexia_backup.state SET active_revision = 1, active_health = 'ready'");
  const ownerAuth: Parameters<typeof registerBackupConsole>[1] = {
    checkOwnerSession: async () => ({ status: 200 }),
    toHeaders: () => new Headers(),
  };
  registerBackupConsole(server, ownerAuth, { store: new BackupConsoleStore(api), policy }, () => false);
  const control = new BackupConsoleControl({
    pool: worker,
    policy,
    config: backupExecutorConfigSchema.parse({}),
    python: '/unused',
    transferScript: '/unused',
    receiptDirectory: '/unused',
    backupScript: '/unused',
  });
  const executor = new BackupConsoleExecutor({
    pool: worker,
    policy,
    privateKeys: new Map(),
    operatorCredential: { origin: scope.endpoint, credential: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } },
    async run(runId) {
      await control.manualStart(runId, 'a'.repeat(40), 'sha256:' + 'b'.repeat(64));
      throw new Error('Fixture lost the runner after admission');
    },
    probe: async () => {
      throw new Error('Unexpected probe during manual backup');
    },
  });
  assert.equal(await executor.processNext(), false);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-30T00:00:59Z') });
  const path = '/api/console/backups';
  for (const windowClosed of [false, true]) {
    const requestId = randomUUID();
    const submitted = await server.inject({
      method: 'POST',
      url: path + '/runs',
      headers: { 'content-type': 'application/json', 'x-codexia-csrf': '1', 'idempotency-key': requestId },
      payload: { maintenanceWindowId: 'brief-window', confirmed: true },
    });
    assert.equal(submitted.statusCode, 202, submitted.body);
    if (windowClosed) t.mock.timers.tick(1_000);
    assert.equal(await executor.processNext(), true);
    const status = await server.inject(path + '/status?' + new URLSearchParams({ requestId }));
    assert.equal(status.statusCode, 200);
    const { run } = status.json();
    assert.equal(run.runId, submitted.json().runId);
    assert.deepEqual(
      [run.status, run.phase, run.reasonCode],
      windowClosed ? ['BLOCKED', 'blocked', 'maintenance_window_closed'] : ['UNKNOWN', 'recovery_required', 'runner_interrupted'],
    );
  }
});
