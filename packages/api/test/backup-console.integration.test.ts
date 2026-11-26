import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { BackupConsoleExecutor, pythonBackupProbe } from '../src/backup-console-executor.js';
import type { BackupPolicy } from '../src/backup-console-routes.js';
import { BackupConsoleStore } from '../src/backup-console-store.js';
import { backupCredentialKeyId } from '../src/backup-credential-envelope.js';
import { createServer } from '../src/server.js';
import { assertDisposableAuthFixtureDatabaseUrl, startBetterAuthFixture } from './fixtures/better-auth-server.js';

test('backup console requires owner proof, isolates credentials, and applies only verified executor results', async t => {
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
    async probe(revision, credential) {
      assert.equal(revision.destination.endpoint, draft.endpoint);
      assert.equal(credential.accessKeyId, draft.accessKeyId);
      assert.equal(credential.secretAccessKey, revision.revision < 3 ? draft.secretAccessKey : 'test-rotated-credential');
      probes++;
      return realProbe ? realProbe(revision, credential) : { state: 'PASSED', reason: null };
    },
  });
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
  for (const outOfScope of ['/runs', '/recovery', '/restore', '/config/iam']) {
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
  const accepted = await post('activate', activation, activationRequest);
  assert.equal(accepted.status, 202);
  const receipt = await accepted.json();
  assert.deepEqual(await (await post('activate', activation, activationRequest)).json(), receipt);
  assert.equal((await post('activate', activation)).status, 409);
  assert.equal((await (await get('/status')).json()).activeRevision, null);
  await worker.processNext();
  const active = await (await get('/status?requestId=' + activationRequest)).json();
  assert.equal(active.activeRevision, 2);
  assert.equal(active.operation.status, 'APPLIED');
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
  assert.equal((await get('/status?requestId=unrecognized-request-id')).status, 404);
  assert.equal((await put({ ...nonSecret, offVmPolicy: 'required', retentionRequest: { days: 30 } }, '"3"')).status, 200);
  const retentionProbe = await post('probes', { revision: 4 });
  assert.equal(retentionProbe.status, 202);
  const { probeId: retentionProbeId } = (await retentionProbe.json()) as { probeId: string };
  await worker.processNext();
  assert.equal((await (await get('/config/probes/' + retentionProbeId)).json()).status, 'PASSED');
  const retentionId = randomUUID();
  assert.equal((await post('activate', { revision: 4, probeId: retentionProbeId, confirmed: true }, retentionId)).status, 202);
  await worker.processNext();
  const retentionStatus = await (await get('/status?requestId=' + retentionId)).json();
  assert.equal(retentionStatus.activeRevision, 3);
  assert.equal(retentionStatus.operation.status, 'BLOCKED');
  assert.equal(retentionStatus.operation.reasonCode, 'retention_unverified');
  await workerPool.query("UPDATE codexia_backup.operations SET observed_at = now() - interval '20 minutes' WHERE id = $1", [
    retentionProbeId,
  ]);
  assert.equal((await post('activate', { revision: 4, probeId: retentionProbeId, confirmed: true })).status, 409);

  await fixture.expireOwnerFreshProof();
  assert.equal((await get('/config')).status, 200);
  assert.equal((await put(draft, '"4"')).status, 403);
  assert.equal((await post('disable', { revision: 2, confirmed: true })).status, 403);
  assert.equal((await post('activate', activation, activationRequest)).status, 403);
});
