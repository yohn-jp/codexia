import { assertFunctionalAcceptance, digestEvidence } from './coordinator.mjs';

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function id(ingress) {
  return ingress.deployment?.versionId ?? null;
}

export async function advancePair({
  plan, planSha256, request, host, edge, verifyApproval, verifyIngress, verifyPair,
  admitFresh, checkpointProof, restoreProof, acceptance, operation,
}) {
  let ingress = await verifyIngress();
  let journal = await host('observe', request);
  const { prior, candidate } = plan;
  const matchesJournal = () => journal.planSha256 === planSha256;
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
    if (prior.workerVersion !== candidate.workerVersion && id(ingress) !== candidate.workerVersion) {
      await edge.assertStaged({ versionId: candidate.workerVersion,
        artifactDigest: 'sha256:' + candidate.frontendArtifact.artifactDigest });
    }
  };
  const promote = async outcome => {
    await verifyFence();
    const wanted = plan[outcome].workerVersion;
    const previous = plan[outcome === 'prior' ? 'candidate' : 'prior'].workerVersion;
    requireCondition(wanted !== null, 'A verified Worker is required to reopen the paired Tunnel');
    if (outcome === 'candidate') await proveStagedWorker();
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
    if (!acceptance) {
      const status = journal.phase === 'finished' ? 'finished' : 'awaiting-functional-acceptance';
      return { status, outcome, planSha256, observation };
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
      if (ingress.fence.enabled) await edge.unfence();
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

  if (operation === 'recover') {
    if (journal.phase === 'safe-stopped') return { status: 'safe-stopped' };
    await ensureFence();
    if (!['prior-ready', 'prior-tunnel'].includes(journal.phase)) {
      if (journal.phase !== 'recovering') await mutateHost('recover-quiesce');
      await observeCheckpoint();
      const proof = await restoreProof(journal);
      if (proof === null) return { status: 'awaiting-restoration', journal };
      const recovered = await mutateHost('recover', proof);
      if (recovered.status === 'safe-stopped') {
        await observeCheckpoint();
        if (prior.workerVersion !== null && prior.workerVersion !== candidate.workerVersion) {
          await verifyFence();
          if (id(ingress) === candidate.workerVersion) {
            verifyApproval();
            await edge.deploy({ fromVersionId: candidate.workerVersion, toVersionId: prior.workerVersion });
          }
        }
        return recovered;
      }
    }
    if (prior.workerVersion === null || prior.image === null) {
      return { status: 'safe-stopped', reason: 'prior-pair-absent' };
    }
    await promote('prior');
    await observeCheckpoint();
    return publish('prior');
  }

  if (['intent', 'quiescing'].includes(journal.phase)) {
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
