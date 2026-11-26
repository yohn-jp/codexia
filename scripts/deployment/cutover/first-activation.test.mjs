import assert from 'node:assert/strict';
import test from 'node:test';
import { migrationSetFingerprint } from '../../../packages/persistence-postgres/src/migration-set.ts';
import { frontendOAuthConfigIdentity } from '../../build/frontend/oauth-config.mjs';
import { planFromObservations } from '../preflight/observe.mjs';
import { digestEvidence } from './coordinator.mjs';
import { executePairCutover } from './run.mjs';

const origin = 'https://fixture.example.test';
const hash = value => value.repeat(64);
const image = 'ghcr.io/yohn-jp/codexia-backend@sha256:' + hash('a');
const workerId = 'e'.repeat(32);
const candidateWorker = '10000000-0000-4000-8000-000000000001';
const otherWorkerVersion = '10000000-0000-4000-8000-000000000002';
const initialControls = Object.freeze({ _headers: hash('a'), _redirects: hash('b') });
const otherControls = Object.freeze({ _headers: hash('c'), _redirects: hash('d') });
const publicSettings = {
  VITE_CODEXIA_OAUTH_ISSUER: origin + '/api/auth',
  VITE_CODEXIA_OAUTH_CLIENT_ID: 'codexia-web',
  VITE_CODEXIA_API_AUDIENCE: origin + '/api',
  VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI: origin + '/desktop/',
  VITE_CODEXIA_OAUTH_SCOPES: 'openid codexia:api',
};

function fixture(t) {
  const timestamp = new Date();
  const window = { id: 'fixture-window', notBefore: new Date(timestamp.getTime() - 60_000).toISOString(),
    notAfter: new Date(timestamp.getTime() + 600_000).toISOString() };
  const ledger = [{ version: '0001-initial.sql', checksum: hash('b') }];
  const migrationFingerprint = migrationSetFingerprint(ledger);
  const schema = 'sha256:' + hash('c');
  const ownerBindingSha256 = 'sha256:' + hash('d');
  const host = {
    format: 'codexia-lifecycle-host/v1', hostId: hash('e'), M: 'ready', H: 'ready', topology: {},
    transaction: null, backend: { state: 'absent' },
    database: { state: 'initialized', clusterId: '123', ledger, authState: 'ready', authSchemaSha256: schema,
      ownerBindingSha256, settingsSha256: hash('f') },
  };
  const preservation = { format: 'codexia-cutover-preservation/v1', sourceHostId: host.hostId,
    databaseSha256: digestEvidence(host.database), independentBackupEvidenceSha256: hash('1') };
  const candidateBackend = { image, verifiedMainSha: 'a'.repeat(40), identity: {
    format: 'codexia-backend-identity/v1', version: '1.0.0', sourceSha: 'a'.repeat(40),
    profile: 'full', platform: 'linux/amd64', migrationFingerprint, apiEpoch: 2, persistenceFormat: 2,
  } };
  const frontendReference = { runId: 4, verifyRunId: 5, artifactId: 6, artifactDigest: hash('2') };
  const candidateFrontend = { ...frontendReference, identity: {
    format: 'codexia-frontend-identity/v1', version: '1.0.0', sourceSha: 'b'.repeat(40),
    profile: 'full', apiEpoch: 2, oauthConfigIdentity: frontendOAuthConfigIdentity(publicSettings),
  } };
  const releases = { candidateBackend, candidateFrontend, authSchemas: [schema], priorBackend: null };
  const hostPinSha256 = hash('3');
  const artifacts = { backendPublisherRunId: 7, frontend: frontendReference };

  const protectedInputs = {
    ...publicSettings, CODEXIA_EPOCH_CUTOVER_PAUSED: 'true', CODEXIA_INITIAL_INSTALL_APPROVED: 'true',
    CODEXIA_DATABASE_INITIALIZATION_APPROVED: 'true', CODEXIA_PUBLIC_ORIGIN: origin, RUNNER_TEMP: '/fixture',
    CODEXIA_CUTOVER_CLOUDFLARE_TARGET: '{}', CODEXIA_PREFLIGHT_TARGET_HOST: 'fixture.example.test',
    CODEXIA_CUTOVER_PRESERVATION: JSON.stringify(preservation),
    CODEXIA_CUTOVER_RECOVERY_RECEIPT: '', CODEXIA_CUTOVER_ACCEPTANCE: '',
  };
  for (const [key, value] of Object.entries(protectedInputs)) {
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }
  t.mock.method(globalThis, 'fetch', () => assert.fail('First activation fixture must never perform network I/O'));

  const calls = [];
  const published = [];
  const backup = { checksumManifestSha256: hash('4'), databaseFingerprint: hash('5'), historyFingerprint: hash('6') };
  let prepared = false;
  let ownerSetup = null;
  let staged = false;
  let fenced = false;
  let deployment = null;
  let interruptStartup = false;
  let journal = { phase: null, planSha256: null };

  const ingress = () => ({
    observedAt: new Date().toISOString(), origin, fence: { enabled: fenced }, deployment,
    ingressDigest: 'sha256:' + (ownerSetup ? hash('7') : prepared ? hash('8') : hash('9')),
    scriptPresent: prepared, routesReady: prepared, workerId: prepared ? workerId : null,
    workerNeverDeployed: prepared && deployment === null, ownerSetup,
  });
  const edge = {
    async observeIngress() { return ingress(); },
    async observeLifecycle({ backendExpected }) {
      assert.equal(backendExpected, false);
      return { ...ingress(), frontendState: 'absent', frontend: null, backend: null };
    },
    async readInitialWorkerControls() { return initialControls; },
    async stage({ previousVersionId, artifactDigest }) {
      assert.ok(prepared);
      assert.equal(ownerSetup, null);
      assert.equal(previousVersionId, null);
      assert.equal(deployment, null);
      assert.equal(artifactDigest, 'sha256:' + frontendReference.artifactDigest);
      calls.push('worker-stage');
      staged = true;
      return { versionId: candidateWorker, initialControls };
    },
    async assertStaged(evidence) {
      assert.ok(staged);
      assert.equal(deployment, null);
      await this.assertWorkerArtifact(evidence);
    },
    async assertWorkerArtifact({ versionId, artifactDigest, initialControls: controls }) {
      assert.ok([candidateWorker, otherWorkerVersion].includes(versionId));
      assert.deepEqual(controls, versionId === candidateWorker ? initialControls : otherControls,
        'Initial Worker publication controls differ from the certified archive');
      assert.equal(artifactDigest, 'sha256:' + frontendReference.artifactDigest);
    },
    async fence() { calls.push('fence'); fenced = true; },
    async unfence() {
      assert.equal(journal.phase, 'candidate-publishing');
      calls.push('unfence');
      fenced = false;
    },
    async verifyFenced() { assert.equal(fenced, true); },
    async verifyUnfenced() { assert.equal(fenced, false); },
    async deploy({ fromVersionId, toVersionId }) {
      assert.equal(fenced, true);
      assert.equal(journal.phase, 'candidate-tunnel');
      assert.equal(fromVersionId, null);
      assert.equal(deployment, null);
      assert.equal(toVersionId, candidateWorker);
      calls.push('worker-deploy');
      published.push(toVersionId);
      deployment = { id: candidateWorker, versionId: toVersionId, createdAt: new Date().toISOString() };
    },
    async observe() {
      assert.equal(deployment?.versionId, candidateWorker);
      return { ...ingress(), frontend: candidateFrontend.identity, backend: {
        name: 'codexia', version: '1.0.0', profile: 'full', apiEpoch: 2, auth: ['oauth-owner', 'oauth-mcp'],
      } };
    },
  };
  const runAnsible = async (_scratch, _inventory, playbook, vars) => {
    if (playbook === 'cutover-observe.yml') {
      return { observedAt: new Date().toISOString(), hostId: host.hostId,
        database: { clusterId: host.database.clusterId, migrationLedgerSha256: migrationFingerprint },
        writer: { image, identity: candidateBackend.identity, authMode: 'better-auth', ownerBindingSha256 },
        tunnel: { unitState: 'active', containerRunning: true } };
    }
    assert.equal(playbook, 'cutover-host.yml');
    const { cutover_operation: action, cutover_request: request } = vars;
    if (action === 'observe') return journal;
    if (action === 'stage') {
      assert.equal(request.priorImage, null);
      assert.equal(request.candidateImage, image);
      assert.equal(request.ownerBindingSha256, ownerBindingSha256);
      assert.equal(deployment, null);
      calls.push(action);
      return { candidateUnitSha256: hash('1') };
    }
    assert.equal(request.migration, null);
    assert.equal(request.priorImage, null);
    assert.equal(request.ownerBindingSha256, ownerBindingSha256);
    assert.equal(request.databaseSystemIdentifier, host.database.clusterId);
    assert.equal(request.candidateUnitSha256, hash('1'));
    calls.push(action);
    if (action === 'admit') assert.equal(journal.phase, null);
    else assert.equal(request.planSha256, journal.planSha256);
    if (action === 'apply') assert.match(request.recoveryReceiptSha256, /^[a-f0-9]{64}$/u);
    const phase = { admit: 'intent', checkpoint: 'checkpointed', apply: 'candidate-ready',
      'open-tunnel': 'candidate-tunnel', publishing: 'candidate-publishing', finish: 'finished' }[action];
    assert.ok(phase, `Unexpected host mutation ${action}`);
    journal = { ...journal, ...backup, phase, planSha256: request.planSha256,
      phaseChangedAt: journal.phase === phase ? journal.phaseChangedAt : new Date().toISOString(),
      outcome: request.outcome ?? journal.outcome };
    if (action === 'apply' && interruptStartup) {
      interruptStartup = false;
      throw new Error('First API startup response lost');
    }
    return { status: phase };
  };
  const tools = {
    createEdge: () => edge, runAnsible,
    readHost: async () => ({ host: { ...host, observedAt: new Date().toISOString() }, hostPinSha256 }),
    readCandidate: async () => releases,
  };
  const execute = (operation, input) => executePairCutover(operation, input, '/fixture', tools);
  const review = async () => {
    const { plan, planSha256 } = planFromObservations({
      ...(await tools.readHost()), ...releases, intent: 'install', window, preservationReceipt: preservation,
      edge: await edge.observeLifecycle({ backendExpected: false }),
    });
    assert.equal(plan.candidateRoute, 'R6');
    assert.deepEqual(plan.requiredApprovals, ['first-install', 'database-use', 'publication']);
    assert.equal(plan.observation.state.F, 'absent');
    return { artifacts, ingressReviewSha256: hash('a'),
      deployment: { plan, planSha256, approval: { planSha256, grants: [...plan.requiredApprovals] } } };
  };
  return { execute, review, calls, published,
    prepare() { prepared = true; },
    attachOldSetup() { ownerSetup = { versionId: 'old-setup', artifactDigest: hash('b') }; },
    detachSetup() { ownerSetup = null; },
    loseStartupResponse() { interruptStartup = true; },
  };
}

test('R6 starts with no normal Worker, stages privately after infrastructure preparation, and publishes the approved first pair', async t => {
  const cut = fixture(t);
  const absent = await cut.review();
  await assert.rejects(cut.execute('stage', absent), /Prepare the canonical private Worker/u);
  assert.deepEqual(cut.calls, []);
  cut.prepare();
  await assert.rejects(cut.execute('stage', absent), /changed after approval/u);
  const stage = await cut.execute('stage', await cut.review());
  assert.equal(stage.status, 'staged');
  assert.equal(stage.plan.prior.image, null);
  assert.equal(stage.plan.prior.workerVersion, null);
  assert.deepEqual(stage.plan.candidate.initialControls, initialControls);
  assert.deepEqual([...cut.calls].sort(), ['stage', 'worker-stage']);
  assert.deepEqual(cut.published, []);

  const stagedInput = { plan: stage.plan, approval: stage.planSha256 };
  await assert.rejects(cut.execute('advance', { ...stagedInput, approval: hash('b') }), /staged plan and origin/u);
  cut.attachOldSetup();
  await assert.rejects(cut.execute('advance', stagedInput), /Reviewed ingress topology changed/u);
  assert.deepEqual([...cut.calls].sort(), ['stage', 'worker-stage']);
  cut.detachSetup();
  const preservation = await cut.execute('advance', stagedInput);
  assert.equal(preservation.status, 'awaiting-independent-recovery-proof');
  assert.deepEqual(cut.calls.slice(-3), ['admit', 'fence', 'checkpoint']);
  assert.deepEqual(cut.published, []);

  const recoveryHostId = hash('c');
  const verifiedAt = new Date().toISOString();
  const binding = preservation.binding;
  const receipt = { format: 'codexia-epoch-cutover-recovery/v1', binding, recoveryHostId, verifiedAt,
    authRecovery: { format: 'codexia-epoch-cutover-auth-recovery/v1', binding, recoveryHostId, verifiedAt,
      evidence: Object.fromEntries(['offVmCiphertext', 'postgresRoles', 'podmanSecrets',
        'previousOwnerAuthentication', 'rollbackProcedure'].map(key => [key, hash('d')])) } };
  process.env.CODEXIA_CUTOVER_RECOVERY_RECEIPT = JSON.stringify(receipt);
  cut.loseStartupResponse();
  await assert.rejects(cut.execute('advance', stagedInput), /First API startup response lost/u);
  assert.equal(cut.calls.at(-1), 'apply');
  assert.deepEqual(cut.published, []);
  assert.equal((await cut.execute('advance', stagedInput)).status, 'awaiting-functional-acceptance');
  assert.deepEqual(cut.calls.slice(-3), ['apply', 'open-tunnel', 'worker-deploy']);
  assert.equal(cut.calls.filter(action => action === 'apply').length, 1);
  assert.deepEqual(cut.published, [candidateWorker]);
  assert.ok(!cut.calls.includes('unfence'));

  const acceptance = {
    format: 'codexia-cutover-functional-acceptance/v1', planSha256: stage.planSha256, outcome: 'candidate',
    origin, image, workerVersion: candidateWorker, verifiedAt: new Date().toISOString(),
    checks: Object.fromEntries(['ownerLogin', 'passkey', 'oauth', 'manuscript', 'history', 'permissionDenial',
      'accessBoundary'].map(key => [key, hash('e')])),
  };
  process.env.CODEXIA_CUTOVER_ACCEPTANCE = JSON.stringify({ ...acceptance, planSha256: hash('f') });
  await assert.rejects(cut.execute('advance', stagedInput), /does not identify this plan/u);
  assert.ok(!cut.calls.includes('unfence'));
  process.env.CODEXIA_CUTOVER_ACCEPTANCE = JSON.stringify(acceptance);
  const result = await cut.execute('advance', stagedInput);
  assert.equal(result.status, 'finished');
  assert.equal(result.backendImage, image);
  assert.equal(result.workerVersion, candidateWorker);
  assert.deepEqual(cut.calls.slice(-3), ['publishing', 'unfence', 'finish']);
  assert.deepEqual(cut.published, [candidateWorker]);
});

test('R6 rejects a recomputed stage approval for a version carrying foreign publication controls', async t => {
  const cut = fixture(t);
  cut.prepare();
  const stage = await cut.execute('stage', await cut.review());
  for (const [workerVersion, controls] of [
    [candidateWorker, otherControls],
    [otherWorkerVersion, otherControls],
    [otherWorkerVersion, initialControls],
  ]) {
    const plan = { ...stage.plan, candidate: { ...stage.plan.candidate, workerVersion, initialControls: controls } };
    await assert.rejects(cut.execute('advance', { plan, approval: digestEvidence(plan) }),
      /publication controls|Staged pair no longer matches fresh certified release/u);
    assert.deepEqual([...cut.calls].sort(), ['stage', 'worker-stage']);
    assert.deepEqual(cut.published, []);
  }
});

test('R6 stops before staging without both protected switches or with the old setup edge still attached', async t => {
  const cut = fixture(t);
  cut.prepare();
  const reviewed = await cut.review();
  process.env.CODEXIA_INITIAL_INSTALL_APPROVED = 'false';
  await assert.rejects(cut.execute('stage', reviewed), /protected approvals/u);
  process.env.CODEXIA_INITIAL_INSTALL_APPROVED = 'true';
  process.env.CODEXIA_DATABASE_INITIALIZATION_APPROVED = 'false';
  await assert.rejects(cut.execute('stage', reviewed), /protected approvals/u);
  process.env.CODEXIA_DATABASE_INITIALIZATION_APPROVED = 'true';
  const incomplete = { ...reviewed.deployment, approval: { planSha256: reviewed.deployment.planSha256,
    grants: ['first-install', 'database-use'] } };
  await assert.rejects(cut.execute('stage', { ...reviewed, deployment: incomplete }), /exact deployment plan and required grants/u);
  await assert.rejects(cut.execute('stage', { ...reviewed, artifacts: {
    ...reviewed.artifacts, priorBackendPublisherRunId: 8,
  } }), /no prior Backend release/u);
  cut.attachOldSetup();
  await assert.rejects(cut.execute('stage', await cut.review()), /detached owner setup/u);
  assert.deepEqual(cut.calls, []);
});
