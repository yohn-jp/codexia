import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectReleaseSource } from '../../release/components/source-gate.mjs';
import { createHandoffDeploymentOutputs, verifyLifecycleBackendPublication } from '../handoff/verify-push.mjs';
import { assertDeploymentPlanApproval, assertDeploymentPlanBinding } from '../preflight/plan.mjs';
import { digestEvidence } from '../preflight/evidence-digest.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';

const hash = /^[a-f0-9]{64}$/u;

export function assertManualActivationSource(certified, dispatch, liveMain, git) {
  assert.equal(git('rev-parse', 'HEAD').trim(), dispatch, 'Deployment checkout differs from the reviewed dispatch revision');
  assert.equal(liveMain, dispatch, 'The reviewed dispatch revision differs from live main');
  assert.ok(selectReleaseSource('backend', certified, liveMain, git, null).affected,
    'The certified publication has been superseded by newer Backend inputs');
}

function assertBackendOnly(plan) {
  const state = plan?.observation?.state;
  assert.ok(plan?.candidateRoute === 'R6' && plan.intent === 'install' && state?.B === 'absent' && state.F === 'compatible',
    'Backend-only first activation requires R6 with a clean API slot and compatible deployed Frontend');
}

function assertAdoptedBackendOnly(plan) {
  const s = plan?.observation?.state;
  assert.ok(plan?.candidateRoute === 'R6' && plan.intent === 'adopt' &&
    s?.M === 'ready' && s.H === 'ready' && s.D === 'compatible' && s.A === 'ready' &&
    s.B === 'absent' && s.F === 'compatible' && s.T === 'none' &&
    /^[a-f0-9]{64}$/u.test(plan.observation.binding.backupSha256 ?? ''),
  'Existing-owner R6 adoption requires verified compatible database, owner and preservation evidence');
}

function assertRestoredBackendOnly(plan) {
  const state = plan?.observation?.state;
  assert.ok(plan?.candidateRoute === 'R3' && plan.intent === 'restore' && state?.B === 'absent' &&
    state.F === 'compatible' && typeof plan.observation.recoveryOperationId === 'string',
  'Restored Backend publication requires an approved R3 plan for a clean API slot and compatible Frontend');
}

function backendAdmissionEvidence({ plan, current, host }) {
  const { clusterId, databaseOid, ownerBindingSha256, settingsSha256 } = host.database;
  assert.ok(host.hostId === current.observation.binding.hostId && hash.test(host.hostId) &&
    /^[1-9][0-9]{0,19}$/u.test(clusterId) && /^[1-9][0-9]{0,9}$/u.test(databaseOid) &&
    /^sha256:[a-f0-9]{64}$/u.test(ownerBindingSha256) && hash.test(settingsSha256),
  'Backend activation requires the exact host, PostgreSQL database and verified owner settings');
  const { secretHashes } = host.topology ?? {};
  assert.ok(secretHashes && Object.values(secretHashes).length > 0 &&
    Object.values(secretHashes).every(value => hash.test(value)),
    'Backend activation requires observed Podman credential identities');
  return { hostId: host.hostId, clusterId, databaseOid, ownerBindingSha256, settingsSha256,
    secretSetSha256: digestEvidence(secretHashes),
    notBeforeMs: Date.parse(plan.window.notBefore), notAfterMs: Date.parse(plan.window.notAfter) };
}

export function admitBackendActivation({ deployment, current, host, flags, now = new Date() }) {
  const { plan } = deployment;
  assertBackendOnly(plan);
  assert.ok(flags.initialInstall === true && flags.databaseUse === true,
    'First installation and database use require protected approvals');
  assertDeploymentPlanApproval({ ...deployment, current, now });
  return backendAdmissionEvidence({ plan, current, host });
}

export function admitBackendAdoption({ deployment, current, host, flags, now = new Date() }) {
  const { plan } = deployment;
  assertAdoptedBackendOnly(plan);
  assert.ok(flags.databaseAdoption === true && flags.initialInstall !== true &&
    flags.databaseInitialization !== true,
  'Existing database adoption requires distinct protected approval without initialization');
  assertDeploymentPlanApproval({ ...deployment, current, now });
  return { ...backendAdmissionEvidence({ plan, current, host }),
    preservationSha256: plan.observation.binding.backupSha256 };
}

export function admitBackendRecovery({ deployment, current, host, now = new Date() }) {
  const { plan } = deployment;
  assertRestoredBackendOnly(plan);
  assertDeploymentPlanApproval({ ...deployment, current, now });
  const { recoveryOperationId: operationId, binding: { backupSha256: evidenceSha256 } } = plan.observation;
  assert.ok(host.recovery?.operationId === operationId && host.recovery.evidenceSha256 === evidenceSha256,
    'Live protected recovery evidence differs from the reviewed plan');
  return { ...backendAdmissionEvidence({ plan, current, host }), operationId, evidenceSha256 };
}

async function main(stage, env) {
  assert.equal(env.GITHUB_REPOSITORY, 'yohn-jp/codexia');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  if (stage === 'freshness') {
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 60_000 });
    const token = env.GH_TOKEN || env.GITHUB_TOKEN;
    assert.ok(token, 'Protected source freshness requires GitHub Actions read access');
    const { data: reference } = await createGitHubOctokit({ token, timeout: 30_000 }).rest.git.getRef({
      owner: 'yohn-jp', repo: 'codexia', ref: 'heads/main',
    });
    const liveMain = reference.object?.sha;
    assertManualActivationSource(env.CODEXIA_VERIFIED_MAIN_SHA, env.GITHUB_SHA, liveMain, git);
    await appendFile(env.GITHUB_OUTPUT, 'current=true\n');
    return;
  }
  const receipt = JSON.parse(await readFile(join(env.RUNNER_TEMP, 'reviewed-preflight/codexia-lifecycle-preflight.json'), 'utf8'));
  const { parsePreflightRequest, readLifecycleCandidate, readLifecycleHost } = await import('../preflight/run.mjs');
  const request = parsePreflightRequest(JSON.stringify(receipt.request));
  const { plan, planSha256 } = receipt;
  const recovery = env.CODEXIA_FIRST_ACTIVATION_APPROVAL === 'PUBLISH_RESTORED_CODEXIA_BACKEND';
  const adoption = env.CODEXIA_FIRST_ACTIVATION_APPROVAL === 'ADOPT_EXISTING_CODEXIA_BACKEND';
  if (recovery) assertRestoredBackendOnly(plan);
  else if (adoption) assertAdoptedBackendOnly(plan);
  else {
    assert.equal(env.CODEXIA_FIRST_ACTIVATION_APPROVAL, 'ACTIVATE_CODEXIA_BACKEND');
    assertBackendOnly(plan);
  }
  assert.equal(request.intent, plan.intent);
  assert.deepEqual(request.window, plan.window);
  const grants = recovery ? ['maintenance', 'recovery', 'publication']
    : adoption ? ['database-adoption', 'publication'] : ['first-install', 'database-use', 'publication'];
  const deployment = { plan, planSha256, approval: { planSha256, grants } };
  assertDeploymentPlanBinding(deployment);
  if (stage === 'certify') {
    const release = createHandoffDeploymentOutputs(await verifyLifecycleBackendPublication(request.backendPublisherRunId));
    await appendFile(env.GITHUB_OUTPUT, `full-image=${release.fullImage}\nfull-api-epoch=${release.fullApiEpoch}\n` +
      `verified-main-sha=${release.verifiedMainSha}\nproducer-sha=${release.producerSha}\nfull-certificate=${release.fullCertificate}\n`);
    return;
  }

  assert.equal(stage, 'admit');
  const { createDeploymentEdge } = await import('../../release/frontend/initial-publication.mjs');
  const { planFromObservations } = await import('../preflight/observe.mjs');
  const releases = await readLifecycleCandidate(request);
  assert.deepEqual(releases.candidateBackend, JSON.parse(Buffer.from(env.CODEXIA_DEPLOYMENT_CERTIFICATE_B64, 'base64')),
    'Reverified backend certificate differs from the verified deployment handoff');
  const { host, hostPinSha256, authSchemaQuery } = await readLifecycleHost({
    inventory: join(env.RUNNER_TEMP, 'codexia-first-activation-inventory.yml'),
    targetHost: env.CODEXIA_PREFLIGHT_TARGET_HOST, recovery, adoption,
  });
  const edge = await createDeploymentEdge({ ...JSON.parse(env.CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET),
    origin: env.CODEXIA_PUBLIC_ORIGIN, accessEnv: env,
    readToken: env.CODEXIA_DEPLOYMENT_CLOUDFLARE_READ_TOKEN,
  }).observeLifecycle({ backendExpected: host.backend.state === 'running' });
  const { readPreservationEvidence } = await import('../preflight/preservation.mjs');
  const preservationReceipt = adoption
    ? readPreservationEvidence(JSON.stringify(receipt.evidence?.preservationReceipt ?? null), host)
    : null;
  const { plan: current } = planFromObservations({ host, edge, hostPinSha256, ...releases,
    intent: request.intent, window: request.window, preservationReceipt });
  if (!recovery && !adoption) assert.equal(host.database.setupImage, releases.candidateBackend.image,
    'First activation must use the certified owner setup image');
  const evidence = recovery
    ? admitBackendRecovery({ deployment, current, host })
    : adoption ? admitBackendAdoption({ deployment, current, host, flags: {
      databaseAdoption: env.CODEXIA_DATABASE_ADOPTION_APPROVED === 'true',
      initialInstall: env.CODEXIA_INITIAL_INSTALL_APPROVED === 'true',
      databaseInitialization: env.CODEXIA_DATABASE_INITIALIZATION_APPROVED === 'true',
    } })
    : admitBackendActivation({ deployment, current, host, flags: {
      initialInstall: env.CODEXIA_INITIAL_INSTALL_APPROVED === 'true',
      databaseUse: env.CODEXIA_DATABASE_INITIALIZATION_APPROVED === 'true',
    } });
  const name = recovery ? 'codexia-recovery-activation.json'
    : adoption ? 'codexia-adopt-activation.json' : 'codexia-first-activation.json';
  await writeFile(join(env.RUNNER_TEMP, name), JSON.stringify(recovery || adoption ? { ...evidence, authSchemaQuery } : evidence) + '\n',
    { flag: 'wx', mode: 0o600 });
  console.log(recovery ? 'Protected R3 restored Backend publication admitted against the deployed Frontend.' :
    adoption ? 'Protected R6 existing-owner adoption admitted against the deployed Frontend.' :
      'Protected R6 Backend-only activation admitted against the deployed Frontend.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main(process.argv[2], process.env);
  } catch {
    console.error('Protected Backend activation stopped at source freshness, candidate certification or exact plan admission.');
    process.exitCode = 1;
  }
}
