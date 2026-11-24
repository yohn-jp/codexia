import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertBackendIdentity, assertFrontendIdentity, readFrontendReleaseConfiguration } from '../frontend/verify-compatibility.mjs';
import { assertProbeDenied, IDENTITY_PROBE_PATHS, probeScopedIdentityAccess, readLiveJson } from '../../verification/infrastructure/identity-probe-client.mjs';

const readConfig = async name => JSON.parse(await readFile(new URL(`../../../deploy/cloudflare/${name}.json`, import.meta.url), 'utf8'));
const [identities, routes, protocols, setup] = await Promise.all([
  readConfig('identity-probes'),
  readConfig('ui-routes'),
  readConfig('public-protocol-paths'),
  readConfig('owner-setup'),
]);
const worker = 'codexia-frontend';
const phase = 'http_request_firewall_custom';
const identityPaths = Object.values(identities).map(({ path }) => path);
const protocolPaths = Object.values(protocols).map(({ path }) => path);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const hexId = /^[a-f0-9]{32}$/u;
const fenceRef = 'codexia-epoch-cutover';
const fenceDescription = 'Codexia maintenance fence';
export const FENCE_RESPONSE = Object.freeze({ status_code: 403, content_type: 'text/plain', content: fenceDescription });
const api = 'https://api.cloudflare.com/client/v4';

export function ownerSetupArtifactTag(digest) {
  assert.ok(typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest), 'Owner setup artifact digest is invalid');
  return `owner-setup-${digest}`;
}

function parseOrigin(origin) {
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error('Cutover requires a valid HTTPS application origin'); }
  assert.ok(parsed.protocol === 'https:' && parsed.href === `https://${parsed.hostname}/` &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/u.test(parsed.hostname) && !isIP(parsed.hostname),
  'Cutover requires a valid HTTPS application origin');
  return parsed;
}

function matchRequest(method, path) {
  return `http.request.method eq "${method}" and http.request.uri.path eq "${path}" and raw.http.request.uri.path eq "${path}"`;
}

export function buildFenceExpression(origin, acceptance = []) {
  const { hostname } = parseOrigin(origin);
  assert.ok(Array.isArray(acceptance), 'Cutover acceptance exceptions must be an array');
  const exceptions = identityPaths.map(path => `(${matchRequest('GET', path)})`);
  const approved = acceptance.map(({ ip, method, path }) => {
    assert.ok(isIP(ip) && !ip.includes('%'), 'Each cutover acceptance exception requires a single source IP');
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(method), 'Invalid cutover acceptance method');
    assert.ok(typeof path === 'string' && /^\/[a-zA-Z0-9._~/-]*$/u.test(path) &&
      !path.startsWith('//') && new URL(path, origin).pathname === path, 'Each cutover acceptance exception requires an exact path');
    return `(ip.src eq ${ip} and ${matchRequest(method, path)})`;
  });
  exceptions.push(...new Set(approved.sort()));
  const expression = `(http.host eq "${hostname}" and not (${exceptions.join(' or ')}))`;
  assert.ok(expression.length <= 4096, 'Cutover fence expression exceeds the Cloudflare limit');
  return expression;
}

function candidateTag(artifactDigest) {
  assert.ok(typeof artifactDigest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(artifactDigest),
    'Frontend artifact SHA-256 digest is invalid');
  return `cutover-${artifactDigest.slice(7)}`;
}

async function runWranglerUpload({ accountId, workerToken, tag }) {
  const output = await mkdtemp(join(tmpdir(), 'codexia-cutover-wrangler-'));
  const outputFile = join(output, 'versions.ndjson');
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  try {
    await promisify(execFile)(join(root, 'edge/frontend/node_modules/.bin/wrangler'), [
      'versions', 'upload', '--config', join(root, 'edge/frontend/wrangler.jsonc'), '--tag', tag,
    ], {
      cwd: root,
      timeout: 5 * 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', WRANGLER_SEND_METRICS: 'false',
        WRANGLER_OUTPUT_FILE_PATH: outputFile, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: workerToken },
    });
    const entries = (await readFile(outputFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const uploads = entries.filter(entry => entry.type === 'version-upload' && entry.version === 1);
    assert.ok(uploads.length === 1 && uploads[0].worker_name === worker && !uploads[0].preview_url &&
      !uploads[0].preview_alias_url && uuid.test(uploads[0].version_id), 'Invalid Wrangler upload receipt');
    return uploads[0].version_id;
  } catch {
    throw new Error('Wrangler candidate upload could not be verified');
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function allowsHostname(pattern, hostname) {
  const host = pattern.replace(/^https?:\/\//u, '').split('/')[0].toLowerCase();
  if (!host.includes('*')) return host === hostname;
  const escaped = host.split('*').map(part => part.replaceAll('.', '\\.')).join('.*');
  if (!/^[a-z0-9.*\\-]+$/u.test(escaped)) return true;
  return new RegExp(`^${escaped}$`, 'u').test(hostname);
}

function assertPolicyIds(policies, expected) {
  assert.ok(Array.isArray(policies) && policies.length === expected.length, 'Cloudflare Access application policies differ from the intended boundary');
  for (const [index, [decision, id]] of expected.entries()) {
    const policy = policies.find(item => Number(item.precedence) === index + 1);
    assert.ok(policy?.decision === decision && (!id || policy.id === id), 'Cloudflare Access application policy decision or identity changed');
    if (decision === 'bypass') {
      assert.deepEqual(policy.include, [{ everyone: {} }], 'Cloudflare protocol Bypass policy is not the reviewed policy');
      assert.ok(!policy.require?.length && !policy.exclude?.length, 'Cloudflare protocol Bypass policy constraints changed');
    }
    if (decision === 'non_identity') {
      assert.ok(policy.include?.length === 1 && uuid.test(policy.include[0]?.service_token?.token_id),
        'Cloudflare CI policy must select a single identity probe service token');
    }
  }
}

function assertCutoverBackendIdentity(identity) {
  assert.ok(identity?.apiEpoch === 1 || identity?.apiEpoch === 2, 'Live backend API epoch is missing or invalid for cutover');
  if (identity.apiEpoch === 2) return assertBackendIdentity(identity);
  assert.ok(identity.name === 'codexia' && identity.profile === 'full' &&
    typeof identity.version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(identity.version),
  'Live epoch 1 backend identity is invalid');
  return identity;
}

export function createCloudflareCutover({
  origin, accountId, zoneId, tunnelId, fenceRuleId, acceptance = [],
  authorPolicyId, ciPolicyId, tunnelTeamName, publicProtocolEnabled,
  readToken, workerToken, fenceToken, accessEnv = process.env, fetchImpl = fetch,
  uploadVersion = runWranglerUpload,
}) {
  const target = parseOrigin(origin);
  assert.ok(hexId.test(accountId) && hexId.test(zoneId) && uuid.test(tunnelId) && hexId.test(fenceRuleId),
    'Cloudflare cutover resource IDs are invalid');
  const expression = buildFenceExpression(target, acceptance);
  const accountPath = `/accounts/${accountId}`;
  const zonePath = `/zones/${zoneId}`;
  const workerPath = `${accountPath}/workers/scripts/${worker}`;
  const setupWorkerPath = `${accountPath}/workers/scripts/${setup.worker}`;

  async function request(label, path, { method = 'GET', token = readToken, body } = {}) {
    assert.ok(typeof token === 'string' && token.length > 0 && token.trim() === token, `Missing Cloudflare credential for ${label}`);
    let response, envelope;
    try {
      response = await fetchImpl(api + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(20_000),
      });
      envelope = await response.json();
    } catch {
      throw new Error(`Cloudflare ${label} response could not be verified`);
    }
    if (!response.ok || envelope?.success !== true || envelope.errors?.length || envelope.result == null) {
      throw new Error(`Cloudflare ${label} failed (HTTP ${response.status})`);
    }
    return envelope;
  }

  async function result(label, path, options) {
    return (await request(label, path, options)).result;
  }

  async function list(label, path) {
    const items = [];
    const separator = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= 100; page++) {
      const envelope = await request(label, `${path}${separator}page=${page}&per_page=50`);
      assert.ok(Array.isArray(envelope.result), `Cloudflare ${label} list is invalid`);
      items.push(...envelope.result);
      const total = envelope.result_info?.total_pages;
      if ((Number.isSafeInteger(total) && page >= total) || (total === undefined && envelope.result.length < 50)) return items;
    }
    throw new Error(`Cloudflare ${label} pagination exceeded its bound`);
  }

  async function observeDeployment({ allowAbsent = false, path = workerPath } = {}) {
    const { deployments } = await result('Worker deployments', `${path}/deployments?per_page=1`);
    if (allowAbsent && Array.isArray(deployments) && deployments.length === 0) return null;
    const latest = deployments?.[0];
    const created = latest?.created_on;
    const timestamp = typeof created === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(created) ? Date.parse(created) : NaN;
    assert.ok(latest?.strategy === 'percentage' && uuid.test(latest.id) && latest.versions?.length === 1 &&
      uuid.test(latest.versions[0].version_id) && latest.versions[0].percentage === 100 &&
      Number.isFinite(timestamp), 'Expected one Worker version serving 100% of traffic with a deployment timestamp');
    return { id: latest.id, versionId: latest.versions[0].version_id, createdAt: new Date(timestamp).toISOString() };
  }

  async function assertPrivateWorker(path = workerPath) {
    const settings = await result('Worker subdomain settings', `${path}/subdomain`);
    assert.ok(settings.enabled === false && settings.previews_enabled === false, 'Worker subdomain and preview URLs must be disabled');
  }

  async function readVersion(versionId, path = workerPath) {
    assert.ok(typeof versionId === 'string' && uuid.test(versionId), 'Worker version UUID is invalid');
    const version = await result('Worker version', `${path}/versions/${versionId}`);
    assert.ok(version.id === versionId, 'Cloudflare did not confirm the exact Worker version UUID');
    return version;
  }

  async function observeFence() {
    const ruleset = await result('fence rule', `${zonePath}/rulesets/phases/${phase}/entrypoint`);
    const rule = ruleset.rules?.[0];
    const response = rule?.action_parameters?.response;
    assert.ok(ruleset.phase === phase && ruleset.kind === 'zone' && hexId.test(ruleset.id) &&
      rule?.id === fenceRuleId && rule.ref === fenceRef && rule.description === fenceDescription &&
      rule.expression === expression && rule.action === 'block' && typeof rule.enabled === 'boolean' &&
      response?.status_code === FENCE_RESPONSE.status_code && response?.content_type === FENCE_RESPONSE.content_type &&
      response?.content === FENCE_RESPONSE.content, 'Cloudflare maintenance fence definition or position differs from the approved rule');
    return { rulesetId: ruleset.id, ruleId: rule.id, enabled: rule.enabled };
  }

  async function setFence(enabled) {
    const current = await observeFence();
    if (current.enabled === enabled) return current;
    try {
      await result('fence update', `${zonePath}/rulesets/${current.rulesetId}/rules/${fenceRuleId}`, {
        method: 'PATCH', token: fenceToken,
        body: { enabled, ref: fenceRef, description: fenceDescription, expression, action: 'block',
          action_parameters: { response: FENCE_RESPONSE } },
      });
    } catch {
      // A lost response can follow a committed update. Reconcile using the read credential.
    }
    const observed = await observeFence();
    assert.ok(observed.rulesetId === current.rulesetId && observed.enabled === enabled,
      'Cloudflare maintenance fence did not reach the requested state');
    return observed;
  }

  async function assertStaged({ versionId, artifactDigest }) {
    const tag = candidateTag(artifactDigest);
    const [version, deployment] = await Promise.all([readVersion(versionId), observeDeployment(), assertPrivateWorker()]);
    assert.ok(version.annotations?.['workers/tag'] === tag, 'Candidate Worker version tag does not match the verified frontend archive');
    assert.ok(version.metadata?.hasPreview !== true && versionId !== deployment.versionId,
      'Candidate Worker version must be staged without live traffic or a public preview');
    return { versionId, tag };
  }

  async function stage({ previousVersionId, artifactDigest }) {
    const tag = candidateTag(artifactDigest);
    const [before] = await Promise.all([observeDeployment(), readVersion(previousVersionId), assertPrivateWorker()]);
    assert.ok(before.versionId === previousVersionId, 'Active Worker version changed before candidate upload');
    assert.ok(typeof workerToken === 'string' && workerToken.length > 0 && workerToken.trim() === workerToken,
      'Missing Cloudflare credential for candidate upload');
    const versionId = await uploadVersion({ accountId, workerToken, tag });
    const [staged, after] = await Promise.all([assertStaged({ versionId, artifactDigest }), observeDeployment()]);
    assert.deepEqual(after, before, 'Active Worker deployment changed during candidate upload');
    return staged;
  }

  async function deploy({ fromVersionId, toVersionId }) {
    assert.ok((await observeFence()).enabled, 'Cloudflare maintenance fence must be active before switching the Worker');
    const [before] = await Promise.all([observeDeployment(), readVersion(toVersionId), assertPrivateWorker()]);
    if (before.versionId === toVersionId) return before;
    assert.ok(uuid.test(fromVersionId) && before.versionId === fromVersionId, 'Cloudflare has an unexpected live Worker version');
    try {
      await result('Worker deployment update', `${workerPath}/deployments`, {
        method: 'POST', token: workerToken,
        body: { strategy: 'percentage', versions: [{ version_id: toVersionId, percentage: 100 }] },
      });
    } catch {
      // Observe the deployment even when Cloudflare did not return a usable reply.
    }
    const after = await observeDeployment();
    assert.ok(after.versionId === toVersionId, 'Cloudflare did not confirm the requested Worker version at 100%');
    assert.ok((await observeFence()).enabled, 'Cloudflare maintenance fence changed while switching the Worker');
    return after;
  }

  async function verifyFenced() {
    assert.ok((await observeFence()).enabled, 'Cloudflare maintenance fence is not active');
    const checks = [
      ...['/', '/desktop', '/api/projects', '/health/ready', ...protocolPaths.map(path => path.replace(/\*$/u, 'cutover-probe'))]
        .map(path => ['GET', path]),
      ...identityPaths.flatMap(path => [['OPTIONS', path], ['GET', path + '/']]),
    ];
    const evidence = [];
    for (const [method, path] of checks) {
      const response = await fetchImpl(new URL(path, target), {
        method, redirect: 'manual', cache: 'no-store', headers: { 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(15_000),
      });
      assert.ok(response.status === FENCE_RESPONSE.status_code && await response.text() === FENCE_RESPONSE.content,
        `Maintenance fence denial could not be proven for ${method} ${path}`);
      evidence.push({ method, path, status: response.status, ray: response.headers.get('cf-ray') });
    }
    return evidence;
  }

  async function verifyUnfenced() {
    assert.ok(!(await observeFence()).enabled, 'Cloudflare maintenance fence is still enabled');
    const response = await fetchImpl(new URL('/desktop', target), {
      method: 'GET', redirect: 'manual', cache: 'no-store', headers: { 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    let redirect;
    try {
      const location = response.headers.get('location');
      if (location) redirect = new URL(location, target);
    } catch {
      throw new Error('Invalid anonymous desktop redirect after fence removal');
    }
    const accessRedirect = [301, 302, 303, 307, 308].includes(response.status) && redirect?.protocol === 'https:' &&
      (redirect.origin === target.origin || redirect.hostname.endsWith('.cloudflareaccess.com')) &&
      /^\/cdn-cgi\/access\/login(?:\/|$)/u.test(redirect.pathname);
    assert.ok(body !== FENCE_RESPONSE.content && (accessRedirect || [401, 403].includes(response.status)),
      'Cloudflare fence removal or anonymous desktop denial could not be proven');
    return { status: response.status, ray: response.headers.get('cf-ray') };
  }

  async function assertNoFenceSkippingIpRules() {
    const allowLists = await Promise.all([accountPath, zonePath].map(path =>
      list('IP Access rules', `${path}/firewall/access_rules/rules?mode=whitelist`)));
    assert.ok(allowLists.every(items => items.length === 0), 'Cloudflare IP Access Allow rules can skip the maintenance fence');
  }

  async function observeOwnerSetup(artifactDigest) {
    const tag = ownerSetupArtifactTag(artifactDigest);
    const [deployment] = await Promise.all([
      observeDeployment({ path: setupWorkerPath }), assertPrivateWorker(setupWorkerPath),
    ]);
    const version = await readVersion(deployment.versionId, setupWorkerPath);
    assert.ok(version.annotations?.['workers/tag'] === tag && version.metadata?.hasPreview !== true,
      'Owner setup Worker version does not match the certified artifact');
    return { deploymentId: deployment.id, versionId: version.id, artifactDigest };
  }

  async function observeIngress({ lifecycle = false, ownerSetupArtifactDigest } = {}) {
    assert.ok(uuid.test(authorPolicyId) && uuid.test(ciPolicyId) && authorPolicyId !== ciPolicyId &&
      typeof publicProtocolEnabled === 'boolean' && /^[a-z0-9-]+$/u.test(tunnelTeamName ?? ''),
    'Access policy IDs, Tunnel team and protocol ingress setting must be pinned');
    const host = target.hostname;
    // Terraform iterates the JSON-decoded map in lexicographic key order.
    const enabledProtocols = publicProtocolEnabled ? Object.keys(protocols).sort().map(key => protocols[key]) : [];
    const expectedPaths = ['', ...identityPaths, ...enabledProtocols.map(item => item.path)];
    // Positive absence requires an authenticated inventory, not a 404, failed
    // identity probe, or denied token. Strict cutover calls retain their
    // existing requirement for a deployed Worker.
    let scriptPresent = true;
    let setupScriptPresent = false;
    if (lifecycle) {
      const scripts = await list('Worker script inventory', `${accountPath}/workers/scripts`);
      assert.ok(scripts.every(item => typeof item?.id === 'string' && item.id.length > 0) &&
        new Set(scripts.map(item => item.id)).size === scripts.length, 'Worker script inventory is ambiguous');
      scriptPresent = scripts.some(item => item.id === worker);
      setupScriptPresent = scripts.some(item => item.id === setup.worker);
    }
    const [dns, workerRoutes, domains, applications, tunnel, deployment, fence] = await Promise.all([
      list('proxied application DNS', `${zonePath}/dns_records?name=${host}`),
      result('Worker routes', `${zonePath}/workers/routes`),
      Promise.all([
        list('Worker custom domains', `${accountPath}/workers/domains?service=${worker}`),
        list('Owner setup Worker custom domains', `${accountPath}/workers/domains?service=${setup.worker}`),
        list('Worker custom domains for application', `${accountPath}/workers/domains?hostname=${host}`),
      ]),
      list('Access applications', `${accountPath}/access/apps`),
      result('Tunnel configuration', `${accountPath}/cfd_tunnel/${tunnelId}/configurations`),
      scriptPresent ? observeDeployment({ allowAbsent: lifecycle }) : null, observeFence(),
      scriptPresent ? assertPrivateWorker() : null, assertNoFenceSkippingIpRules(),
      setupScriptPresent ? assertPrivateWorker(setupWorkerPath) : null,
    ]);
    assert.ok(dns.length === 1 && dns[0].name === host && dns[0].proxied === true && dns[0].type === 'CNAME' &&
      dns[0].content === `${tunnelId}.cfargotunnel.com`, 'Application DNS must be the pinned proxied Tunnel CNAME');
    assert.ok(domains.every(items => items.length === 0), 'Worker custom domains permit alternate ingress');
    assert.ok(Array.isArray(workerRoutes), 'Cloudflare Worker route inventory is invalid');
    const relevantRoutes = workerRoutes.filter(route => [worker, setup.worker].includes(route.script) || allowsHostname(route.pattern, host));
    const setupAttached = relevantRoutes.some(route => route.script === setup.worker);
    assert.ok(!setupAttached || (lifecycle && setupScriptPresent && !publicProtocolEnabled && !fence.enabled),
      'Owner setup ingress requires the protected limited topology with public protocols disabled');
    const routePlan = setupAttached ? [
      ...setup.routes.map(path => ({ pattern: host + path, script: setup.worker })),
      ...(deployment ? [{ pattern: host + identities.frontend.path, script: worker }] : []),
    ] : lifecycle && deployment === null ? [] : [
      ...routes.routes.map(path => ({ pattern: host + path, script: worker })),
      ...routes.originRoutes.map(path => ({ pattern: host + path, script: null })),
    ];
    assert.deepEqual(relevantRoutes.map(route => ({ pattern: route.pattern, script: route.script ?? null }))
      .sort((a, b) => a.pattern.localeCompare(b.pattern)), routePlan.sort((a, b) => a.pattern.localeCompare(b.pattern)),
    'Worker routes expose alternate ingress or differ from the canonical routing contract');
    const ownerSetup = setupAttached ? await observeOwnerSetup(ownerSetupArtifactDigest) : null;

    const relevantApps = applications.filter(app => [app.domain, ...(app.self_hosted_domains ?? []),
      ...(app.destinations ?? []).filter(destination => destination.type === 'public').map(destination => destination.uri),
    ].some(domain => typeof domain === 'string' && allowsHostname(domain, host)));
    assert.deepEqual(relevantApps.map(app => app.domain).sort(), expectedPaths.map(path => host + path).sort(),
      'Cloudflare Access application paths differ from the reviewed topology');
    const relevantPolicies = await Promise.all(relevantApps.map(async app => {
      const domains = [...(app.self_hosted_domains ?? []),
        ...(app.destinations ?? []).filter(destination => destination.type === 'public').map(destination => destination.uri)];
      assert.ok(app.type === 'self_hosted' && uuid.test(app.id) && /^[a-f0-9]{64}$/u.test(app.aud) &&
        domains.every(domain => domain === app.domain) && !(app.destinations ?? []).some(destination => destination.overrides?.length),
      'Cloudflare Access application identity or destinations are invalid');
      const path = app.domain.slice(host.length);
      const policies = await list('Access policies', `${accountPath}/access/apps/${app.id}/policies`);
      const expected = path === '' ? [['allow', authorPolicyId]]
        : identityPaths.includes(path) ? [['non_identity', ciPolicyId], ['allow', authorPolicyId]]
          : [['bypass']];
      assertPolicyIds(policies, expected);
      return { path, app, policies: policies.sort((a, b) => a.precedence - b.precedence) };
    }));
    const audits = Object.fromEntries(relevantPolicies.map(({ path, app }) => [path, app.aud]));
    const expectedIngress = [
      ...enabledProtocols.filter(entry => entry.tunnelPath).map(entry => [entry.tunnelPath, null]),
      ...Object.values(identities).map(({ path, tunnelPath }) => [tunnelPath, [audits[path], audits['']].sort()]),
      [null, [audits['']]],
    ];
    const ingress = tunnel.config?.ingress;
    assert.ok(tunnel.tunnel_id === tunnelId && tunnel.account_id === accountId && tunnel.source === 'cloudflare' && Array.isArray(ingress) &&
      ingress.length === expectedIngress.length + 1, 'Cloudflare Tunnel authority or ingress list differs from the reviewed topology');
    for (const [index, [path, aud]] of expectedIngress.entries()) {
      const item = ingress[index];
      const access = item.originRequest?.access;
      assert.ok(item.hostname === host && (item.path || null) === path && item.service === 'http://codexia-api:3000' &&
        item.originRequest?.httpHostHeader === host, 'Cloudflare Tunnel ingress endpoint differs from the reviewed topology');
      if (aud) {
        assert.ok(access?.required === true && access.teamName === tunnelTeamName && Array.isArray(access.audTag) &&
          aud.length === access.audTag.length && aud.every(tag => access.audTag.includes(tag)),
        'Cloudflare Tunnel Access audience differs from the reviewed topology');
      } else {
        assert.ok(!access || access.required === false, 'Cloudflare public protocol Tunnel entry has unexpected Access settings');
      }
    }
    assert.ok(!ingress.at(-1).hostname && !ingress.at(-1).path && ingress.at(-1).service === 'http_status:404',
      'Cloudflare Tunnel must end with an unconditional 404');
    const topology = { dns: dns[0].id, workerRoutes: routePlan,
      access: relevantPolicies.sort((a, b) => a.path.localeCompare(b.path)), tunnel: tunnel.config,
      fence: { rulesetId: fence.rulesetId, ruleId: fence.ruleId, expression },
      ...(ownerSetup ? { ownerSetup } : {}),
    };
    const ingressDigest = `sha256:${createHash('sha256').update(JSON.stringify(canonical(topology))).digest('hex')}`;
    return { observedAt: new Date().toISOString(), origin: target.origin, deployment, fence, ingressDigest,
      ...(lifecycle ? { scriptPresent, setupScriptPresent, ownerSetup, publicProtocolEnabled } : {}) };
  }

  async function assertOwnerSetupDetached() {
    const ingress = await observeIngress({ lifecycle: true });
    assert.ok(!ingress.ownerSetup && !ingress.fence.enabled, 'Owner setup Worker must be detached outside maintenance');
    return ingress;
  }

  async function observe() {
    const { origin: liveOrigin, clientId, clientSecret } = readFrontendReleaseConfiguration(accessEnv);
    assert.ok(liveOrigin.origin === target.origin,
      'Protected identity origin differs from the pinned Cloudflare hostname');
    const [ingress, live] = await Promise.all([
      observeIngress(),
      probeScopedIdentityAccess({ origin: liveOrigin, credentials: { clientId, clientSecret }, fetchImpl, checkBoundary: true,
        validateBackend: assertCutoverBackendIdentity, validateFrontend: assertFrontendIdentity }),
    ]);
    const after = await observeDeployment();
    assert.deepEqual(ingress.deployment, after, 'Active Worker deployment changed during protected identity observation');
    return { ...ingress, backend: live.backend, frontend: live.deployed };
  }

  async function observeLifecycle({ backendExpected, ownerSetupArtifactDigest }) {
    assert.ok(typeof backendExpected === 'boolean', 'Lifecycle backend observation mode is invalid');
    const ingress = await observeIngress({ lifecycle: true, ownerSetupArtifactDigest });
    const { origin: liveOrigin, clientId, clientSecret } = readFrontendReleaseConfiguration(accessEnv);
    assert.ok(liveOrigin.origin === target.origin, 'Protected identity origin differs from the pinned hostname');
    const credentials = { clientId, clientSecret };
    // Check both anonymous identity paths and author-route denial even when a
    // component is absent. A failed authenticated probe never proves absence.
    const boundary = await probeScopedIdentityAccess({ origin: liveOrigin, credentials, fetchImpl,
      checkBoundary: true, includeBackend: false, includeFrontend: false });
    assert.deepEqual(boundary, {});
    if (ingress.ownerSetup) {
      await Promise.all(['/console/setup', '/api/auth/codexia/setup/status', '/api/projects',
        '/api/auth/oauth2/authorize', '/mcp'].flatMap(path => [
        assertProbeDenied(path, liveOrigin, null, fetchImpl),
        assertProbeDenied(path, liveOrigin, credentials, fetchImpl),
      ]));
    }
    let frontend = null;
    let frontendState = ingress.deployment === null ? 'absent' : 'unknown';
    if (ingress.deployment !== null) {
      try {
        const value = assertFrontendIdentity(await readLiveJson(IDENTITY_PROBE_PATHS.frontend, liveOrigin, credentials, fetchImpl));
        // Expose only canonical identity fields, with the public OAuth
        // configuration reduced to its digest by the lifecycle controller.
        frontend = { format: value.format, sourceSha: value.sourceSha, version: value.version,
          profile: value.profile, apiEpoch: value.apiEpoch,
          ...(value.oauthConfigIdentity === undefined ? {} : { oauthConfigIdentity: value.oauthConfigIdentity }) };
        frontendState = 'running';
      } catch { /* no positive identity evidence */ }
    }
    let backend = null;
    {
      try {
        const value = await readLiveJson(IDENTITY_PROBE_PATHS.backend, liveOrigin, credentials, fetchImpl);
        assert.ok(value?.name === 'codexia' && value.profile === 'full' &&
          typeof value.version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value.version) &&
          Number.isSafeInteger(value.apiEpoch) && value.apiEpoch > 0, 'Invalid protected backend identity');
        const standaloneOAuth = Array.isArray(value.auth) && value.auth.length === 2 &&
          value.auth.includes('oauth-owner') && value.auth.includes('oauth-mcp');
        backend = { name: value.name, profile: value.profile, version: value.version,
          apiEpoch: value.apiEpoch, standaloneOAuth };
      } catch { /* no positive identity evidence */ }
    }
    if (!backendExpected && backend !== null) throw new Error('Public backend contradicts observed host absence');
    const after = await observeIngress({ lifecycle: true, ownerSetupArtifactDigest });
    assert.deepEqual({ deployment: ingress.deployment, fence: ingress.fence, ingressDigest: ingress.ingressDigest,
      scriptPresent: ingress.scriptPresent }, { deployment: after.deployment, fence: after.fence,
      ingressDigest: after.ingressDigest, scriptPresent: after.scriptPresent }, 'Ingress changed during observation');
    return { ...after, frontendState, frontend, backend };
  }

  return { observe, observeLifecycle, observeIngress, observeDeployment, stage, assertStaged, fence: () => setFence(true),
    unfence: () => setFence(false), verifyFenced, verifyUnfenced, deploy, assertOwnerSetupDetached, observeOwnerSetup };
}
