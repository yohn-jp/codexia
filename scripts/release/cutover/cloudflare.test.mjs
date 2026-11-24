import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFenceExpression, createCloudflareCutover, FENCE_RESPONSE } from './cloudflare.mjs';

const origin = 'https://cutover.example.com';
const accountId = 'a'.repeat(32);
const zoneId = 'b'.repeat(32);
const fenceRuleId = 'c'.repeat(32);
const rulesetId = 'd'.repeat(32);
const tunnelId = '10000000-0000-4000-8000-000000000000';
const oldVersion = '10000000-0000-4000-8000-000000000001';
const newVersion = '10000000-0000-4000-8000-000000000002';
const deploymentId = '10000000-0000-4000-8000-000000000003';
const artifactDigest = 'sha256:' + 'e'.repeat(64);
const workerPath = `/client/v4/accounts/${accountId}/workers/scripts/codexia-frontend`;
const accountPath = `/client/v4/accounts/${accountId}`;
const zonePath = `/client/v4/zones/${zoneId}`;
const rulesPath = `/client/v4/zones/${zoneId}/rulesets`;
const expression = '(http.host eq "cutover.example.com" and not ((http.request.method eq "GET" and http.request.uri.path eq "/api/version" and raw.http.request.uri.path eq "/api/version") or (http.request.method eq "GET" and http.request.uri.path eq "/desktop/update-identity.json" and raw.http.request.uri.path eq "/desktop/update-identity.json")))';
const authorPolicyId = '10000000-0000-4000-8000-000000000004';
const ciPolicyId = '10000000-0000-4000-8000-000000000005';
const tokenId = '10000000-0000-4000-8000-000000000006';
const hostname = 'cutover.example.com';
const apps = ['', '/api/version', '/desktop/update-identity.json'].map((path, index) => ({
  domain: hostname + path,
  id: `20000000-0000-4000-8000-00000000000${index}`,
  aud: String(index).repeat(64),
  type: 'self_hosted',
}));

function fixture() {
  const writes = [];
  const state = { enabled: false, preview: false, activeVersion: oldVersion, uploadTag: null, replyLost: false, alias: false, ipAllow: false,
    scriptAbsent: false, inventoryDenied: false, backendAbsent: false, frontendDenied: false,
    publicEpoch: 1, publicAuth: ['cookie-owner', 'bearer-read-compute-propose'] };
  const rule = () => ({
    id: fenceRuleId,
    ref: 'codexia-epoch-cutover',
    description: 'Codexia maintenance fence',
    enabled: state.enabled,
    expression,
    action: 'block',
    action_parameters: { response: { status_code: 403, content_type: 'text/plain', content: 'Codexia maintenance fence' } },
  });
  const apiResponse = result => Response.json({ success: true, errors: [], result });
  const client = createCloudflareCutover({
    origin, accountId, zoneId, tunnelId, fenceRuleId,
    authorPolicyId, ciPolicyId, tunnelTeamName: 'codexia-test', publicProtocolEnabled: false,
    readToken: 'read-secret', workerToken: 'worker-secret', fenceToken: 'waf-secret',
    accessEnv: { CODEXIA_PUBLIC_ORIGIN: origin, CODEXIA_ACCESS_CLIENT_ID: 'identity-id', CODEXIA_ACCESS_CLIENT_SECRET: 'identity-secret' },
    uploadVersion: async ({ tag }) => {
      state.uploadTag = tag;
      return newVersion;
    },
    async fetchImpl(url, init) {
      const target = new URL(url);
      const method = init.method ?? 'GET';
      if (target.origin === origin) {
        if (init.headers['CF-Access-Client-Id'] && target.pathname === '/api/version') {
          if (state.backendAbsent) return new Response('Unavailable', { status: 502 });
          return Response.json({ name: 'codexia', profile: 'full', version: '1.0.0', apiEpoch: state.publicEpoch, auth: state.publicAuth });
        }
        if (init.headers['CF-Access-Client-Id'] && target.pathname === '/desktop/update-identity.json') {
          if (state.frontendDenied) return new Response('Denied', { status: 403 });
          return Response.json({ format: 'codexia-frontend-identity/v1', version: '1.0.0', profile: 'full', sourceSha: 'f'.repeat(40), apiEpoch: 1 });
        }
        return new Response(state.enabled ? FENCE_RESPONSE.content : 'Cloudflare Access denied', { status: 403 });
      }
      assert.equal(target.origin, 'https://api.cloudflare.com');
      const path = target.pathname;
      if (method === 'POST' || method === 'PATCH') {
        writes.push({ path, method, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      } else {
        assert.equal(init.headers.Authorization, 'Bearer read-secret');
      }
      if (path === accountPath + '/workers/scripts') {
        if (state.inventoryDenied) return new Response('Denied', { status: 403 });
        return apiResponse(state.scriptAbsent ? [] : [{ id: 'codexia-frontend' }]);
      }
      if (path === workerPath + '/deployments') {
        if (method === 'POST') {
          state.activeVersion = writes.at(-1).body.versions[0].version_id;
          if (state.replyLost) throw new Error('connection reset');
        }
        const deployment = { id: deploymentId, created_on: '2026-11-23T12:00:00Z', strategy: 'percentage', versions: [{ version_id: state.activeVersion, percentage: 100 }] };
        return apiResponse(method === 'GET' ? { deployments: [deployment] } : deployment);
      }
      if (path === workerPath + '/subdomain') return apiResponse({ enabled: false, previews_enabled: state.preview });
      if (path === workerPath + '/versions/' + newVersion) {
        return apiResponse({ id: newVersion, metadata: { hasPreview: false }, annotations: { 'workers/tag': state.uploadTag } });
      }
      if (path === workerPath + '/versions/' + oldVersion) return apiResponse({ id: oldVersion });
      if (path.endsWith('/firewall/access_rules/rules')) {
        return apiResponse(path.startsWith(zonePath) && state.ipAllow ? [{ mode: 'whitelist' }] : []);
      }
      if (path === zonePath + '/dns_records') return apiResponse([{ id: 'f'.repeat(32), name: hostname, proxied: true, type: 'CNAME', content: tunnelId + '.cfargotunnel.com' }]);
      if (path === zonePath + '/workers/routes') {
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
      if (path === `${rulesPath}/${rulesetId}/rules/${fenceRuleId}` && method === 'PATCH') {
        state.enabled = writes.at(-1).body.enabled;
      } else {
        assert.equal(path, rulesPath + '/phases/http_request_firewall_custom/entrypoint');
      }
      return apiResponse({ id: rulesetId, phase: 'http_request_firewall_custom', kind: 'zone', rules: [rule()] });
    },
  });
  return { client, state, writes };
}

test('fence limits a maintenance exception to a single source IP, exact method and raw and normalized path', () => {
  assert.equal(buildFenceExpression(origin), expression);
  assert.match(buildFenceExpression(origin, [{ ip: '192.0.2.1', method: 'POST', path: '/mcp' }]),
    /ip\.src eq 192\.0\.2\.1 and http\.request\.method eq "POST" and http\.request\.uri\.path eq "\/mcp" and raw\.http\.request\.uri\.path eq "\/mcp"/u);
  assert.throws(() => buildFenceExpression(origin, [{ ip: '0.0.0.0/0', method: 'POST', path: '/mcp' }]), /source IP/u);
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

test('candidate upload fails before using the upload credential when previews are enabled', async () => {
  const { client, state } = fixture();
  state.preview = true;
  await assert.rejects(client.stage({ previousVersionId: oldVersion, artifactDigest }), /preview/u);
  assert.equal(state.uploadTag, null);
});

test('deploy refuses an open fence and reconciles a lost response after confirmed activation', async () => {
  const { client, state, writes } = fixture();
  await assert.rejects(client.deploy({ fromVersionId: oldVersion, toVersionId: newVersion }), /fence/u);
  assert.equal(writes.length, 0);
  await client.fence();
  await client.verifyFenced();
  state.replyLost = true;
  assert.equal((await client.deploy({ fromVersionId: oldVersion, toVersionId: newVersion })).versionId, newVersion);
  assert.equal((await client.deploy({ fromVersionId: oldVersion, toVersionId: newVersion })).versionId, newVersion);
  assert.deepEqual(writes.map(({ auth, method }) => [auth, method]), [['Bearer waf-secret', 'PATCH'], ['Bearer worker-secret', 'POST']]);
  assert.deepEqual(writes[1].body.versions, [{ version_id: newVersion, percentage: 100 }]);
  assert.equal(state.enabled, true);
  assert.equal((await client.deploy({ fromVersionId: newVersion, toVersionId: oldVersion })).versionId, oldVersion);
  await client.unfence();
  assert.equal(state.enabled, false);
});

test('rollback does not overwrite an unrecognized deployment', async () => {
  const { client, state, writes } = fixture();
  state.enabled = true;
  state.activeVersion = '20000000-0000-4000-8000-000000000001';
  await assert.rejects(client.deploy({ fromVersionId: newVersion, toVersionId: oldVersion }), /unexpected/u);
  assert.deepEqual(writes, []);
});

test('ingress proof rejects Worker aliases and IP Access rules that can skip the fence', async () => {
  const { client, state, writes } = fixture();
  const before = await client.observeIngress();
  assert.match(before.ingressDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(before.origin, origin);
  assert.equal(before.fence.enabled, false);
  assert.equal(before.deployment.createdAt, '2026-11-23T12:00:00.000Z');
  state.alias = true;
  await assert.rejects(client.observeIngress(), /alternate ingress/u);
  state.alias = false;
  state.ipAllow = true;
  await assert.rejects(client.observeIngress(), /IP Access/u);
  assert.deepEqual(writes, []);
});

test('fence removal proves the dedicated block response is absent and the application remains protected', async () => {
  const { client } = fixture();
  await client.fence();
  await assert.rejects(client.verifyUnfenced(), /still enabled/u);
  await client.unfence();
  assert.equal((await client.verifyUnfenced()).status, 403);
});

test('protected observation binds the old wire identity and keeps epoch 2 OAuth admission strict', async () => {
  const { client, state } = fixture();
  assert.equal((await client.observe()).backend.apiEpoch, 1);
  state.publicEpoch = undefined;
  await assert.rejects(client.observe(), /epoch is missing/u);
  state.publicEpoch = 2;
  await assert.rejects(client.observe(), /standalone OAuth/u);
  state.publicAuth = ['oauth-owner', 'oauth-mcp'];
  assert.equal((await client.observe()).backend.apiEpoch, 2);
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
