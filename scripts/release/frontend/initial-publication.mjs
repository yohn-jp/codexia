import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionsRepository, assertReleaseRepositoryBinding } from '../../github/repository.mjs';
import { promisify } from 'node:util';
import { assertFrontendIdentity, readFrontendReleaseConfiguration } from '../frontend/verify-compatibility.mjs';
import { readRegularFile } from '../../shared/read-regular-file.mjs';
import { assertProbeDenied, IDENTITY_PROBE_PATHS, probeScopedIdentityAccess, readLiveJson } from '../../verification/infrastructure/identity-probe-client.mjs';

const readConfig = async name => JSON.parse(await readFile(new URL(`../../../deploy/cloudflare/${name}.json`, import.meta.url), 'utf8'));
const [identities, routes, protocols] = await Promise.all([
  readConfig('identity-probes'),
  readConfig('ui-routes'),
  readConfig('public-protocol-paths'),
]);
const worker = 'codexia-frontend';
const publicationControls = ['_headers', '_redirects'];
const frontendAssets = fileURLToPath(new URL('../../../app/dist/', import.meta.url));
const identityPaths = Object.values(identities).map(({ path }) => path);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const hexId = /^[a-f0-9]{32}$/u;
const workerIdPattern = /^[a-zA-Z0-9_-]{1,128}$/u;
const api = 'https://api.cloudflare.com/client/v4';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function parseOrigin(origin) {
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error('Deployment requires a valid HTTPS application origin'); }
  assert.ok(parsed.protocol === 'https:' && parsed.href === `https://${parsed.hostname}/` &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/u.test(parsed.hostname) && !isIP(parsed.hostname),
  'Deployment requires a valid HTTPS application origin');
  return parsed;
}

export function protectedCloudflareTarget(env = process.env) {
  const target = JSON.parse(env.CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET || 'null');
  const keys = ['repository', 'repositoryId', 'ownerId', 'origin',
    'accountId', 'zoneId', 'tunnelId', 'authorPolicyId', 'ciPolicyId',
    'tunnelTeamName', 'publicProtocolEnabled'];
  assert.ok(target && keys.every(key => Object.hasOwn(target, key)) &&
    Object.keys(target).length === keys.length, 'Invalid protected Cloudflare target');
  assertReleaseRepositoryBinding(target, actionsRepository(env));
  assert.equal(target.origin, env.CODEXIA_PUBLIC_ORIGIN, 'Protected Cloudflare origin differs from the certified source');
  return target;
}

export function deploymentEdgeFromEnvironment(env = process.env, fetchImpl = fetch) {
  return createDeploymentEdge({
    ...protectedCloudflareTarget(env),
    readToken: env.CODEXIA_DEPLOYMENT_CLOUDFLARE_READ_TOKEN,
    accessEnv: env,
    fetchImpl,
  });
}

function candidateTag(artifactDigest) {
  assert.ok(typeof artifactDigest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(artifactDigest),
    'Frontend artifact SHA-256 digest is invalid');
  return `frontend-${artifactDigest.slice(7)}`;
}

async function readCertifiedPublicationControls(directory = frontendAssets) {
  return Object.fromEntries(await Promise.all(publicationControls.map(async name =>
    [name, sha256(await readRegularFile(join(directory, name), { encoding: null }))])));
}

async function runWranglerUpload({ accountId, workerToken, tag }) {
  const output = await mkdtemp(join(tmpdir(), 'codexia-frontend-wrangler-'));
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

// The first version must be created without a deployment, even when no
// previous version exists. Do not use a script upload or wrangler deploy here.
// https://developers.cloudflare.com/workers/static-assets/direct-upload/
export async function runInitialWorkerUpload({
  accountId, workerId, workerToken, tag, initialControls,
  directory = frontendAssets, fetchImpl = fetch, mimeLookup,
}) {
  assert.ok(hexId.test(accountId) && workerIdPattern.test(workerId), 'Invalid initial Worker target');
  assert.ok(typeof workerToken === 'string' && workerToken.length > 0 && workerToken.trim() === workerToken,
    'Missing Worker publication credential');
  assert.match(tag, /^frontend-[a-f0-9]{64}$/u);
  const config = JSON.parse(await readFile(new URL('../../../edge/frontend/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.name, worker);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.match(config.compatibility_date, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(config.assets.html_handling, 'none');
  assert.equal(config.assets.not_found_handling, 'none');

  const lookup = mimeLookup ?? createRequire(new URL('../../../edge/frontend/package.json', import.meta.url))('mime-types').lookup;
  const modules = await Promise.all(publicationControls.map(async name => {
    const bytes = await readRegularFile(join(directory, name), { encoding: null });
    assert.equal(sha256(bytes), initialControls?.[name], 'Initial Worker publication controls changed before upload');
    return { name, content_type: 'text/plain', content_base64: bytes.toString('base64') };
  }));
  const manifest = {};
  const byHash = new Map();
  const hashFor = (bytes, name) => sha256(bytes.toString('base64') + extname(name).slice(1)).slice(0, 32);
  assert.ok((await lstat(directory)).isDirectory(), 'Expected a regular asset directory');
  async function walk(relative = '') {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        await walk(name);
        continue;
      }
      assert.ok(entry.isFile(), 'Unexpected non-regular frontend asset');
      if (publicationControls.includes(name)) continue;
      const bytes = await readRegularFile(join(directory, name), { encoding: null });
      const hash = hashFor(bytes, name);
      const type = lookup(name) || 'application/null';
      const previous = byHash.get(hash);
      assert.ok(!previous || (previous.digest === sha256(bytes) && previous.type === type),
        'Ambiguous frontend asset hash');
      byHash.set(hash, { name, type, digest: sha256(bytes) });
      manifest['/' + name] = { hash, size: bytes.length };
    }
  }
  await walk();
  assert.ok(byHash.size > 0, 'No frontend assets to upload');

  // Keep credentials and server response bodies out of diagnostics, including
  // when the fetch implementation throws an error with request details.
  async function post(label, path, token, body) {
    let response, envelope;
    try {
      const headers = { Authorization: 'Bearer ' + token };
      if (!(body instanceof FormData)) headers['Content-Type'] = 'application/json';
      response = await fetchImpl(api + path, {
        method: 'POST', headers, body: body instanceof FormData ? body : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(120_000),
      });
      envelope = await response.json();
    } catch {
      throw new Error('Cloudflare ' + label + ' response could not be verified');
    }
    assert.ok(response.ok && envelope?.success === true && !envelope.errors?.length &&
      envelope.result && typeof envelope.result === 'object', 'Cloudflare ' + label + ' failed');
    return { status: response.status, result: envelope.result };
  }
  const validJwt = value => typeof value === 'string' && value.length > 0 && value.trim() === value;
  const account = '/accounts/' + accountId + '/workers';
  const { result: session } = await post('asset upload session', account + '/scripts/' + worker + '/assets-upload-session',
    workerToken, { manifest });
  assert.ok(validJwt(session.jwt) && Array.isArray(session.buckets), 'Invalid asset upload session');
  const requested = new Set();
  for (const bucket of session.buckets) {
    assert.ok(Array.isArray(bucket) && bucket.length > 0, 'Invalid asset upload bucket');
    for (const hash of bucket) {
      assert.ok(byHash.has(hash) && !requested.has(hash), 'Invalid or duplicate requested asset hash');
      requested.add(hash);
    }
  }
  let completionJwt = session.buckets.length === 0 ? session.jwt : undefined;
  for (let index = 0; index < session.buckets.length; index++) {
    const form = new FormData();
    for (const hash of session.buckets[index]) {
      const entry = byHash.get(hash);
      const bytes = await readRegularFile(join(directory, entry.name), { encoding: null });
      assert.equal(sha256(bytes), entry.digest, 'Frontend asset changed after manifest registration');
      form.append(hash, new Blob([bytes.toString('base64')], { type: entry.type }), hash);
    }
    const { result, status } = await post('asset upload', account + '/assets/upload?base64=true', session.jwt, form);
    const last = index === session.buckets.length - 1;
    if (last) {
      assert.ok(status === 201 && validJwt(result.jwt), 'Missing completed asset upload token');
      completionJwt = result.jwt;
    } else {
      assert.ok(status !== 201 && !result.jwt, 'Asset upload completed before all requested buckets');
    }
  }
  const { result: version } = await post('initial Worker version', account + '/workers/' +
    encodeURIComponent(workerId) + '/versions?deploy=false', workerToken, {
    compatibility_date: config.compatibility_date,
    annotations: { 'workers/tag': tag },
    assets: { jwt: completionJwt, config: { html_handling: 'none', not_found_handling: 'none' } },
    modules,
  });
  assert.ok(uuid.test(version.id) && Array.isArray(version.urls) && version.urls.length === 0,
    'Invalid or publicly addressable staged first Worker version');
  return version.id;
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

export function createDeploymentEdge({
  origin, accountId, zoneId, tunnelId,
  authorPolicyId, ciPolicyId, tunnelTeamName, publicProtocolEnabled,
  readToken, workerToken, accessEnv = process.env, fetchImpl = fetch,
  uploadVersion = runWranglerUpload, uploadInitialVersion = runInitialWorkerUpload,
  readInitialWorkerControls = readCertifiedPublicationControls,
}) {
  const target = parseOrigin(origin);
  assert.ok(hexId.test(accountId) && hexId.test(zoneId) && uuid.test(tunnelId),
    'Cloudflare deployment resource IDs are invalid');
  const accountPath = `/accounts/${accountId}`;
  const zonePath = `/zones/${zoneId}`;
  const workerPath = `${accountPath}/workers/scripts/${worker}`;

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

  function assertPrivateWorker(settings) {
    assert.ok(settings?.enabled === false && settings?.previews_enabled === false, 'Worker subdomain and preview URLs must be disabled');
  }

  async function readVersion(versionId, path, { includeModules = false } = {}) {
    assert.ok(typeof versionId === 'string' && uuid.test(versionId), 'Worker version UUID is invalid');
    const version = await result('Worker version', `${path}/versions/${versionId}${includeModules ? '?include=modules' : ''}`);
    assert.ok(version.id === versionId, 'Cloudflare did not confirm the exact Worker version UUID');
    return version;
  }

  async function readWorkerInventory() {
    const workers = await list('Worker inventory', `${accountPath}/workers/workers`);
    assert.ok(workers.every(item => typeof item?.id === 'string' && workerIdPattern.test(item.id) &&
      typeof item.name === 'string' && item.name.length > 0) &&
      new Set(workers.map(item => item.id)).size === workers.length &&
      new Set(workers.map(item => item.name)).size === workers.length, 'Worker inventory is ambiguous');
    return workers;
  }

  async function readNormalVersion(versionId, { initialWorkerId, includeModules = false } = {}) {
    const resource = (await readWorkerInventory()).find(item => item.name === worker);
    assert.ok(resource && (!initialWorkerId || resource.id === initialWorkerId), 'Normal Worker resource identity changed');
    assertPrivateWorker(resource.subdomain);
    return readVersion(versionId, `${accountPath}/workers/workers/${resource.id}`,
      { includeModules });
  }

  async function assertWorkerArtifact({ versionId, artifactDigest, initialWorkerId, initialControls }) {
    const tag = candidateTag(artifactDigest);
    const version = await readNormalVersion(versionId, { initialWorkerId, includeModules: initialControls !== undefined });
    assert.ok(version.annotations?.['workers/tag'] === tag, 'Candidate Worker version tag does not match the verified frontend archive');
    assert.ok(Array.isArray(version.urls) && version.urls.length === 0, 'Candidate Worker must not have a public preview');
    if (initialControls !== undefined) {
      const settings = version.assets?.config;
      assert.ok(initialControls && Object.keys(initialControls).length === publicationControls.length &&
        settings?.html_handling === 'none' && settings.not_found_handling === 'none' && !version.main_module &&
        Array.isArray(version.modules) && version.modules.length === publicationControls.length,
      'Initial Worker version must contain only static assets and the certified publication controls');
      for (const name of publicationControls) {
        const module = version.modules.find(entry => entry.name === name && entry.content_type === 'text/plain');
        assert.ok(typeof module?.content_base64 === 'string' &&
          sha256(Buffer.from(module.content_base64, 'base64')) === initialControls[name],
          'Initial Worker publication controls differ from the certified archive');
      }
    }
    return { versionId, tag };
  }

  async function assertStaged(input) {
    const [staged, deployment] = await Promise.all([assertWorkerArtifact(input), observeDeployment({ allowAbsent: true })]);
    assert.notEqual(staged.versionId, deployment?.versionId, 'Candidate Worker must be staged without live traffic');
    return staged;
  }

  async function stage({ previousVersionId, artifactDigest }) {
    const tag = candidateTag(artifactDigest);
    const initial = previousVersionId === null ? await observeIngress({ lifecycle: true }) : null;
    if (initial) {
      assert.ok(initial.workerId && initial.routesReady && initial.workerNeverDeployed &&
        initial.deployment === null, 'Prepare the unused private Worker and canonical routes before the initial candidate upload');
    }
    const [before] = initial ? [initial.deployment] : await Promise.all([observeDeployment({ allowAbsent: true }),
      readNormalVersion(previousVersionId)]);
    assert.ok((before?.versionId ?? null) === previousVersionId, 'Active Worker version changed before candidate upload');
    assert.ok(typeof workerToken === 'string' && workerToken.length > 0 && workerToken.trim() === workerToken,
      'Missing Cloudflare credential for candidate upload');
    const initialControls = initial ? await readInitialWorkerControls() : undefined;
    const versionId = initial ? await uploadInitialVersion({ accountId, workerId: initial.workerId, workerToken, tag, initialControls })
      : await uploadVersion({ accountId, workerToken, tag });
    const [staged, after] = await Promise.all([
      assertStaged({ versionId, artifactDigest, initialWorkerId: initial?.workerId, initialControls }),
      observeDeployment({ allowAbsent: true }),
    ]);
    assert.deepEqual(after, before, 'Active Worker deployment changed during candidate upload');
    if (initial) {
      const latest = await observeIngress({ lifecycle: true });
      assert.ok(latest.ingressDigest === initial.ingressDigest && latest.workerNeverDeployed && latest.deployment === null,
        'Initial Worker or ingress changed during candidate upload');
    }
    return initial ? { ...staged, initialControls } : staged;
  }

  async function promoteVersion({ fromVersionId, toVersionId }, assertBoundary) {
    await assertBoundary(false);
    const [before] = await Promise.all([observeDeployment({ allowAbsent: true }), readNormalVersion(toVersionId)]);
    if (before?.versionId === toVersionId) return before;
    assert.ok((fromVersionId === null || uuid.test(fromVersionId)) && (before?.versionId ?? null) === fromVersionId, 'Cloudflare has an unexpected live Worker version');
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
    await assertBoundary(true);
    return after;
  }

  // The R5 controller has already admitted a certified fresh installation.
  // The normal Access topology is required throughout publication.
  async function deployForOwnerEnrollment({ observed, staged, artifactDigest }) {
    assert.ok(observed?.workerId && observed.routesReady && observed.publicProtocolEnabled === false &&
      observed.backend === null, 'Owner enrollment requires protected canonical ingress');
    await assertWorkerArtifact({ ...staged, artifactDigest, initialWorkerId: observed.workerId });
    const fromVersionId = observed.deployment?.versionId ?? null;
    const toVersionId = staged.versionId;
    return promoteVersion({ fromVersionId, toVersionId }, async after => {
      const current = await observeLifecycle({ backendExpected: false, ownerSetup: true });
      assert.ok(current.routesReady && current.ingressDigest === observed.ingressDigest &&
        current.workerId === observed.workerId, 'Canonical ingress changed during owner enrollment publication');
      if (!after) assert.deepEqual(current.deployment, observed.deployment, 'Approved Worker deployment changed before publication');
      else assert.equal(current.deployment?.versionId, toVersionId, 'Owner enrollment Worker version changed after publication');
    });
  }

  async function observeIngress({ lifecycle = false } = {}) {
    assert.ok(uuid.test(authorPolicyId) && uuid.test(ciPolicyId) && authorPolicyId !== ciPolicyId &&
      typeof publicProtocolEnabled === 'boolean' && /^[a-z0-9-]+$/u.test(tunnelTeamName ?? ''),
    'Access policy IDs, Tunnel team and protocol ingress setting must be pinned');
    const host = target.hostname;
    // Terraform iterates the JSON-decoded map in lexicographic key order.
    const enabledProtocols = publicProtocolEnabled ? Object.keys(protocols).sort().map(key => protocols[key]) : [];
    const expectedPaths = ['', ...identityPaths, ...enabledProtocols.map(item => item.path)];
    // Positive absence requires an authenticated inventory, not a 404, failed
    // identity probe, or denied token.
    const workers = await readWorkerInventory();
    const normalWorker = workers.find(item => item.name === worker);
    const scriptPresent = normalWorker !== undefined;
    assert.ok(lifecycle || scriptPresent, 'Expected an existing normal Worker');
    if (normalWorker) {
      assertPrivateWorker(normalWorker.subdomain);
    }
    const [dns, workerRoutes, domains, applications, tunnel, deployment] = await Promise.all([
      list('proxied application DNS', `${zonePath}/dns_records?name=${host}`),
      result('Worker routes', `${zonePath}/workers/routes`),
      Promise.all([
        list('Worker custom domains', `${accountPath}/workers/domains?service=${worker}`),
        list('Worker custom domains for application', `${accountPath}/workers/domains?hostname=${host}`),
      ]),
      list('Access applications', `${accountPath}/access/apps`),
      result('Tunnel configuration', `${accountPath}/cfd_tunnel/${tunnelId}/configurations`),
      scriptPresent ? observeDeployment({ allowAbsent: lifecycle }) : null,
    ]);
    assert.ok(dns.length === 1 && dns[0].name === host && dns[0].proxied === true && dns[0].type === 'CNAME' &&
      dns[0].content === `${tunnelId}.cfargotunnel.com`, 'Application DNS must be the pinned proxied Tunnel CNAME');
    assert.ok(domains.every(items => items.length === 0), 'Worker custom domains permit alternate ingress');
    assert.ok(Array.isArray(workerRoutes), 'Cloudflare Worker route inventory is invalid');
    const relevantRoutes = workerRoutes.filter(route => route.script === worker || allowsHostname(route.pattern, host));
    const canonicalRoutes = [
      ...routes.routes.map(path => ({ pattern: host + path, script: worker })),
      ...routes.originRoutes.map(path => ({ pattern: host + path, script: null })),
    ];
    const routePlan = lifecycle && deployment === null && relevantRoutes.length === 0 ? [] : canonicalRoutes;
    assert.ok(scriptPresent || routePlan.length === 0, 'Normal frontend routes require an existing Worker');
    assert.deepEqual(relevantRoutes.map(route => ({ pattern: route.pattern, script: route.script ?? null }))
      .sort((a, b) => a.pattern.localeCompare(b.pattern)), routePlan.sort((a, b) => a.pattern.localeCompare(b.pattern)),
    'Worker routes expose alternate ingress or differ from the canonical routing contract');

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
    const workerId = normalWorker?.id ?? null;
    const topology = { dns: dns[0].id, workerId, workerRoutes: routePlan,
      access: relevantPolicies.sort((a, b) => a.path.localeCompare(b.path)), tunnel: tunnel.config,
    };
    const ingressDigest = `sha256:${createHash('sha256').update(JSON.stringify(canonical(topology))).digest('hex')}`;
    return { observedAt: new Date().toISOString(), origin: target.origin, deployment, ingressDigest, workerId,
      ...(lifecycle ? { scriptPresent, workerNeverDeployed: normalWorker?.deployed_on === null,
        routesReady: scriptPresent && routePlan.length > 0,
        publicProtocolEnabled } : {}) };
  }

  async function observeLifecycle({ backendExpected, ownerSetup = false }) {
    assert.ok(typeof backendExpected === 'boolean', 'Lifecycle backend observation mode is invalid');
    const ingress = await observeIngress({ lifecycle: true });
    const { origin: liveOrigin, clientId, clientSecret } = readFrontendReleaseConfiguration(accessEnv);
    assert.ok(liveOrigin.origin === target.origin, 'Protected identity origin differs from the pinned hostname');
    const credentials = { clientId, clientSecret };
    // Check both anonymous identity paths and author-route denial even when a
    // component is absent. A failed authenticated probe never proves absence.
    const boundary = await probeScopedIdentityAccess({ origin: liveOrigin, credentials, fetchImpl,
      checkBoundary: true, includeBackend: false, includeFrontend: false });
    assert.deepEqual(boundary, {});
    if (ownerSetup) {
      assert.ok(!ingress.publicProtocolEnabled, 'Owner setup requires protected canonical ingress');
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
    const after = await observeIngress({ lifecycle: true });
    assert.deepEqual({ deployment: ingress.deployment, ingressDigest: ingress.ingressDigest,
      scriptPresent: ingress.scriptPresent }, { deployment: after.deployment,
      ingressDigest: after.ingressDigest, scriptPresent: after.scriptPresent }, 'Ingress changed during observation');
    return { ...after, frontendState, frontend, backend };
  }

  return { observeLifecycle, observeIngress, observeDeployment, stage, assertStaged, assertWorkerArtifact, deployForOwnerEnrollment,
    readInitialWorkerControls };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    assert.equal(process.argv[2], 'observe-ingress');
    await deploymentEdgeFromEnvironment().observeIngress();
  } catch (error) {
    console.error('Protected Cloudflare ingress validation failed:', error.message);
    process.exitCode = 1;
  }
}
