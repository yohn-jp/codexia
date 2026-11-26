import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { readPreservationEvidence } from './preservation.mjs';
import { digestEvidence } from './evidence-digest.mjs';
import { authSchemaFingerprint, CODEXIA_AUTH_SCHEMA } from '../../../packages/api/src/auth-schema.ts';

const run = promisify(execFile);
const env = process.env;
const positive = value => Number.isSafeInteger(value) && value > 0;
const rawHash = /^[a-f0-9]{64}$/u;
const sha = /^[a-f0-9]{40}$/u;
const output = () => join(env.RUNNER_TEMP, 'codexia-lifecycle-preflight.json');

function runBinding() {
  assert.equal(env.GITHUB_REPOSITORY, 'yohn-jp/codexia');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.ok(sha.test(env.GITHUB_SHA ?? '') && positive(Number(env.GITHUB_RUN_ID)) &&
    positive(Number(env.GITHUB_RUN_ATTEMPT)), 'Invalid protected workflow identity');
  return { sourceSha: env.GITHUB_SHA, runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT) };
}

export function parsePreflightRequest(raw) {
  const request = JSON.parse(raw);
  assert.ok(request && typeof request === 'object' && !Array.isArray(request) &&
    Object.keys(request).every(key => ['backendPublisherRunId', 'priorBackendPublisherRunId',
      'frontend', 'intent', 'window'].includes(key)), 'Invalid preflight request');
  assert.ok(positive(request.backendPublisherRunId));
  assert.ok(request.priorBackendPublisherRunId === undefined || positive(request.priorBackendPublisherRunId));
  assert.ok(['install', 'adopt', 'update', 'maintenance', 'restore'].includes(request.intent));
  const front = request.frontend;
  assert.ok(front && Object.keys(front).sort().join(',') === 'artifactDigest,artifactId,runId,verifyRunId' &&
    [front.artifactId, front.runId, front.verifyRunId].every(positive) &&
    typeof front.artifactDigest === 'string' && rawHash.test(front.artifactDigest), 'Invalid frontend artifact reference');
  if (request.window != null) {
    const window = request.window;
    assert.ok(Object.keys(window).sort().join(',') === 'id,notAfter,notBefore' &&
      typeof window.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(window.id) &&
      ['notBefore','notAfter'].every(key => typeof window[key] === 'string' &&
        new Date(window[key]).toISOString() === window[key]) &&
      Date.parse(window.notBefore) < Date.parse(window.notAfter), 'Invalid preflight window');
  }
  return request;
}

export async function readLifecycleHost({ inventory, targetHost, sshDirectory = 'codexia-ssh' }) {
  const scratch = await mkdtemp(join(env.RUNNER_TEMP, 'codexia-lifecycle-'));
  try {
    const pin = (await readFile(join(env.RUNNER_TEMP, sshDirectory, 'known_hosts'), 'utf8')).trimEnd();
    assert.ok(targetHost && pin);
    const hostPinSha256 = digestEvidence({ target: targetHost, pin });
    const out = join(scratch, 'host.json');
    const vars = join(scratch, 'vars.json');
    let query;
    // Invoke the owning auth catalog definition with a read-only query adapter.
    // The reviewed SQL is executed in the existing PostgreSQL instance.
    await authSchemaFingerprint({ query: async (sql, parameters) => {
      assert.deepEqual(parameters, [CODEXIA_AUTH_SCHEMA]);
      assert.equal(sql.split('$1').length, 2);
      query = sql.replace('$1', "'codexia_auth'");
      return { rows: [] };
    }});
    assert.ok(query);
    const quadlets = {};
    for (const name of ['codexia.network','codexia-data.network','codexia-postgres.volume',
      'codexia-data.volume','codexia-history.volume','codexia-db.container','codexia-tunnel.container']) {
      quadlets[name] = createHash('sha256').update(await readFile(new URL('../../../deploy/quadlet/' + name, import.meta.url))).digest('hex');
    }
    await writeFile(vars, JSON.stringify({
      codexia_preflight_observation_file: out, codexia_preflight_auth_schema_query: query,
      codexia_preflight_quadlets: quadlets,
    }), { mode: 0o600, flag: 'wx' });
    await run('ansible-playbook', ['-i', inventory,
      'deploy/ansible/preflight-observe.yml', '--extra-vars', '@' + vars], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
    const host = JSON.parse(await readFile(out, 'utf8'));
    return { hostPinSha256, host };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function hostObservation({ bootstrap = false } = {}) {
  const binding = runBinding();
  const observed = await readLifecycleHost({
    inventory: join(env.RUNNER_TEMP, bootstrap ? 'codexia-bootstrap/control/inventory.yml' : 'codexia-preflight-inventory.yml'),
    targetHost: env.CODEXIA_PREFLIGHT_TARGET_HOST,
    sshDirectory: bootstrap ? 'codexia-bootstrap/ssh' : 'codexia-ssh',
  });
  await writeFile(join(env.RUNNER_TEMP, 'codexia-lifecycle-host.json'),
    JSON.stringify({ ...binding, ...observed }) + '\n', { mode: 0o600, flag: 'wx' });
}

async function mainSource() {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  assert.ok(token, 'Protected source check requires GitHub Actions read access');
  const { data: reference } = await createGitHubOctokit({ token, timeout: 30_000 }).rest.git.getRef({
    owner: 'yohn-jp', repo: 'codexia', ref: 'heads/main',
  });
  const main = reference.object?.sha;
  assert.equal(main, env.GITHUB_SHA, 'Main changed after protected dispatch');
  return main;
}

async function certifiedAuthSchemas(sourceSha) {
  assert.ok(sha.test(sourceSha));
  const { stdout: contract } = await run('git', ['show', sourceSha + ':packages/api/src/auth-schema.ts'], { timeout: 60_000 });
  // Extract fixed catalog identities from certified source. Never execute older
  // source code on the credentialed runner.
  const values = [...contract.matchAll(/^const EXPECTED_(?:SETUP_)?AUTH_SCHEMA = "(sha256:[a-f0-9]{64})";$/gm)]
    .map(match => match[1]);
  assert.ok(values.length > 0 && new Set(values).size === values.length, 'Certified auth schema identity not found');
  return values;
}

export async function readLifecycleCandidate(request) {
  runBinding();
  const { verifyCutoverBackendPublication } = await import('../handoff/verify-push.mjs');
  const { verifyCutoverFrontendArtifact } = await import('../../verification/artifacts/frontend.mjs');
  const { selectReleaseSource } = await import('../../release/components/source-gate.mjs');
  const main = await mainSource();
  const backend = await verifyCutoverBackendPublication(request.backendPublisherRunId);
  const candidateBackend = backend.fullCertificate;
  const authSchemas = await certifiedAuthSchemas(candidateBackend.verifiedMainSha);
  const candidateFrontend = await verifyCutoverFrontendArtifact(request.frontend, {
    expectedEpoch: candidateBackend.identity.apiEpoch,
  });
  const gitSync = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 60_000 });
  assert.ok(selectReleaseSource('backend', candidateBackend.verifiedMainSha, main, gitSync, null).affected);
  assert.ok(selectReleaseSource('frontend', candidateFrontend.identity.sourceSha, main, gitSync, null).affected);
  let priorBackend = null;
  if (request.priorBackendPublisherRunId === request.backendPublisherRunId) priorBackend = candidateBackend;
  else if (request.priorBackendPublisherRunId) {
    try {
      priorBackend = (await verifyCutoverBackendPublication(request.priorBackendPublisherRunId)).fullCertificate;
    } catch { /* normalized plan retains the unverified-source blocker */ }
  }
  await mainSource();
  return { candidateBackend, candidateFrontend, authSchemas, priorBackend };
}

async function candidateObservation() {
  const binding = runBinding();
  const request = parsePreflightRequest(env.CODEXIA_PREFLIGHT_REQUEST ?? '');
  const candidate = await readLifecycleCandidate(request);
  await writeFile(join(env.RUNNER_TEMP, 'codexia-lifecycle-candidate.json'),
    JSON.stringify({ ...binding, requestSha256: digestEvidence(request), ...candidate }) + '\n', { mode: 0o600, flag: 'wx' });
}

async function planObservation({ bootstrapMode } = {}) {
  const binding = runBinding();
  let stage = 'request';
  try {
    const request = parsePreflightRequest(env.CODEXIA_PREFLIGHT_REQUEST ?? '');
    await mainSource();
    stage = 'candidate-evidence';
    const candidate = JSON.parse(await readFile(join(env.RUNNER_TEMP, 'codexia-lifecycle-candidate.json'), 'utf8'));
    for (const [key, value] of Object.entries(binding)) assert.equal(candidate[key], value);
    assert.equal(candidate.requestSha256, digestEvidence(request));
    const { candidateBackend, candidateFrontend, authSchemas } = candidate;
    stage = 'host-evidence';
    const receipt = JSON.parse(await readFile(join(env.RUNNER_TEMP, 'codexia-lifecycle-host.json'), 'utf8'));
    for (const [key, value] of Object.entries(binding)) assert.equal(receipt[key], value);
    assert.ok(rawHash.test(receipt.hostPinSha256));
    const host = receipt.host;
    assert.equal(host.format, 'codexia-lifecycle-host/v1');
    stage = 'edge-observation';
    const { createCloudflareCutover } = await import('../../release/cutover/cloudflare.mjs');
    const config = JSON.parse(env.CODEXIA_CUTOVER_CLOUDFLARE_TARGET);
    assert.ok(config && Object.keys(config).every(key => ['accountId','zoneId','tunnelId','fenceRuleId',
      'acceptance','authorPolicyId','ciPolicyId','tunnelTeamName','publicProtocolEnabled'].includes(key)),
    'Invalid protected Cloudflare target');
    const edgeReader = createCloudflareCutover({
      ...config,
      origin: env.CODEXIA_PUBLIC_ORIGIN, accessEnv: env,
      readToken: env.CODEXIA_CUTOVER_CLOUDFLARE_READ_TOKEN,
      ...(bootstrapMode === 'publish-frontend' ? { workerToken: env.CLOUDFLARE_API_TOKEN } : {}),
    });
    let edge = null;
    try {
      edge = await edgeReader.observeLifecycle({
        backendExpected: host.backend?.state === 'running' ||
          (host.backend?.databaseAbsent === true && host.topology?.containers?.['codexia-api'] === true),
        ownerSetup: ['pending', 'unprepared'].includes(host.database?.authState),
      });
    } catch { /* failed or unauthorized observation is never absence */ }
    stage = 'plan';
    const { planFromObservations } = await import('./observe.mjs');
    const result = planFromObservations({ host, edge, hostPinSha256: receipt.hostPinSha256,
      candidateBackend, candidateFrontend, authSchemas, priorBackend: candidate.priorBackend,
      intent: request.intent, window: request.window ?? null,
      preservationReceipt: readPreservationEvidence(env.CODEXIA_CUTOVER_PRESERVATION, host) });
    await mainSource();
    if (bootstrapMode) {
      stage = 'bootstrap-admission';
      const { admitBootstrap, ownerSetupFrontendBindings, assertInitialFrontendReady } = await import('../bootstrap/admission.mjs');
      const { plan } = result;
      if (bootstrapMode !== 'bootstrap') {
        assert.equal(host.database.setupImage, candidateBackend.image, 'Owner setup must use the certified installation image');
      }
      const reviewed = JSON.parse(await readFile(join(env.RUNNER_TEMP, 'reviewed-preflight/codexia-lifecycle-preflight.json'), 'utf8'));
      assert.equal(reviewed.sourceSha, binding.sourceSha);
      assert.equal(reviewed.runId, Number(env.CODEXIA_BOOTSTRAP_PREFLIGHT_RUN_ID));
      assert.equal(reviewed.attempt, Number(env.CODEXIA_BOOTSTRAP_PREFLIGHT_ATTEMPT));
      assert.equal(reviewed.planSha256, env.CODEXIA_BOOTSTRAP_PLAN_SHA256);
      const admission = admitBootstrap({
        mode: bootstrapMode,
        plan: reviewed.plan,
        planSha256: reviewed.planSha256,
        current: plan,
        topology: host.topology,
        initializeDatabase: env.CODEXIA_BOOTSTRAP_DATABASE_INITIALIZATION_APPROVED === 'true',
      });
      if (bootstrapMode === 'publish-frontend') {
        assert.equal(env.CODEXIA_INITIAL_FRONTEND_APPROVAL, 'PUBLISH_INITIAL_FRONTEND');
        assert.notEqual(env.CODEXIA_EPOCH_CUTOVER_PAUSED, 'true', 'Production deployment is paused');
        assert.equal(request.intent, 'install');
        assert.ok(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID === config.accountId,
          'Canonical Worker publication credential and account must match the protected target');
        ownerSetupFrontendBindings(candidateFrontend.identity.oauthConfigIdentity, edge.origin);
        stage = 'canonical-frontend-publication';
        const { publishInitialFrontend } = await import('../bootstrap/publish-frontend.mjs');
        const { recordComponentRelease } = await import('../../release/components/record.mjs');
        await publishInitialFrontend({ edge: edgeReader, observed: edge, candidate: candidateFrontend,
          assertCurrentSource: mainSource,
          recordRelease: release => recordComponentRelease(release, { github: createGitHubOctokit({ token: env.GH_TOKEN }) }),
        });
        console.log('Certified canonical frontend and immutable release record verified for initial owner enrollment');
        return;
      }
      if (bootstrapMode === 'owner-setup') {
        assertInitialFrontendReady(edge, candidateFrontend.identity);
        const { initialFrontendRelease } = await import('../bootstrap/publish-frontend.mjs');
        const { assertComponentReleaseRecorded } = await import('../../release/components/record.mjs');
        await assertComponentReleaseRecorded(initialFrontendRelease(candidateFrontend),
          { github: createGitHubOctokit({ token: env.GH_TOKEN }) });
      }
      const overrides = bootstrapMode === 'bootstrap' ? {
        codexia_bootstrap_stages: admission.stages,
        codexia_owner_setup_install_intent: admission.installIntent,
        codexia_owner_setup_approved: false,
        ...(admission.installIntent && plan.observation.state.D === 'absent' &&
          (host.database.state === 'missing' || (host.database.state === 'absent' && host.topology?.storagePresent === true)) ? {
          codexia_expected_absent_database: host.database.state === 'missing' ? host.database.clusterId : 'absent',
        } : {}),
        ...(plan.observation.bootstrapResume ? {
          codexia_expected_bootstrap_resume: plan.observation.bootstrapResume,
        } : {}),
      } : {
        codexia_owner_setup_operation: bootstrapMode,
        codexia_expected_owner_setup_checkpoint: {
          ...host.database.ownerSetupCheckpoint,
          settingsSha256: host.database.settingsSha256 ?? null,
        },
      };
      if (admission.installIntent || admission.route === 'R5') {
        Object.assign(overrides, ownerSetupFrontendBindings(candidateFrontend.identity.oauthConfigIdentity, edge.origin));
      }
      await writeFile(join(env.RUNNER_TEMP, 'codexia-bootstrap/control/admission.json'),
        JSON.stringify(overrides) + '\n', { mode: 0o600, flag: 'wx' });
      console.log('Protected operation admitted for ' + admission.route);
      return;
    }
    await writeFile(output(), JSON.stringify({ ...binding, ...result }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log('Read-only lifecycle candidate route: ' + result.plan.candidateRoute +
      '; evidence blockers: ' + (result.plan.blockers.join(', ') || 'none') +
      '; no mutation authority granted');
    if (result.plan.route === 'R0') process.exitCode = 1;
  } catch {
    await writeFile(output(), JSON.stringify({ ...binding, format: 'codexia-lifecycle-preflight-failure/v1',
      route: 'R0', reason: stage, observedAt: new Date().toISOString() }) + '\n', { mode: 0o600, flag: 'wx' });
    console.error('Lifecycle operation stopped at ' + stage);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv[2] === 'candidate') await candidateObservation();
    else if (process.argv[2] === 'host') await hostObservation();
    else if (process.argv[2] === 'plan') await planObservation();
    else if (process.argv[2] === 'bootstrap-host') await hostObservation({ bootstrap: true });
    else if (process.argv[2] === 'initial-frontend') await planObservation({ bootstrapMode: 'publish-frontend' });
    else if (process.argv[2] === 'bootstrap-admission') await planObservation({
      bootstrapMode: env.CODEXIA_BOOTSTRAP_MODE,
    });
    else throw new Error('Unknown lifecycle preflight operation');
  } catch {
    console.error('Protected lifecycle operation failed');
    process.exitCode = 1;
  }
}
