import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { assertFrontendOAuthConfigIdentity } from '../../build/frontend/oauth-config.mjs';
import { createCloudflareCutover } from '../../release/cutover/cloudflare.mjs';
import { validateEpochCutoverRecoveryReceipt } from '../recovery/epoch-cutover.mjs';
import { planFromObservations, publicFrontendEvidence } from '../preflight/observe.mjs';
import { assertDeploymentPlanApproval, assertDeploymentPlanBinding } from '../preflight/plan.mjs';
import { parsePreflightRequest, readLifecycleCandidate, readLifecycleHost } from '../preflight/run.mjs';
import { assertPairedObservation, digestEvidence } from './coordinator.mjs';
import { approvedMigration } from './transitions.mjs';
import { readPreservationEvidence } from './preservation.mjs';
import { advancePair, verifyReactivationWindow } from './execute.mjs';

const env = process.env;
const run = promisify(execFile);
const rawHash = /^[a-f0-9]{64}$/u;
const planFormat = 'codexia-pair-cutover/v1';
const backupFields = ['checksumManifestSha256', 'databaseFingerprint', 'historyFingerprint'];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function ansible(scratch, inventory, playbook, vars, outputKey) {
  const output = await mkdtemp(join(scratch, 'phase-'));
  const outFile = join(output, 'result.json');
  const varsFile = join(output, 'vars.json');
  await writeFile(varsFile, JSON.stringify({ ...vars, [outputKey]: outFile }), { mode: 0o600, flag: 'wx' });
  try {
    await run('ansible-playbook', ['-i', inventory, 'deploy/ansible/' + playbook, '--extra-vars', '@' + varsFile],
      { timeout: 20 * 60_000 });
    return JSON.parse(await readFile(outFile, 'utf8'));
  } catch {
    throw new Error('Pinned Ansible target did not complete ' + (vars.cutover_operation || 'read-only observation'));
  }
}

function assertPairRoute(plan) {
  requireCondition(plan?.candidateRoute === 'R6'
    ? plan.observation.state.B === 'absent' && plan.observation.state.F !== 'compatible'
    : ['R3', 'R7'].includes(plan?.candidateRoute) && plan.candidateSystem === 'cutover' &&
      ['compatible', 'incompatible'].includes(plan.observation.state.B),
  'The approved plan does not select a supported pair activation or cutover');
  if (plan.candidateRoute === 'R6') {
    requireCondition(env.CODEXIA_INITIAL_INSTALL_APPROVED === 'true' &&
      env.CODEXIA_DATABASE_INITIALIZATION_APPROVED === 'true', 'First activation and database use need their protected approvals');
  }
}

function hostInput(plan, planSha256) {
  const { environment, prior, candidate, deployment } = plan;
  return {
    planSha256, notAfter: deployment.plan.window.notAfter, sourceHostId: environment.hostId,
    databaseSystemIdentifier: environment.clusterId, ownerBindingSha256: environment.ownerBindingSha256,
    priorImage: prior.image, priorIdentity: prior.identity, priorUnitSha256: prior.unitSha256,
    priorContainerId: prior.containerId, candidateImage: candidate.image, candidateIdentity: candidate.identity,
    candidateUnitSha256: candidate.unitSha256, settingsSha256: environment.settingsSha256,
    migration: approvedMigration(deployment.plan.transition)?.handler ?? null,
  };
}

function recoveryBinding(plan, planSha256, checkpoint, window) {
  requireCondition(backupFields.every(key => rawHash.test(checkpoint[key] ?? '')),
    'Host checkpoint did not report verified backup fingerprints');
  return {
    planSha256, migration: approvedMigration(plan.deployment.plan.transition)?.handler ?? null,
    environment: 'codexia-production', hostname: new URL(plan.environment.origin).hostname,
    sourceHostId: plan.environment.hostId, databaseSystemIdentifier: plan.environment.clusterId,
    maintenanceWindowId: window.id,
    priorImage: plan.prior.image, candidateImage: plan.candidate.image,
    priorMigrationFingerprint: plan.prior.identity?.migrationFingerprint ?? null,
    candidateMigrationFingerprint: plan.candidate.identity.migrationFingerprint,
    ...Object.fromEntries(backupFields.map(key => [key, checkpoint[key]])),
  };
}

function restoreRequest(planSha256, journal) {
  if (!journal.requiresRestore) return {};
  if (!env.CODEXIA_CUTOVER_RESTORE_RECEIPT) return null;
  const receipt = JSON.parse(env.CODEXIA_CUTOVER_RESTORE_RECEIPT);
  requireCondition(receipt?.format === 'codexia-cutover-restoration/v1' && receipt.planSha256 === planSha256 &&
    backupFields.every(key => rawHash.test(receipt[key] ?? '') && receipt[key] === journal[key]) &&
    rawHash.test(receipt.procedureEvidenceSha256 ?? ''), 'Recovery needs exact protected restoration evidence');
  const restored = Date.parse(receipt.verifiedAt);
  requireCondition(restored >= Date.parse(journal.recoveryStartedAt) && restored <= Date.now(),
    'Restoration evidence is stale or in the future');
  return { ...Object.fromEntries(backupFields.map(key => [key, receipt[key]])), restoreReceiptSha256: digestEvidence(receipt) };
}

function pairInputs(deployment, artifacts, retained, current, references) {
  const { host, network, candidateBackend, candidateFrontend } = current;
  const writer = host.backend.writer;
  requireCondition(host.backend.state === 'running' || host.backend.state === 'absent', 'Source API slot is not verified');
  requireCondition(network.scriptPresent && network.routesReady, 'Prepare the canonical private Worker and routes using Cloudflare infrastructure before cutover');
  const environment = {
    origin: network.origin, ingressDigest: network.ingressDigest, hostId: host.hostId,
    clusterId: host.database.clusterId, ownerBindingSha256: host.database.ownerBindingSha256,
    settingsSha256: writer?.settingsSha256?.slice(7) ?? host.database.settingsSha256,
    ingressReviewSha256: retained.ingressReviewSha256,
  };
  const prior = {
    image: writer?.image ?? null, identity: writer?.identity ?? null,
    frontend: publicFrontendEvidence(network.frontend), workerVersion: network.deployment?.versionId ?? null,
    containerId: writer?.containerId ?? null, unitSha256: writer?.quadletSha256?.slice(7) ?? null,
    protocol: network.backend?.standaloneOAuth === false ? 'legacy' : 'standalone',
    archiveSha256: network.deployment ? retained.priorArchiveSha256 : null,
  };
  requireCondition(rawHash.test(environment.ingressReviewSha256 ?? '') &&
    rawHash.test(environment.settingsSha256 ?? '') &&
    /^sha256:[a-f0-9]{64}$/u.test(environment.ownerBindingSha256 ?? '') &&
    (prior.workerVersion === null || rawHash.test(prior.archiveSha256 ?? '')),
  'Independent ingress review, owner settings and retained prior archive evidence are required');
  const candidate = {
    image: candidateBackend.image, identity: candidateBackend.identity,
    frontend: publicFrontendEvidence(candidateFrontend.identity),
    frontendArtifact: { artifactDigest: candidateFrontend.artifactDigest },
    unitSha256: references?.candidate.unitSha256 ?? null,
    workerVersion: references?.candidate.workerVersion ?? null,
  };
  return { format: planFormat, deployment, artifacts, environment, prior, candidate };
}

export function assertReactivationObservation({ host, current, original, target, candidate, certified }) {
  requireCondition(host.M === 'ready' && host.H === 'ready' &&
    host.transaction?.phase === 'safe-stopped' && host.backend.state === 'absent' &&
    host.database.authState === 'ready' &&
    ['hostId', 'hostPinSha256', 'databaseSha256', 'authSha256'].every(key =>
      current.observation.binding[key] === original[key]) &&
    isDeepStrictEqual(current.target, target) && certified.image === candidate.image &&
    isDeepStrictEqual(certified.identity, candidate.identity),
  'First activation retry no longer matches its ready host, prepared owner, database or certified candidate');
}

// The protected lifecycle caller supplies the approved Preflight envelope and
// artifact references. All mutations share the production queue and host journal.
export async function executePairCutover(operation, input, scratch) {
  requireCondition(['stage', 'advance', 'recover', 'reconcile'].includes(operation), 'Unknown maintenance operation');
  requireCondition(env.CODEXIA_EPOCH_CUTOVER_PAUSED === 'true', 'Ordinary production releases and bootstrap must be paused');
  const origin = new URL(env.CODEXIA_PUBLIC_ORIGIN).origin;
  const inventory = join(env.RUNNER_TEMP, 'codexia-cutover-inventory.yml');
  const edge = createCloudflareCutover({
    ...JSON.parse(env.CODEXIA_CUTOVER_CLOUDFLARE_TARGET), origin,
    accessEnv: env, readToken: env.CODEXIA_CUTOVER_CLOUDFLARE_READ_TOKEN,
    workerToken: env.CODEXIA_CUTOVER_WORKER_TOKEN, fenceToken: env.CODEXIA_CUTOVER_FENCE_TOKEN,
  });
  const host = (action, request) => ansible(scratch, inventory, 'cutover-host.yml',
    { cutover_operation: action, cutover_request: request }, 'cutover_output_file');
  const initialObservation = async (deployment, artifacts) => {
    const preflight = parsePreflightRequest(JSON.stringify({ ...artifacts, intent: deployment.plan.intent,
      window: deployment.plan.window }));
    const [{ host, hostPinSha256 }, releases] = await Promise.all([
      readLifecycleHost({ inventory, targetHost: env.CODEXIA_PREFLIGHT_TARGET_HOST }),
      readLifecycleCandidate(preflight),
    ]);
    const network = await edge.observeLifecycle({ backendExpected: host.backend.state === 'running' });
    const { plan } = planFromObservations({ host, edge: network, hostPinSha256, ...releases,
      intent: preflight.intent, window: preflight.window,
      preservationReceipt: readPreservationEvidence(env.CODEXIA_CUTOVER_PRESERVATION, host) });
    assertDeploymentPlanApproval({ ...deployment, current: plan });
    requireCondition(!network.fence.enabled, 'Unexpected maintenance fence before admission');
    return { host, network, ...releases };
  };

  if (operation === 'stage') {
    const { deployment, artifacts, ingressReviewSha256, priorArchiveSha256 } = input;
    assertPairRoute(deployment?.plan);
    const current = await initialObservation(deployment, artifacts);
    const plan = pairInputs(deployment, artifacts, { ingressReviewSha256, priorArchiveSha256 }, current);
    const changeAxes = deployment.plan.observation.changeAxes;
    requireCondition(deployment.plan.requiresPreservation === changeAxes.includes('backend'),
      'Preservation and installed Backend replacement disagree');
    const stageBackend = changeAxes.includes('backend');
    const stageFrontend = changeAxes.includes('frontend');
    assertDeploymentPlanBinding(deployment);
    const [stagedBackend, stagedFrontend] = await Promise.all([
      stageBackend ? host('stage', hostInput(plan, deployment.planSha256)) : { candidateUnitSha256: plan.prior.unitSha256 },
      stageFrontend ? edge.stage({ previousVersionId: plan.prior.workerVersion,
        artifactDigest: 'sha256:' + plan.candidate.frontendArtifact.artifactDigest }) : { versionId: plan.prior.workerVersion },
    ]);
    plan.candidate.unitSha256 = stagedBackend.candidateUnitSha256;
    plan.candidate.workerVersion = stagedFrontend.versionId;
    return { status: 'staged', plan, planSha256: digestEvidence(plan) };
  }

  const { plan, approval: planSha256, reactivation } = input;
  requireCondition(plan?.format === planFormat && rawHash.test(planSha256 ?? '') && digestEvidence(plan) === planSha256 &&
    plan.environment.origin === origin, 'Maintenance approval does not match the staged plan and origin');
  const { deployment, prior, candidate } = plan;
  assertPairRoute(deployment.plan);
  requireCondition(reactivation === undefined || (reactivation && prior.image === null && operation !== 'recover'),
    'A renewed window is available only for first activation advance or reconciliation');
  const verifyApproval = ({ opening } = {}) => {
    const recovering = operation !== 'advance' && opening !== 'candidate';
    assertDeploymentPlanBinding({ ...deployment, recover: Boolean(reactivation) || recovering });
    return reactivation ? verifyReactivationWindow(reactivation, planSha256, { recovering }) : null;
  };
  const renewal = verifyApproval();
  requireCondition(!reactivation || reactivation.window.id !== deployment.plan.window.id,
    'A renewed activation window must have a distinct ID');
  const request = { ...hostInput(plan, planSha256), reactivationWindow: renewal };
  const verifyIngress = async () => {
    const observation = await edge.observeIngress({ lifecycle: true });
    requireCondition(observation.origin === origin && observation.ingressDigest === plan.environment.ingressDigest &&
      observation.scriptPresent && observation.routesReady, 'Reviewed ingress topology changed');
    requireCondition([prior.workerVersion, candidate.workerVersion].includes(observation.deployment?.versionId ?? null),
      'Active Worker is outside the approved maintenance pair');
    return observation;
  };
  const verifyPair = async outcome => {
    const [network, machine] = await Promise.all([edge.observe({ allowLegacyBackend: plan[outcome].protocol === 'legacy' }),
      ansible(scratch, inventory, 'cutover-observe.yml', {}, 'codexia_cutover_observation_file')]);
    const edgeEvidence = { ...network, frontend: publicFrontendEvidence(network.frontend) };
    if (outcome === 'candidate') {
      assertFrontendOAuthConfigIdentity(network.frontend, env);
      if (prior.workerVersion !== candidate.workerVersion) {
        await edge.assertWorkerArtifact({ versionId: candidate.workerVersion,
          artifactDigest: 'sha256:' + candidate.frontendArtifact.artifactDigest });
      }
    }
    assertPairedObservation({ edge: edgeEvidence, host: machine, pinned: plan[outcome], environment: plan.environment });
    return { edge: edgeEvidence, host: machine };
  };
  return advancePair({ plan, planSha256, request, host, edge, operation, verifyApproval, verifyIngress, verifyPair,
    admitFresh: async () => {
      const current = await initialObservation(deployment, plan.artifacts);
      const refreshed = pairInputs(deployment, plan.artifacts, {
        ingressReviewSha256: plan.environment.ingressReviewSha256, priorArchiveSha256: prior.archiveSha256,
      }, current, plan);
      requireCondition(isDeepStrictEqual(refreshed, plan), 'Staged pair no longer matches fresh certified release and host evidence');
    },
    revalidateActivation: async () => {
      const artifacts = parsePreflightRequest(JSON.stringify({ ...plan.artifacts, intent: deployment.plan.intent,
        window: deployment.plan.window }));
      const [{ host, hostPinSha256 }, releases] = await Promise.all([
        readLifecycleHost({ inventory, targetHost: env.CODEXIA_PREFLIGHT_TARGET_HOST }),
        readLifecycleCandidate(artifacts),
      ]);
      const { plan: refreshed } = planFromObservations({ host, edge: null, hostPinSha256, ...releases,
        intent: artifacts.intent, window: artifacts.window });
      assertReactivationObservation({ host, current: refreshed, original: deployment.plan.observation.binding,
        target: deployment.plan.target, candidate, certified: releases.candidateBackend });
    },
    checkpointProof: checkpoint => {
      if (!deployment.plan.requiresPreservation) return { request: {} };
      const window = reactivation?.window ?? deployment.plan.window;
      const binding = recoveryBinding(plan, planSha256, checkpoint, window);
      if (!env.CODEXIA_CUTOVER_RECOVERY_RECEIPT) return { request: null, binding };
      const receipt = JSON.parse(env.CODEXIA_CUTOVER_RECOVERY_RECEIPT);
      if (checkpoint.reactivationStartedAt &&
          Date.parse(receipt.verifiedAt) < Date.parse(checkpoint.reactivationStartedAt)) {
        return { request: null, binding };
      }
      validateEpochCutoverRecoveryReceipt(receipt, binding, window);
      return { request: { ...binding, recoveryReceiptSha256: digestEvidence(receipt) } };
    },
    restoreProof: checkpoint => prior.image === null ? {} : restoreRequest(planSha256, checkpoint),
    acceptance: env.CODEXIA_CUTOVER_ACCEPTANCE ? JSON.parse(env.CODEXIA_CUTOVER_ACCEPTANCE) : null,
  });
}

async function main() {
  const scratch = await mkdtemp(join(env.RUNNER_TEMP, 'codexia-cutover-'));
  try {
    const evidence = await executePairCutover(env.CODEXIA_CUTOVER_OPERATION, JSON.parse(env.CODEXIA_CUTOVER_INPUT || '{}'), scratch);
    await writeFile(join(env.RUNNER_TEMP, 'codexia-cutover-evidence.json'), JSON.stringify(evidence, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' });
    console.log('Coordinated maintenance checkpoint: ' + evidence.status);
  } catch {
    console.error('Coordinated maintenance stopped. Check the pinned host journal, ingress state and protected evidence before resuming.');
    process.exitCode = 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
