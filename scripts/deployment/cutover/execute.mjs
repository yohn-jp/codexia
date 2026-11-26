import { isDeepStrictEqual } from 'node:util';
import { assertFunctionalAcceptance, digestEvidence } from './coordinator.mjs';

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function id(ingress) {
  return ingress.deployment?.versionId ?? null;
}

export function verifyReactivationWindow(reactivation, planSha256, { now = new Date(), recovering = false } = {}) {
  const { window, approval } = reactivation;
  const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
  requireCondition(window && Object.keys(window).length === 3 &&
    typeof window.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(window.id) &&
    time(window.notBefore) && time(window.notAfter) && window.notBefore < window.notAfter &&
    approval === digestEvidence({ planSha256, window }), 'Invalid approval for the first activation window');
  requireCondition(Date.parse(window.notBefore) <= now.getTime() &&
    (recovering || now.getTime() <= Date.parse(window.notAfter)), 'Outside approved first activation window');
  return { notAfter: window.notAfter, approval };
}

export async function advancePair({
  plan, planSha256, request, host, edge, verifyApproval, verifyIngress, verifyPair,
  admitFresh, revalidateActivation, checkpointProof, restoreProof, acceptance, operation,
}) {
  let ingress = await verifyIngress();
  let journal = await host('observe', request);
  const { prior, candidate } = plan;
  const candidateWorkerProof = {
    versionId: candidate.workerVersion,
    artifactDigest: 'sha256:' + candidate.frontendArtifact.artifactDigest,
    ...(candidate.initialControls ? { initialControls: candidate.initialControls } : {}),
  };
  const matchesJournal = () => journal.planSha256 === planSha256;
  const firstActivationWithoutWorker = prior.image === null && prior.workerVersion === null;
  const retainedBackendFirstFrontend = prior.image !== null && prior.image === candidate.image && prior.workerVersion === null;
  const recordedWindow = matchesJournal() ? journal.reactivationWindow ?? null : null;
  const renewRetainedWindow = operation === 'advance' && retainedBackendFirstFrontend && matchesJournal() &&
    journal.phase === 'checkpointed' && typeof journal.retainedCandidateWorker === 'boolean' &&
    request.reactivationWindow != null && !isDeepStrictEqual(request.reactivationWindow, recordedWindow);
  if (operation !== 'recover' && !(matchesJournal() && journal.phase === 'safe-stopped') && !renewRetainedWindow) {
    requireCondition(isDeepStrictEqual(request.reactivationWindow ?? null, recordedWindow),
      'Reactivation approval does not match the durable checkpoint');
  }
  const candidateWorkerRetained = () => (firstActivationWithoutWorker || retainedBackendFirstFrontend) &&
    journal.retainedCandidateWorker === true && id(ingress) === candidate.workerVersion;
  const observeCheckpoint = async () => {
    journal = await host('observe', request);
    requireCondition(matchesJournal(), 'Host checkpoint no longer belongs to the approved plan');
  };
  const mutateHost = (action, data = {}) => {
    verifyApproval();
    return host(action, { ...request, ...data });
  };
  const verifyFence = async () => {
    ingress = await verifyIngress();
    requireCondition(ingress.fence.enabled, 'Maintenance fence is not active');
    await edge.verifyFenced();
    if (retainedBackendFirstFrontend && journal.retainedCandidateWorker === true) {
      requireCondition(candidateWorkerRetained(), 'Retained candidate Worker drifted');
    }
  };
  const ensureFence = async () => {
    ingress = await verifyIngress();
    if (!ingress.fence.enabled) {
      verifyApproval();
      await edge.fence();
    }
    await verifyFence();
  };
  const proveStagedWorker = async () => {
    if (prior.workerVersion === candidate.workerVersion) return;
    if (id(ingress) !== candidate.workerVersion) await edge.assertStaged(candidateWorkerProof);
    else if (candidateWorkerRetained()) await edge.assertWorkerArtifact(candidateWorkerProof);
  };
  const verifyRetainedBackend = () => {
    requireCondition(journal.apiRunning === true && journal.apiVerified !== false && journal.tunnelRunning === true &&
      journal.priorImage === prior.image && journal.priorUnitSha256 === prior.unitSha256 &&
      journal.priorContainerId === prior.containerId && isDeepStrictEqual(journal.priorIdentity, prior.identity),
    'Retained Backend drifted from the approved cutover plan');
  };
  const verifyRetryWorker = async workerVersion => {
    if (workerVersion === null) await edge.assertStaged(candidateWorkerProof);
    else await edge.assertWorkerArtifact(candidateWorkerProof);
    await verifyFence();
    requireCondition(id(ingress) === workerVersion, 'Worker drifted while checking the Frontend retry');
  };
  const promote = async outcome => {
    await verifyFence();
    const wanted = plan[outcome].workerVersion;
    const previous = plan[outcome === 'prior' ? 'candidate' : 'prior'].workerVersion;
    requireCondition(wanted !== null, 'A verified Worker is required to reopen the paired Tunnel');
    if (outcome === 'candidate') {
      requireCondition(journal.phase === 'candidate-tunnel' || id(ingress) === previous || candidateWorkerRetained(),
        'Worker drifted before the Tunnel checkpoint');
      await proveStagedWorker();
    }
    await mutateHost('open-tunnel', { outcome });
    await verifyFence();
    if (id(ingress) !== wanted) {
      verifyApproval();
      await edge.deploy({ fromVersionId: previous, toVersionId: wanted });
    }
    await verifyPair(outcome);
  };
  const publish = async outcome => {
    const pinned = plan[outcome];
    const observation = await verifyPair(outcome);
    const retried = journal.reactivationStartedAt ||
      (retainedBackendFirstFrontend && typeof journal.retainedCandidateWorker === 'boolean');
    const staleRetryAcceptance = retried && acceptance &&
      Date.parse(acceptance.verifiedAt) < Date.parse(journal.tunnelOpenedAt ?? journal.phaseChangedAt);
    if (!acceptance || staleRetryAcceptance) {
      ingress = await verifyIngress();
      if (retainedBackendFirstFrontend && journal.phase === 'candidate-tunnel') {
        requireCondition(ingress.fence.enabled, 'Maintenance fence is not active during functional acceptance');
      }
      if (journal.phase === 'finished' && !ingress.fence.enabled) {
        await edge.verifyUnfenced();
        return { status: 'finished', outcome, planSha256, observation };
      }
      return { status: 'awaiting-functional-acceptance', outcome, planSha256, observation };
    }
    const since = new Date(Math.max(Date.parse(journal.tunnelOpenedAt ?? journal.phaseChangedAt),
      Date.parse(observation.edge.deployment.createdAt))).toISOString();
    assertFunctionalAcceptance(acceptance, { planSha256, outcome, origin: plan.environment.origin,
      image: pinned.image, workerVersion: pinned.workerVersion }, { since });
    if (journal.phase !== 'finished' && journal.phase !== outcome + '-publishing') {
      await verifyFence();
      await mutateHost('publishing', { outcome });
    }
    try {
      ingress = await verifyIngress();
      verifyApproval();
      if (ingress.fence.enabled) {
        verifyApproval({ opening: outcome });
        await edge.unfence();
      }
      await edge.verifyUnfenced();
      await verifyPair(outcome);
      const result = await mutateHost('finish', { outcome });
      return { ...result, outcome, planSha256, acceptanceSha256: digestEvidence(acceptance),
        workerVersion: pinned.workerVersion, backendImage: pinned.image };
    } catch (error) {
      await edge.fence();
      await edge.verifyFenced();
      throw error;
    }
  };

  if (!matchesJournal()) {
    requireCondition(operation === 'advance' && !ingress.fence.enabled &&
      (journal.phase === null || journal.phase === 'finished'), 'A conflicting or unbound maintenance transaction exists');
    requireCondition(id(ingress) === prior.workerVersion, 'Prior Worker drifted before admission');
    await proveStagedWorker();
    await admitFresh();
    await mutateHost('admit');
    await observeCheckpoint();
    requireCondition(journal.phase === 'intent', 'Host did not persist the approved cutover intent');
  }

  if (journal.phase === 'finished' || journal.phase?.endsWith('-publishing')) {
    requireCondition(operation !== 'recover', 'Publication may admit writes; destructive rollback is blocked');
    const outcome = journal.outcome ?? journal.phase.replace(/-publishing$/u, '');
    return publish(outcome);
  }
  requireCondition(operation !== 'reconcile', 'No recorded publication is available for reconciliation');

  if (operation === 'recover' && retainedBackendFirstFrontend) {
    requireCondition(['intent', 'checkpointed', 'candidate-ready', 'candidate-tunnel', 'recovering', 'prior-ready'].includes(journal.phase),
      'No retained Backend checkpoint is available for Frontend recovery');
    verifyRetainedBackend();
    if (journal.phase === 'intent') await ensureFence();
    else await verifyFence();
    const workerVersion = id(ingress);
    // A Tunnel checkpoint may precede a completed Worker deployment. Older
    // recovery journals no longer carry that forward checkpoint.
    const mayHaveDeployed = ['candidate-tunnel', 'recovering', 'prior-ready'].includes(journal.phase);
    requireCondition(workerVersion === null || (workerVersion === candidate.workerVersion &&
      (mayHaveDeployed || candidateWorkerRetained())), 'Worker drifted before Frontend recovery');
    await verifyRetryWorker(workerVersion);
    const retainedCandidateWorker = workerVersion !== null;
    await mutateHost('recover', { frontendRetry: true, retainedCandidateWorker });
    await observeCheckpoint();
    requireCondition(journal.phase === 'checkpointed' && journal.retainedCandidateWorker === retainedCandidateWorker,
      'Host did not persist the Frontend retry checkpoint');
    verifyRetainedBackend();
    await verifyFence();
    requireCondition(id(ingress) === workerVersion, 'Worker drifted after the Frontend retry checkpoint');
    return { status: journal.phase, nextOperation: 'advance', planSha256 };
  }

  if (operation === 'recover') {
    await ensureFence();
    const priorResumed = ['prior-ready', 'prior-tunnel'].includes(journal.phase) &&
      journal.apiRunning !== false && journal.apiVerified !== false;
    if (priorResumed && journal.apiRunning === true) {
      requireCondition(journal.priorImage === prior.image && journal.priorUnitSha256 === prior.unitSha256 &&
        isDeepStrictEqual(journal.priorIdentity, prior.identity), 'Restored prior API identity drifted');
    }
    if (journal.phase === 'safe-stopped') {
      requireCondition(prior.image === null, 'Only first activation can use the safe-stopped checkpoint');
      await mutateHost('recover');
      await observeCheckpoint();
    } else if (!priorResumed) {
      // The journal records recovery intent before stopping the services.
      // A lost response in that interval must never authorize a live restore.
      await mutateHost('recover-quiesce');
      await observeCheckpoint();
      const proof = await restoreProof(journal);
      if (proof === null) return { status: 'awaiting-restoration', journal };
      await mutateHost('recover', proof);
      await observeCheckpoint();
    }
    if (journal.phase === 'safe-stopped') {
      if (prior.workerVersion !== null && prior.workerVersion !== candidate.workerVersion) {
        await verifyFence();
        if (id(ingress) === candidate.workerVersion) {
          verifyApproval();
          await edge.deploy({ fromVersionId: candidate.workerVersion, toVersionId: prior.workerVersion });
        }
      }
      return { status: 'safe-stopped' };
    }
    if (prior.workerVersion === null || prior.image === null) {
      return { status: 'safe-stopped', reason: 'prior-pair-absent' };
    }
    await promote('prior');
    await observeCheckpoint();
    return publish('prior');
  }

  if (journal.phase === 'safe-stopped') {
    requireCondition(prior.image === null, 'Only a stopped first activation can restart from this checkpoint');
    await verifyFence();
    requireCondition(id(ingress) === prior.workerVersion ||
      (firstActivationWithoutWorker && id(ingress) === candidate.workerVersion),
    'Worker drifted before first activation retry');
    const retainedCandidateWorker = id(ingress) === candidate.workerVersion;
    if (retainedCandidateWorker) {
      await edge.assertWorkerArtifact(candidateWorkerProof);
    } else {
      await proveStagedWorker();
    }
    verifyApproval();
    await revalidateActivation();
    await verifyFence();
    requireCondition(id(ingress) === (retainedCandidateWorker ? candidate.workerVersion : prior.workerVersion),
      'Worker changed during first activation retry admission');
    await mutateHost('checkpoint', { retainedCandidateWorker });
    await observeCheckpoint();
  } else if (['intent', 'quiescing'].includes(journal.phase)) {
    requireCondition(id(ingress) === prior.workerVersion, 'Prior Worker drifted before checkpoint');
    await proveStagedWorker();
    if (journal.phase === 'intent') await ensureFence();
    else await verifyFence();
    await mutateHost('checkpoint');
    await observeCheckpoint();
  } else {
    await verifyFence();
  }
  if (journal.phase === 'checkpointed') {
    await verifyFence();
    requireCondition(id(ingress) === prior.workerVersion || candidateWorkerRetained(),
      'Worker drifted at the host checkpoint');
    if (retainedBackendFirstFrontend && typeof journal.retainedCandidateWorker === 'boolean') {
      verifyRetainedBackend();
      await verifyRetryWorker(id(ingress));
      if (renewRetainedWindow) {
        await mutateHost('checkpoint');
        await observeCheckpoint();
        requireCondition(journal.phase === 'checkpointed' &&
          isDeepStrictEqual(journal.reactivationWindow, request.reactivationWindow),
        'Host did not persist the renewed Frontend retry window');
        verifyRetainedBackend();
        await verifyFence();
      }
    } else {
      await proveStagedWorker();
    }
    const proof = await checkpointProof(journal);
    if (proof.request === null) return { status: 'awaiting-independent-recovery-proof', binding: proof.binding, checkpoint: journal };
    await mutateHost('apply', proof.request);
    await observeCheckpoint();
  }
  requireCondition(['candidate-ready', 'candidate-tunnel'].includes(journal.phase),
    'Unknown or interrupted checkpoint requires protected recovery');
  await promote('candidate');
  await observeCheckpoint();
  return publish('candidate');
}
