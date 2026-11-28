import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createDeploymentEdge, runInitialWorkerUpload } from './initial-publication.mjs';
import { publishInitialFrontend } from '../../deployment/bootstrap/publish-frontend.mjs';

const origin = 'https://deploy.example.com';
const accountId = 'a'.repeat(32);
const zoneId = 'b'.repeat(32);
const tunnelId = '10000000-0000-4000-8000-000000000000';
const oldVersion = '10000000-0000-4000-8000-000000000001';
const newVersion = '10000000-0000-4000-8000-000000000002';
const retriedVersion = '10000000-0000-4000-8000-000000000007';
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
const sshPolicyId = '10000000-0000-4000-8000-000000000006';
const repositoryId = 10;
const hostname = 'deploy.example.com';
const sshHostname = 'manage.example.com';
const apps = [hostname, hostname + '/api/version', hostname + '/desktop/update-identity.json', sshHostname].map((domain, index) => ({
  domain,
  id: `20000000-0000-4000-8000-00000000000${index}`,
  aud: String(index).repeat(64),
  type: 'self_hosted',
}));
const controls = { _headers: 'certified headers', _redirects: 'certified redirects' };
const controlsSha256 = Object.fromEntries(Object.entries(controls).map(([name, content]) =>
  [name, createHash('sha256').update(content).digest('hex')]));
const certifiedAssets = () => new Map(Object.entries({ ...controls, 'index.html': '<html>test</html>',
  'assets/app.js': 'export {};' }).map(([name, content]) => [name, Buffer.from(content)]));

function fixture() {
  const writes = [];
  const state = { preview: false, activeVersion: oldVersion, uploadTag: null, replyLost: false, alias: false,
    scriptAbsent: false, inventoryDenied: false, backendAbsent: false, frontendDenied: false,
    workerId, initialUpload: null, previousDeploymentEvidence: false, controlsChanged: false,
    setupRoutes: false, setupExposed: false, foreignSshTag: false, bypassPublicationGate: false,
    candidateIdentity: null, rejectPromotion: false, uploadCount: 0, initialUploadReplyLost: false, initialVersionId: newVersion,
    uploadedInitialVersions: new Set(),
    publicEpoch: 1, publicAuth: ['cookie-owner', 'bearer-read-compute-propose'] };
  const apiResponse = result => Response.json({ success: true, errors: [], result });
  const client = createDeploymentEdge({
    origin, accountId, zoneId, tunnelId, repositoryId,
    authorPolicyId, ciPolicyId, sshHostname, sshPolicyId, tunnelTeamName: 'codexia-test', publicProtocolEnabled: false,
    readToken: 'read-secret', workerToken: 'worker-secret',
    accessEnv: { CODEXIA_PUBLIC_ORIGIN: origin, CODEXIA_ACCESS_CLIENT_ID: 'identity-id', CODEXIA_ACCESS_CLIENT_SECRET: 'identity-secret' },
    uploadVersion: async ({ tag }) => {
      state.uploadCount++;
      state.uploadTag = tag;
      return newVersion;
    },
    readInitialWorkerAssets: async digest => {
      assert.equal(digest, artifactDigest);
      return certifiedAssets();
    },
    uploadInitialVersion: async ({ workerId: targetWorker, tag, assets }) => {
      state.uploadCount++;
      state.initialUpload = { targetWorker, tag, assets };
      state.uploadTag = tag;
      state.uploadedInitialVersions.add(state.initialVersionId);
      if (state.initialUploadReplyLost) throw new Error('initial version upload response lost');
      return state.initialVersionId;
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
      if ([newVersion, retriedVersion].some(versionId => path === workerResourceById + '/versions/' + versionId)) {
        const includeModules = target.searchParams.get('include') === 'modules';
        return apiResponse({ id: path.split('/').at(-1), urls: [], annotations: { 'workers/tag': state.uploadTag },
          ...(includeModules ? { assets: { config: { html_handling: 'none', not_found_handling: 'none' } },
            modules: Object.entries(controls).map(([name, content]) => ({ name, content_type: 'text/plain',
              content_base64: Buffer.from(state.controlsChanged && name === '_headers' ? 'altered' : content).toString('base64') })),
          } : {}),
        });
      }
      if (path === workerResourceById + '/versions/' + oldVersion) return apiResponse({ id: oldVersion, urls: [] });
      if (path === zonePath + '/dns_records') {
        const name = target.searchParams.get('name');
        return apiResponse([{ id: (name === hostname ? 'f' : 'd').repeat(32), name, proxied: true, type: 'CNAME',
          content: tunnelId + '.cfargotunnel.com' }]);
      }
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
        const include = value => ({ service_token_tag: { key: 'codexia-scope', value } });
        if (apps[index].domain === sshHostname) {
          return apiResponse([{ id: sshPolicyId, decision: 'non_identity', precedence: 1,
            include: [include('repo-10-ssh-codexia-bootstrap'),
              include(state.foreignSshTag ? 'repo-11-ssh-codexia-production' : 'repo-10-ssh-codexia-production')] }]);
        }
        const allow = { id: authorPolicyId, decision: 'allow', precedence: index ? 2 : 1 };
        const service = { id: ciPolicyId, decision: 'non_identity', precedence: 1, include: [include('repo-10-probe-codexia-production')] };
        return apiResponse(index ? [service, allow] : [allow]);
      }
      if (path === accountPath + '/cfd_tunnel/' + tunnelId + '/configurations') {
        const ingress = ['^/api/version$', '^/desktop/update-identity\\.json$', undefined].map((path, index) => ({
          hostname, path, service: state.bypassPublicationGate ? 'http://127.0.0.1:18081' : 'http://127.0.0.1:18080',
          originRequest: { httpHostHeader: hostname, access: { required: true, teamName: 'codexia-test',
            audTag: path ? [apps[index + 1].aud, apps[0].aud] : [apps[0].aud] } },
        }));
        return apiResponse({ tunnel_id: tunnelId, account_id: accountId, source: 'cloudflare',
          config: { ingress: [...ingress,
            { hostname: sshHostname, service: 'ssh://127.0.0.1:22',
              originRequest: { access: { required: true, teamName: 'codexia-test', audTag: [apps.at(-1).aud] } } },
            { service: 'http_status:404' }] } });
      }
      assert.fail('Unexpected API request: ' + path);
    },
  });
  return { client, state, writes };
}

test('edge observation refuses foreign SSH tags and direct ingress to the API', async () => {
  const { client, state, writes } = fixture();
  state.foreignSshTag = true;
  await assert.rejects(client.observeIngress(), /repository and purpose tags/u);
  state.foreignSshTag = false;
  state.bypassPublicationGate = true;
  await assert.rejects(client.observeIngress(), /Tunnel ingress endpoint/u);
  assert.deepEqual(writes, []);
});

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
  assert.deepEqual(state.initialUpload, { targetWorker: workerId, tag: 'frontend-' + artifactDigest.slice(7), assets: certifiedAssets() });
  const expected = { versionId: newVersion, artifactDigest, initialControls: controlsSha256 };
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

test('a lost first-version response leaves traffic unchanged and retry promotes only its confirmed version', async () => {
  const { client, state, writes } = fixture();
  state.activeVersion = null;
  state.backendAbsent = true;
  state.initialUploadReplyLost = true;
  const observed = await client.observeLifecycle({ backendExpected: false });
  await assert.rejects(client.stage({ previousVersionId: null, artifactDigest }), /response lost/u);
  assert.equal(state.activeVersion, null);
  assert.deepEqual(writes, []);
  state.initialUploadReplyLost = false;
  state.initialVersionId = retriedVersion;
  const staged = await client.stage({ previousVersionId: null, artifactDigest });
  assert.equal(staged.versionId, retriedVersion);
  assert.deepEqual(state.uploadedInitialVersions, new Set([newVersion, retriedVersion]));
  assert.equal(state.activeVersion, null);
  assert.deepEqual(writes, []);
  await client.deployForOwnerEnrollment({ observed, staged, artifactDigest });
  assert.equal(state.activeVersion, retriedVersion);
  assert.deepEqual(writes.map(entry => entry.body.versions), [[{ version_id: retriedVersion, percentage: 100 }]]);
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

test('first Worker upload registers certified assets and creates a version without deploying', async () => {
  const requests = [];
  let hashes;
  const tag = 'frontend-' + artifactDigest.slice(7);
  const version = await runInitialWorkerUpload({
    accountId, workerId, workerToken: 'worker-secret', tag, assets: certifiedAssets(),
    mimeLookup: name => name.endsWith('.html') ? 'text/html' : 'text/javascript',
    async fetchImpl(url, init) {
      const target = new URL(url);
      assert.equal(target.origin, 'https://api.cloudflare.com');
      assert.equal(init.redirect, 'error');
      assert.equal(init.method, 'POST');
      requests.push(target.pathname);
      const response = (result, status = 200) => Response.json({ success: true, result, errors: [] }, { status });
      if (requests.length === 1) {
        assert.equal(target.pathname, workerPath + '/assets-upload-session');
        assert.equal(init.headers.Authorization, 'Bearer worker-secret');
        const { manifest } = JSON.parse(init.body);
        assert.deepEqual(Object.keys(manifest).sort(), ['/assets/app.js', '/index.html']);
        assert.equal(manifest['/index.html'].size, 17);
        assert.equal(manifest['/index.html'].hash,
          createHash('sha256').update(Buffer.from('<html>test</html>').toString('base64') + 'html').digest('hex').slice(0, 32));
        hashes = [manifest['/index.html'].hash, manifest['/assets/app.js'].hash];
        return response({ jwt: 'upload-token', buckets: hashes.map(hash => [hash]) });
      }
      if (requests.length === 2 || requests.length === 3) {
        assert.equal(target.pathname, accountPath + '/workers/assets/upload');
        assert.equal(target.search, '?base64=true');
        assert.equal(init.headers.Authorization, 'Bearer upload-token');
        const i = requests.length - 2;
        const [[hash, file]] = [...init.body.entries()];
        assert.equal(hash, hashes[i]);
        assert.equal(file.type, i ? 'text/javascript' : 'text/html');
        assert.equal(Buffer.from(await file.text(), 'base64').toString(), i ? 'export {};' : '<html>test</html>');
        return i ? response({ jwt: 'completion-token' }, 201) : response(undefined);
      }
      assert.equal(target.pathname, workerResourceById + '/versions');
      assert.equal(target.search, '?deploy=false');
      assert.equal(init.headers.Authorization, 'Bearer worker-secret');
      const body = JSON.parse(init.body);
      assert.equal(body.assets.jwt, 'completion-token');
      assert.deepEqual(body.assets.config, { html_handling: 'none', not_found_handling: 'none' });
      assert.equal(body.annotations['workers/tag'], tag);
      assert.deepEqual(body.modules, Object.entries(controls).map(([name, content]) =>
        ({ name, content_type: 'text/plain', content_base64: Buffer.from(content).toString('base64') })));
      return response({ id: newVersion, urls: [] });
    },
  });
  assert.equal(version, newVersion);
  assert.equal(requests.length, 4);
});

test('first Worker upload rejects unknown buckets and incomplete uploads without creating a version', async () => {
  for (const { unknown, result, status, error } of [
    { unknown: true, result: {}, status: 200, error: /requested asset hash/u },
    { unknown: false, result: {}, status: 200, error: /completed asset upload token/u },
    { unknown: false, result: undefined, status: 201, error: /asset upload failed/u },
    { unknown: false, result: null, status: 201, error: /asset upload failed/u },
  ]) {
    const paths = [];
    await assert.rejects(runInitialWorkerUpload({
      accountId, workerId, workerToken: 'worker-secret', tag: 'frontend-' + artifactDigest.slice(7),
      assets: certifiedAssets(), mimeLookup: () => 'text/html',
      async fetchImpl(url, init) {
        const path = new URL(url).pathname;
        paths.push(path);
        assert.ok(!path.endsWith('/versions'));
        if (paths.length === 1) {
          return Response.json({ success: true, errors: [], result: {
            jwt: 'upload-token',
            buckets: [[unknown ? 'unknown' : JSON.parse(init.body).manifest['/index.html'].hash]],
          } });
        }
        return Response.json({ success: true, errors: [], result }, { status });
      },
    }), error);
    assert.equal(paths.length, unknown ? 1 : 2);
  }
  const assets = certifiedAssets();
  assets.delete('_headers');
  await assert.rejects(runInitialWorkerUpload({
    accountId, workerId, workerToken: 'worker-secret', tag: 'frontend-' + artifactDigest.slice(7),
    assets, mimeLookup: () => 'text/html',
    fetchImpl: () => assert.fail('Missing publication controls must be rejected before any API request'),
  }), /Missing certified frontend publication control/u);
});

test('first Worker version uses a completed asset session without reuploading assets', async () => {
  const calls = [];
  const version = await runInitialWorkerUpload({
    accountId, workerId, workerToken: 'worker-secret', tag: 'frontend-' + artifactDigest.slice(7),
    assets: certifiedAssets(), mimeLookup: () => 'text/plain',
    async fetchImpl(url, init) {
      const { pathname, search } = new URL(url);
      calls.push(pathname + search);
      const result = pathname.endsWith('/assets-upload-session')
        ? { jwt: 'completed-session-token', buckets: [] }
        : { id: newVersion, urls: [] };
      if (pathname.endsWith('/versions')) assert.equal(JSON.parse(init.body).assets.jwt, 'completed-session-token');
      return Response.json({ success: true, result });
    },
  });
  assert.equal(version, newVersion);
  assert.deepEqual(calls, [workerPath + '/assets-upload-session', workerResourceById + '/versions?deploy=false']);
});

test('first Worker upload stops on an HTTP redirect before forwarding credentials or assets', async t => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization });
    request.resume();
    response.writeHead(307, { location: '/unapproved' }).end();
  });
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  await assert.rejects(runInitialWorkerUpload({
    accountId, workerId, workerToken: 'worker-secret', tag: 'frontend-' + artifactDigest.slice(7),
    assets: certifiedAssets(), mimeLookup: () => 'text/plain',
    fetchImpl(url, init) {
      const { origin: destination, pathname, search } = new URL(url);
      assert.equal(destination, 'https://api.cloudflare.com');
      return fetch(`http://127.0.0.1:${server.address().port}${pathname}${search}`, init);
    },
  }), { message: 'Cloudflare asset upload session response could not be verified' });
  assert.deepEqual(requests, [{ url: workerPath + '/assets-upload-session', method: 'POST', authorization: 'Bearer worker-secret' }]);
});
