import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { verifyCutoverFrontendArtifact } from '../../verification/artifacts/frontend.mjs';
import { createCloudflareCutover } from '../../release/cutover/cloudflare.mjs';
import { verifyCutoverBackendPublication } from '../handoff/verify-push.mjs';
import { validateEpochCutoverRecoveryReceipt } from '../recovery/epoch-cutover.mjs';
import { assertFunctionalAcceptance, assertMaintenanceApproval, assertPairedObservation, digestEvidence } from './coordinator.mjs';

const env = process.env;
const run = promisify(execFile);
const rawHash = /^[a-f0-9]{64}$/u;
const origin = env.CODEXIA_PUBLIC_ORIGIN && new URL(env.CODEXIA_PUBLIC_ORIGIN).origin;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function ansible(scratch, playbook, vars, outputKey) {
  const output = await mkdtemp(join(scratch, 'phase-'));
  const outFile = join(output, 'result.json');
  const varsFile = join(output, 'vars.json');
  await writeFile(varsFile, JSON.stringify({ ...vars, [outputKey]: outFile }), { mode: 0o600, flag: 'wx' });
  try {
    await run('ansible-playbook', ['-i', join(env.RUNNER_TEMP, 'codexia-cutover-inventory.yml'),
      'deploy/ansible/' + playbook, '--extra-vars', '@' + varsFile], { timeout: 20 * 60_000 });
    return JSON.parse(await readFile(outFile, 'utf8'));
  } catch {
    throw new Error('Pinned Ansible target did not complete ' + (vars.cutover_operation || 'read-only observation'));
  }
}

function hostInput(plan, approval) {
  return {
    planSha256: approval, notAfter: plan.window?.notAfter, sourceHostId: plan.environment.hostId,
    databaseSystemIdentifier: plan.environment.clusterId,
    priorImage: plan.prior.image, priorIdentity: plan.prior.identity,
    priorUnitSha256: plan.prior.unitSha256, priorContainerId: plan.prior.containerId,
    priorSettingsSha256: plan.prior.settingsSha256,
    candidateImage: plan.candidate.image, candidateIdentity: plan.candidate.identity,
    candidateUnitSha256: plan.candidate.unitSha256, settingsSha256: plan.prior.settingsSha256,
  };
}

function recoveryBinding(plan, checkpoint) {
  const { checksumManifestSha256, databaseFingerprint, historyFingerprint } = checkpoint;
  requireCondition([checksumManifestSha256, databaseFingerprint, historyFingerprint].every(value => rawHash.test(value ?? '')),
    'Fresh host checkpoint did not report verified backup fingerprints');
  return {
    environment: 'codexia-production', hostname: new URL(plan.environment.origin).hostname, sourceHostId: plan.environment.hostId,
    databaseSystemIdentifier: plan.environment.clusterId, maintenanceWindowId: plan.window.id,
    priorImage: plan.prior.image, candidateImage: plan.candidate.image,
    priorMigrationFingerprint: plan.prior.identity.migrationFingerprint,
    candidateMigrationFingerprint: plan.candidate.identity.migrationFingerprint,
    checksumManifestSha256, databaseFingerprint, historyFingerprint,
  };
}

const diagnostic = new Set();
function step(label) {
  diagnostic.add(label);
}

async function execute(operation, input, scratch) {
  const edge = createCloudflareCutover({
    origin, ...JSON.parse(env.CODEXIA_CUTOVER_CLOUDFLARE_TARGET),
    accessEnv: env, readToken: env.CODEXIA_CUTOVER_CLOUDFLARE_READ_TOKEN,
    workerToken: env.CODEXIA_CUTOVER_WORKER_TOKEN, fenceToken: env.CODEXIA_CUTOVER_FENCE_TOKEN,
  });
  const observeHost = () => ansible(scratch, 'cutover-observe.yml', {}, 'codexia_cutover_observation_file');
  const host = (action, request) => ansible(scratch, 'cutover-host.yml', {
    cutover_operation: action, cutover_request: request,
  }, 'cutover_output_file');
  const observePair = async () => {
    const [network, machine] = await Promise.all([edge.observe(), observeHost()]);
    return { edge: network, host: machine };
  };

  if (operation === 'preflight' || operation === 'stage') {
    step('observe protected public and rootless host identities and topology');
    const observed = await observePair();
    const environment = {
      origin, ingressDigest: observed.edge.ingressDigest, hostId: observed.host.hostId,
      clusterId: observed.host.database.clusterId, ownerBindingSha256: observed.host.writer.ownerBindingSha256,
    };
    const prior = {
      image: observed.host.writer.image, identity: observed.host.writer.identity, frontend: observed.edge.frontend,
      workerVersion: observed.edge.deployment.versionId, containerId: observed.host.writer.containerId,
      unitSha256: observed.host.writer.quadletSha256?.replace(/^sha256:/u, ''),
      settingsSha256: observed.host.writer.settingsSha256?.replace(/^sha256:/u, ''),
    };
    const assertBaseline = () => {
      assertPairedObservation({ ...observed, pinned: prior, environment });
      requireCondition(prior.identity.apiEpoch === 1 && prior.identity.persistenceFormat === 1 && !observed.edge.fence.enabled,
        'A verified, unfenced Full epoch 1 baseline is required');
    };
    const verifyPriorPublication = async () => {
      step('verify the installed Full image publication certificate');
      const publication = await verifyCutoverBackendPublication(input.priorBackendPublisherRunId);
      requireCondition(publication.fullCertificate.image === prior.image &&
        isDeepStrictEqual(publication.fullCertificate.identity, prior.identity),
      'Installed Full release differs from its authenticated publication certificate');
      return { backendPublisherRunId: publication.publisherRunId, backendCertificateSha256: digestEvidence(publication.fullCertificate) };
    };
    if (operation === 'preflight') {
      try {
        assertBaseline();
        return { operation, ready: true, ...observed, environment, priorPublication: await verifyPriorPublication() };
      } catch {
        return { operation, ready: false, ...observed, environment, rejectedDuring: [...diagnostic].at(-1) };
      }
    }
    assertBaseline();
    requireCondition(rawHash.test(input.priorArchiveSha256 ?? ''), 'Retained prior frontend archive digest is required');
    prior.archiveSha256 = input.priorArchiveSha256;
    requireCondition(rawHash.test(input.ingressReviewSha256 ?? ''), 'Independent review of alternate ingress is required');
    environment.ingressReviewSha256 = input.ingressReviewSha256;
    requireCondition(typeof input.window?.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(input.window.id) &&
      ['notBefore', 'notAfter'].every(key => new Date(input.window[key]).toISOString() === input.window[key]) &&
      Date.parse(input.window.notAfter) > Math.max(Date.now(), Date.parse(input.window.notBefore)), 'Invalid approved window');

    Object.assign(prior, await verifyPriorPublication());
    step('verify certified Full image and exact frontend archive');
    const [backend, frontend] = await Promise.all([
      verifyCutoverBackendPublication(input.backendPublisherRunId), verifyCutoverFrontendArtifact(input.frontend),
    ]);
    const { identity, image } = backend.fullCertificate;
    requireCondition(identity.profile === 'full' && identity.apiEpoch === 2 && identity.persistenceFormat === 2 &&
      identity.migrationFingerprint === prior.identity.migrationFingerprint,
    'Candidate has an unsupported API epoch, persistence format or database migration ledger change');
    const candidate = { image, identity, frontend: frontend.identity, frontendArtifact: frontend,
      backendPublisherRunId: backend.publisherRunId, backendCertificateSha256: digestEvidence(backend.fullCertificate) };

    step('stage backend on the host and upload the static Worker at zero percent');
    const [stagedHost, stagedWorker] = await Promise.all([
      host('stage', hostInput({ environment, prior, candidate })),
      edge.stage({ previousVersionId: prior.workerVersion, artifactDigest: 'sha256:' + frontend.artifactDigest }),
    ]);
    candidate.unitSha256 = stagedHost.candidateUnitSha256;
    candidate.workerVersion = stagedWorker.versionId;
    const plan = { format: 'codexia-epoch-cutover-plan/v1', observedAt: observed.edge.observedAt,
      environment, prior, candidate, window: input.window };
    const planSha256 = digestEvidence(plan);
    assertMaintenanceApproval(plan, planSha256, { now: new Date(plan.window.notBefore) });
    return { operation, planSha256, plan };
  }

  const { plan, approval } = input;
  if (operation === 'finish') {
    requireCondition(['candidate', 'prior'].includes(input.outcome), 'Explicit release outcome is required');
  }
  const outcome = input.outcome;
  const recovering = operation === 'abort-fence' || operation.startsWith('recover') || (operation === 'finish' && outcome === 'prior');
  const verifyApproval = () => assertMaintenanceApproval(plan, approval, { recovery: recovering });
  verifyApproval();
  requireCondition(env.CODEXIA_EPOCH_CUTOVER_PAUSED === 'true', 'Both ordinary production releases must be paused');
  const request = hostInput(plan, approval);
  const verifyIngress = async () => {
    const observation = await edge.observeIngress();
    requireCondition(observation.origin === plan.environment.origin &&
      observation.ingressDigest === plan.environment.ingressDigest, 'Reviewed ingress topology changed');
    requireCondition([plan.prior.workerVersion, plan.candidate.workerVersion].includes(observation.deployment.versionId),
      'Active Worker is outside the approved maintenance pair');
    return observation;
  };

  step('observe the pinned ingress and selected Worker');
  const ingress = await verifyIngress();
  if (operation === 'checkpoint') {
    requireCondition(ingress.deployment.versionId === plan.prior.workerVersion, 'Prior Worker must remain at 100 percent');
    await edge.assertStaged({ versionId: plan.candidate.workerVersion,
      artifactDigest: 'sha256:' + plan.candidate.frontendArtifact.artifactDigest });
    if (!ingress.fence.enabled) {
      const pair = await observePair();
      assertPairedObservation({ ...pair, pinned: plan.prior, environment: plan.environment });
      step('install the hostname fence');
      verifyApproval();
      await edge.fence();
    }
    step('verify closed public ingress and checkpoint the stopped writer');
    await edge.verifyFenced();
    verifyApproval();
    const checkpoint = await host('checkpoint', request);
    return { operation, checkpoint, binding: recoveryBinding(plan, checkpoint) };
  }

  if (operation === 'abort-fence') {
    step('reconcile a fence created before any durable host change');
    const journal = await host('observe', request);
    requireCondition((journal.phase === null || journal.phase === 'finished') &&
      journal.planSha256 !== approval && journal.priorContainerId === plan.prior.containerId &&
      journal.priorUnitSha256 === plan.prior.unitSha256, 'The approved cutover must be recovered from its host journal');
    if (ingress.fence.enabled) await edge.verifyFenced();
    const pair = await observePair();
    assertPairedObservation({ ...pair, pinned: plan.prior, environment: plan.environment });
    const acceptance = JSON.parse(env.CODEXIA_CUTOVER_ACCEPTANCE);
    assertFunctionalAcceptance(acceptance, { planSha256: approval, outcome: 'prior', origin, image: plan.prior.image,
      workerVersion: plan.prior.workerVersion }, { since: plan.window.notBefore });
    try {
      verifyApproval();
      if (ingress.fence.enabled) await edge.unfence();
      await edge.verifyUnfenced();
      assertPairedObservation({ ...await observePair(), pinned: plan.prior, environment: plan.environment });
    } catch {
      await edge.fence();
      await edge.verifyFenced();
      throw new Error('Prior ingress verification failed');
    }
    return { operation, planSha256: approval, workerVersion: plan.prior.workerVersion,
      backendImage: plan.prior.image, acceptanceSha256: digestEvidence(acceptance) };
  }

  if (operation === 'finish' && !ingress.fence.enabled) {
    // The protected job may have disconnected after reopening and before committing the host journal.
    step('confirm the prior reopen and finish the durable host transaction');
  } else {
    step('prove public ingress remains fenced before any host or Worker change');
    requireCondition(ingress.fence.enabled, 'The reviewed public fence must already be enabled');
    await edge.verifyFenced();
  }

  if (operation === 'apply') {
    step('admit the independent restore proof and convert the stopped writer');
    const checkpoint = await host('observe', request);
    requireCondition(checkpoint.planSha256 === approval, 'Host checkpoint does not match the approved plan');
    const binding = recoveryBinding(plan, checkpoint);
    const receipt = JSON.parse(env.CODEXIA_CUTOVER_RECOVERY_RECEIPT);
    validateEpochCutoverRecoveryReceipt(receipt, binding, plan.window);
    verifyApproval();
    return { operation, host: await host('apply', { ...request, ...binding, recoveryReceiptSha256: digestEvidence(receipt) }) };
  }

  if (operation === 'promote' || operation === 'recover') {
    const target = operation === 'promote' ? 'candidate' : 'prior';
    if (target === 'prior') {
      step('prove the old data and secrets are recoverable before restarting the old writer');
      const stopped = await host('observe', request);
      requireCondition(stopped.planSha256 === approval, 'Host recovery does not match the approved plan');
      if (stopped.requiresRestore) {
        const restore = JSON.parse(env.CODEXIA_CUTOVER_RESTORE_RECEIPT);
        const fields = ['checksumManifestSha256', 'databaseFingerprint', 'historyFingerprint'];
        requireCondition(restore?.format === 'codexia-cutover-restoration/v1' &&
          restore.planSha256 === approval && fields.every(key => rawHash.test(restore[key] ?? '') && restore[key] === stopped[key]) &&
          rawHash.test(restore.procedureEvidenceSha256 ?? ''), 'Recovery needs exact protected restoration evidence');
        const restored = Date.parse(restore.verifiedAt);
        requireCondition(restored >= Date.parse(stopped.recoveryStartedAt ?? stopped.phaseChangedAt) &&
          restored <= Date.now(), 'Restoration evidence is stale or in the future');
        await host('recover', { ...request, ...Object.fromEntries(fields.map(key => [key, restore[key]])),
          restoreReceiptSha256: digestEvidence(restore) });
      } else {
        await host('recover', request);
      }
    }
    step('open only the canonical Tunnel behind the fence and select the paired Worker');
    verifyApproval();
    const state = await host('open-tunnel', { ...request, outcome: target });
    if (target === 'candidate' && ingress.deployment.versionId !== plan.candidate.workerVersion) {
      await edge.assertStaged({ versionId: plan.candidate.workerVersion,
        artifactDigest: 'sha256:' + plan.candidate.frontendArtifact.artifactDigest });
    }
    verifyApproval();
    const deployment = await edge.deploy({ fromVersionId: plan[target === 'candidate' ? 'prior' : 'candidate'].workerVersion,
      toVersionId: plan[target].workerVersion });
    const pair = await observePair();
    assertPairedObservation({ ...pair, pinned: plan[target], environment: plan.environment });
    return { operation, phaseChangedAt: state.phaseChangedAt, deployment, ...pair };
  }

  if (operation === 'recover-quiesce') {
    step('stop the writer and Tunnel for an independently approved restore');
    const state = await host('recover-quiesce', request);
    await edge.deploy({ fromVersionId: plan.candidate.workerVersion, toVersionId: plan.prior.workerVersion });
    return { operation, host: state };
  }

  if (operation === 'finish') {
    step('bind functional acceptance to the fresh paired deployment');
    const journal = await host('observe', request);
    requireCondition(journal.planSha256 === approval && (journal.phase === outcome + '-tunnel' ||
      (journal.phase === 'finished' && journal.outcome === outcome)),
      'The approved pair has not been activated behind the fence');
    const pinned = plan[outcome];
    const observation = await observePair();
    assertPairedObservation({ ...observation, pinned, environment: plan.environment });
    const acceptance = JSON.parse(env.CODEXIA_CUTOVER_ACCEPTANCE);
    const since = new Date(Math.max(Date.parse(journal.phaseChangedAt),
      Date.parse(observation.edge.deployment.createdAt))).toISOString();
    assertFunctionalAcceptance(acceptance, { planSha256: approval, outcome, origin, image: pinned.image,
      workerVersion: pinned.workerVersion }, { since });
    try {
      verifyApproval();
      if (ingress.fence.enabled) await edge.unfence();
      await edge.verifyUnfenced();
      const after = await observePair();
      assertPairedObservation({ ...after, pinned, environment: plan.environment });
      step('commit the verified release pair on the host');
      return { operation, outcome, host: await host('finish', { ...request, outcome }), planSha256: approval,
        workerVersion: pinned.workerVersion, backendImage: pinned.image, acceptanceSha256: digestEvidence(acceptance) };
    } catch {
      await edge.fence();
      await edge.verifyFenced();
      throw new Error('Post-release ingress checks failed');
    }
  }

  throw new Error('Unknown maintenance operation');
}

const operation = env.CODEXIA_CUTOVER_OPERATION;
const scratch = await mkdtemp(join(env.RUNNER_TEMP, 'codexia-cutover-'));
try {
  const input = JSON.parse(env.CODEXIA_CUTOVER_INPUT || '{}');
  const evidence = await execute(operation, input, scratch);
  await writeFile(join(env.RUNNER_TEMP, 'codexia-cutover-evidence.json'), JSON.stringify(evidence, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' });
  console.log('Coordinated epoch maintenance reported evidence for ' + operation);
  if (operation === 'preflight' && !evidence.ready) process.exitCode = 1;
} catch {
  const phase = [...diagnostic].at(-1);
  console.error('Coordinated epoch maintenance stopped during ' + (phase || 'protected input validation'));
  process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
