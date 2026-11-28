import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createDeploymentEdge } from './initial-publication.mjs';
import { publishInitialFrontend } from '../../deployment/bootstrap/publish-frontend.mjs';

const origin = 'https://deploy.example.com';
const accountId = 'a'.repeat(32);
const zoneId = 'b'.repeat(32);
const tunnelId = '10000000-0000-4000-8000-000000000000';
const oldVersion = '10000000-0000-4000-8000-000000000001';
const newVersion = '10000000-0000-4000-8000-000000000002';
const deploymentId = '10000000-0000-4000-8000-000000000003';
const workerId = 'e'.repeat(32);
const artifactDigest = 'sha256:' + 'e'.repeat(64);
const workerPath = `/client/v4/accounts/${accountId}/workers/scripts/codexia-frontend`;
const workerResource = `/client/v4/accounts/${accountId}/workers/workers/codexia-frontend`;
const workerResourceById = `/client/v4/accounts/${accountId}/workers/workers/${workerId}`;
const accountPath = `/client/v4/accounts/${accountId}`;
const zonePath = `/client/v4/zones/${zoneId}`;
const authorPolicyId = '10000000-0000-4000-8000-000000000004';
const ciPolicyId = '10000000-0000-4000-8000-000000000005';
const tokenId = '10000000-0000-4000-8000-000000000006';
const hostname = 'deploy.example.com';
const apps = ['', '/api/version', '/desktop/update-identity.json'].map((path, index) => ({
  domain: hostname + path,
  id: `20000000-0000-4000-8000-00000000000${index}`,
  aud: String(index).repeat(64),
  type: 'self_hosted',
}));
const controls = { _headers: 'certified headers', _redirects: 'certified redirects' };
const controlsSha256 = Object.fromEntries(Object.entries(controls).map(([name, content]) =>
  [name, createHash('sha256').update(content).digest('hex')]));

function fixture() {
  const writes = [];
  const state = { preview: false, activeVersion: oldVersion, uploadTag: null, replyLost: false, alias: false,
    scriptAbsent: false, inventoryDenied: false, backendAbsent: false, frontendDenied: false,
    workerId, initialUpload: null, previousDeploymentEvidence: false, controlsChanged: false,
    setupRoutes: false, setupExposed: false,
    candidateIdentity: null, rejectPromotion: false, uploadCount: 0,
    publicEpoch: 1, publicAuth: ['cookie-owner', 'bearer-read-compute-propose'] };
  const apiResponse = result => Response.json({ success: true, errors: [], result });
  const client = createDeploymentEdge({
    origin, accountId, zoneId, tunnelId,
    authorPolicyId, ciPolicyId, tunnelTeamName: 'codexia-test', publicProtocolEnabled: false,
    readToken: 'read-secret', workerToken: 'worker-secret',
    accessEnv: { CODEXIA_PUBLIC_ORIGIN: origin, CODEXIA_ACCESS_CLIENT_ID: 'identity-id', CODEXIA_ACCESS_CLIENT_SECRET: 'identity-secret' },
    uploadVersion: async ({ tag }) => {
      state.uploadCount++;
      state.uploadTag = tag;
      return newVersion;
    },
    readInitialWorkerControls: async () => controlsSha256,
    uploadInitialVersion: async ({ workerId: targetWorker, tag, initialControls }) => {
      state.uploadCount++;
      state.initialUpload = { targetWorker, tag, initialControls };
      state.uploadTag = tag;
      return newVersion;
    },
    async fetchImpl(url, init) {
      const target = new URL(url);
      const method = init.method ?? 'GET';
      if (target.origin === origin) {
        if (state.setupExposed && target.pathname === '/console/setup') return new Response('Setup UI');
        if (init.headers['CF-Access-Client-Id'] && target.pathname === '/api/version') {
          if (state.backendAbsent) return new Response('Unavailable', { status: 502 });
          return Response.json({ name: 'codexia', profile: 'full', version: '1.0.0', apiEpoch: state.publicEpoch, auth: state.publicAuth });
        }
        if (init.headers['CF-Access-Client-Id'] && target.pathname === '/desktop/update-identity.json') {
          if (state.frontendDenied) return new Response('Denied', { status: 403 });
          if (state.candidateIdentity && state.activeVersion === newVersion) return Response.json(state.candidateIdentity);
          return Response.json({ format: 'codexia-frontend-identity/v1', version: '1.0.0', profile: 'full', sourceSha: 'f'.repeat(40), apiEpoch: 1 });
        }
        return new Response('Cloudflare Access denied', { status: 403 });
      }
      assert.equal(target.origin, 'https://api.cloudflare.com');
      const path = target.pathname;
      if (method === 'POST' || method === 'PATCH') {
        writes.push({ path, method, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      } else {
        assert.equal(init.headers.Authorization, 'Bearer read-secret');
      }
      if (path === accountPath + '/workers/workers') {
        if (state.inventoryDenied) return new Response('Denied', { status: 403 });
        return apiResponse([
          ...(!state.scriptAbsent ? [{ id: state.workerId, name: 'codexia-frontend',
            deployed_on: state.activeVersion || state.previousDeploymentEvidence ? '2026-11-23T12:00:00Z' : null,
            subdomain: { enabled: false, previews_enabled: state.preview } }] : []),
        ]);
      }
      if (path === workerPath + '/deployments') {
        if (method === 'POST') {
          if (state.rejectPromotion) return new Response('Unavailable', { status: 503 });
          state.activeVersion = writes.at(-1).body.versions[0].version_id;
          if (state.replyLost) throw new Error('connection reset');
        }
        const deployment = { id: deploymentId, created_on: '2026-11-23T12:00:00Z', strategy: 'percentage', versions: [{ version_id: state.activeVersion, percentage: 100 }] };
        return apiResponse(method === 'GET' ? { deployments: state.activeVersion === null ? [] : [deployment] } : deployment);
      }
      if (path === workerResource || path.startsWith(workerResource + '/versions/')) {
        return new Response('Worker ID required', { status: 404 });
      }
      if (path === workerResourceById + '/versions/' + newVersion) {
        const includeModules = target.searchParams.get('include') === 'modules';
        return apiResponse({ id: newVersion, urls: [], annotations: { 'workers/tag': state.uploadTag },
          ...(includeModules ? { assets: { config: { html_handling: 'none', not_found_handling: 'none' } },
            modules: Object.entries(controls).map(([name, content]) => ({ name, content_type: 'text/plain',
              content_base64: Buffer.from(state.controlsChanged && name === '_headers' ? 'altered' : content).toString('base64') })),
          } : {}),
        });
      }
      if (path === workerResourceById + '/versions/' + oldVersion) return apiResponse({ id: oldVersion, urls: [] });
      if (path === zonePath + '/dns_records') return apiResponse([{ id: 'f'.repeat(32), name: hostname, proxied: true, type: 'CNAME', content: tunnelId + '.cfargotunnel.com' }]);
      if (path === zonePath + '/workers/routes') {
        if (state.setupRoutes) return apiResponse([
          { pattern: hostname + '/console/setup', script: 'unexpected-setup-worker' },
        ]);
        if (state.scriptAbsent) return apiResponse([]);
        const routes = [{ pattern: hostname + '/*', script: 'codexia-frontend' },
          ...['/api*', '/health*', '/mcp*', '/.well-known/*'].map(route => ({ pattern: hostname + route, script: null }))];
        if (state.alias) routes.push({ pattern: 'alias.example.com/*', script: 'codexia-frontend' });
        return apiResponse(routes);
      }
      if (path === accountPath + '/workers/domains') return apiResponse([]);
      if (path === accountPath + '/access/apps') return apiResponse(apps);
      if (path.endsWith('/policies')) {
        const index = apps.findIndex(app => path === accountPath + '/access/apps/' + app.id + '/policies');
        assert.ok(index >= 0);
        const allow = { id: authorPolicyId, decision: 'allow', precedence: index ? 2 : 1 };
        const service = { id: ciPolicyId, decision: 'non_identity', precedence: 1, include: [{ service_token: { token_id: tokenId } }] };
        return apiResponse(index ? [service, allow] : [allow]);
      }
      if (path === accountPath + '/cfd_tunnel/' + tunnelId + '/configurations') {
        const ingress = ['^/api/version$', '^/desktop/update-identity\\.json$', undefined].map((path, index) => ({
          hostname, path, service: 'http://codexia-api:3000',
          originRequest: { httpHostHeader: hostname, access: { required: true, teamName: 'codexia-test',
            audTag: path ? [apps[index + 1].aud, apps[0].aud] : [apps[0].aud] } },
        }));
        return apiResponse({ tunnel_id: tunnelId, account_id: accountId, source: 'cloudflare',
          config: { ingress: [...ingress, { service: 'http_status:404' }] } });
      }
      assert.fail('Unexpected API request: ' + path);
    },
  });
  return { client, state, writes };
}

test('owner enrollment uses the normal Worker routes and rejects a distinct setup route', async () => {
  const { client, state, writes } = fixture();
  state.backendAbsent = true;
  const request = { backendExpected: false, ownerSetup: true };
  const result = await client.observeLifecycle(request);
  assert.equal(result.frontendState, 'running');
  assert.equal(result.routesReady, true);
  assert.equal(result.publicProtocolEnabled, false);
  assert.equal(result.deployment.versionId, oldVersion);
  state.setupRoutes = true;
  await assert.rejects(client.observeLifecycle(request), /alternate ingress/u);
  state.setupRoutes = false;
  state.setupExposed = true;
  await assert.rejects(client.observeLifecycle(request), /ACCESS_BOUNDARY/u);
  assert.deepEqual(writes, []);
});

test('upload binds archive digest to a version while the old version stays the only deployment', async () => {
  const { client, state, writes } = fixture();
  const staged = await client.stage({ previousVersionId: oldVersion, artifactDigest });
  assert.equal(staged.versionId, newVersion);
  assert.match(staged.tag, /e{64}/u);
  assert.equal(state.activeVersion, oldVersion);
  assert.deepEqual(writes, []);
  state.uploadTag = 'unexpected-artifact';
  await assert.rejects(client.assertStaged({ versionId: newVersion, artifactDigest }), /tag/u);
});

test('first activation stages a version with no deployment and promotes under canonical Access', async () => {
  const { client, state, writes } = fixture();
  state.scriptAbsent = true;
  state.activeVersion = null;
  state.backendAbsent = true;
  const missing = await client.observeLifecycle({ backendExpected: false });
  assert.equal(missing.workerId, null);
  assert.equal(missing.routesReady, false);
  await assert.rejects(client.stage({ previousVersionId: null, artifactDigest }), /unused private Worker/u);
  assert.equal(state.initialUpload, null);
  state.scriptAbsent = false; // A separately approved infrastructure apply creates the worker and its canonical routes.
  const pending = await client.observeLifecycle({ backendExpected: false });
  assert.equal(pending.frontendState, 'absent');
  assert.equal(pending.workerId, workerId);
  assert.equal(pending.routesReady, true);
  state.previousDeploymentEvidence = true;
  await assert.rejects(client.stage({ previousVersionId: null, artifactDigest }), /unused private Worker/u);
  assert.equal(state.initialUpload, null);
  state.previousDeploymentEvidence = false;
  state.controlsChanged = true;
  await assert.rejects(client.stage({ previousVersionId: null, artifactDigest }), /certified archive/u);
  state.controlsChanged = false;
  const staged = await client.stage({ previousVersionId: null, artifactDigest });
  assert.equal(staged.versionId, newVersion);
  assert.deepEqual(staged.initialControls, controlsSha256);
  assert.deepEqual(state.initialUpload, { targetWorker: workerId, tag: 'frontend-' + artifactDigest.slice(7), initialControls: controlsSha256 });
  const expected = { versionId: newVersion, artifactDigest, initialControls: await client.readInitialWorkerControls() };
  assert.equal((await client.assertStaged(expected)).versionId, newVersion);
  state.controlsChanged = true;
  await assert.rejects(client.assertStaged(expected), /certified archive/u);
  await assert.rejects(client.assertWorkerArtifact(expected), /certified archive/u);
  state.controlsChanged = false;
  assert.equal(state.activeVersion, null);
  await client.deployForOwnerEnrollment({ observed: pending, staged, artifactDigest });
  assert.equal(state.activeVersion, newVersion);
  assert.equal((await client.observeIngress({ lifecycle: true })).ingressDigest, pending.ingressDigest);
  assert.equal(writes.filter(entry => entry.method === 'POST').length, 1);
});

test('candidate upload fails before using the upload credential when previews are enabled', async () => {
  const { client, state } = fixture();
  state.preview = true;
  await assert.rejects(client.stage({ previousVersionId: oldVersion, artifactDigest }), /preview/u);
  assert.equal(state.uploadTag, null);
});

test('ingress proof rejects Worker aliases', async () => {
  const { client, state, writes } = fixture();
  const before = await client.observeIngress();
  assert.match(before.ingressDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(before.origin, origin);
  assert.equal(before.deployment.createdAt, '2026-11-23T12:00:00.000Z');
  state.alias = true;
  await assert.rejects(client.observeIngress(), /alternate ingress/u);
  state.alias = false;
  assert.deepEqual(writes, []);
});

test('lifecycle inventory distinguishes confirmed empty deployment from denied observations without writes', async () => {
  const { client, state, writes } = fixture();
  state.scriptAbsent = true;
  state.backendAbsent = true;
  const absent = await client.observeLifecycle({ backendExpected: false });
  assert.equal(absent.frontendState, 'absent');
  assert.equal(absent.deployment, null);
  assert.equal(absent.backend, null);
  state.inventoryDenied = true;
  await assert.rejects(client.observeLifecycle({ backendExpected: false }));
  state.inventoryDenied = false;
  state.backendAbsent = false;
  await assert.rejects(client.observeLifecycle({ backendExpected: false }), /contradicts/);
  assert.deepEqual(writes, []);
});

test('lifecycle observation preserves legacy backend identity and does not infer absence from a denied frontend probe', async () => {
  const { client, state, writes } = fixture();
  state.frontendDenied = true;
  const observed = await client.observeLifecycle({ backendExpected: true });
  assert.equal(observed.frontendState, 'unknown');
  assert.equal(observed.backend.apiEpoch, 1);
  assert.equal(observed.backend.standaloneOAuth, false);
  assert.deepEqual(writes, []);
});

// Execute the same R5 publication controller and Cloudflare adapter used by the
// protected dispatch, with only the external HTTP/upload/record boundaries replaced.
const enrollmentCandidate = {
  identity: { format: 'codexia-frontend-identity/v1', sourceSha: 'a'.repeat(40),
    version: '1.2.3', profile: 'full', apiEpoch: 3 },
  artifactDigest: artifactDigest.slice(7), artifactId: 70, runId: 80, producerAttempt: 2,
};

async function enrollmentFixture({ empty = false } = {}) {
  const f = fixture();
  f.state.backendAbsent = true;
  f.state.candidateIdentity = enrollmentCandidate.identity;
  if (empty) f.state.activeVersion = null;
  const records = [];
  const observe = () => f.client.observeLifecycle({ backendExpected: false, ownerSetup: true });
  const publish = async (overrides = {}) => publishInitialFrontend({
    edge: f.client, observed: await observe(), candidate: enrollmentCandidate,
    context: { repository: 'example-org/codexia', repositoryId: 321, ownerId: 123 },
    assertCurrentSource: async () => {}, recordRelease: async record => records.push(record),
    ...overrides,
  });
  return { ...f, records, observe, publish };
}

test('R5 publishes the first version of the canonical private Worker and records its certified source', async () => {
  const f = await enrollmentFixture({ empty: true });
  assert.deepEqual(await f.publish(), { deployed: true, releaseTag: 'frontend-v1.2.3' });
  assert.equal(f.state.initialUpload.targetWorker, workerId);
  assert.equal(f.state.activeVersion, newVersion);
  assert.equal(f.state.uploadCount, 1);
  assert.deepEqual(f.writes.map(({ method, auth }) => [method, auth]), [['POST', 'Bearer worker-secret']]);
  assert.equal(f.records[0].targetSha, enrollmentCandidate.identity.sourceSha);
  assert.equal(f.records[0].metadata.worker, 'codexia-frontend');
  assert.equal(f.records[0].metadata.repository, 'example-org/codexia');
  assert.equal(f.records[0].metadata.repositoryId, 321);
  assert.equal(f.records[0].metadata.ownerId, 123);
  assert.equal(f.records[0].metadata.requiredApiEpoch, 3);
});

test('R5 replaces only the observed older Worker version and reconciles a lost promotion response', async () => {
  const f = await enrollmentFixture();
  f.state.replyLost = true;
  assert.equal((await f.publish()).deployed, true);
  assert.equal(f.state.initialUpload, null);
  assert.equal(f.state.uploadCount, 1);
  assert.equal(f.state.activeVersion, newVersion);
  assert.equal(f.records.length, 1);
  assert.equal(f.writes.length, 1);
  assert.equal((await f.publish()).deployed, false);
  assert.equal(f.state.uploadCount, 1);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.records[1], f.records[0]);
});

test('R5 never records failed publication; retries an already active version when recording failed', async () => {
  const f = await enrollmentFixture({ empty: true });
  f.state.rejectPromotion = true;
  await assert.rejects(f.publish());
  assert.equal(f.state.activeVersion, null);
  assert.equal(f.records.length, 0);
  f.state.rejectPromotion = false;
  await assert.rejects(f.publish({ recordRelease: async () => { throw new Error('record unavailable'); } }), /record unavailable/u);
  assert.equal(f.state.activeVersion, newVersion);
  const uploads = f.state.uploadCount;
  const writes = f.writes.length;
  assert.equal((await f.publish()).deployed, false);
  assert.equal(f.state.uploadCount, uploads);
  assert.equal(f.writes.length, writes);
  assert.equal(f.records.length, 1);
});

test('R5 refuses changed ingress before promotion and never records an unverified candidate', async () => {
  const f = await enrollmentFixture();
  let sourceChecks = 0;
  await assert.rejects(f.publish({ assertCurrentSource: async () => {
    if (++sourceChecks === 2) f.state.alias = true;
  } }), /alternate ingress/u);
  assert.equal(f.writes.length, 0);
  assert.equal(f.records.length, 0);
  f.state.alias = false;
  f.state.candidateIdentity = { ...enrollmentCandidate.identity, apiEpoch: 2 };
  await assert.rejects(f.publish(), /API epoch|identity|immutable/u);
  assert.equal(f.records.length, 0);
});
