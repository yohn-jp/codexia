import assert from 'node:assert/strict';
import { buildComponentReleaseRecord } from '../../release/components/record-model.mjs';
import { initialFrontendNeedsPublication, assertInitialFrontendReady } from './admission.mjs';

export function initialFrontendRelease(candidate, context) {
  const { identity, runId, producerAttempt, artifactId, artifactDigest } = candidate;
  // The lifecycle artifact verifier certifies a main workflow_run producer.
  // Bind the immutable release to its certified source, not the later dispatch.
  return buildComponentReleaseRecord('frontend', identity.sourceSha, identity, {
    event: 'workflow_run', sourceSha: identity.sourceSha, version: identity.version,
    workflowRunId: runId, workflowAttempt: producerAttempt, artifactId, artifactDigest,
    profile: identity.profile, apiEpoch: identity.apiEpoch,
  }, undefined, context);
}

/** Called only after the protected R5 controller has admitted the exact plan. */
export async function publishInitialFrontend({ edge, observed, candidate, context, assertCurrentSource, recordRelease }) {
  const release = initialFrontendRelease(candidate, context);
  const needsPublication = initialFrontendNeedsPublication(observed, candidate.identity);
  await assertCurrentSource();
  if (needsPublication) {
    const artifactDigest = 'sha256:' + candidate.artifactDigest;
    const staged = await edge.stage({ previousVersionId: observed.deployment?.versionId ?? null, artifactDigest });
    await assertCurrentSource();
    await edge.deployForOwnerEnrollment({ observed, staged, artifactDigest });
  }
  const after = await edge.observeLifecycle({ backendExpected: false, ownerSetup: true });
  assert.equal(after.ingressDigest, observed.ingressDigest, 'Canonical ingress changed during frontend publication');
  assertInitialFrontendReady(after, candidate.identity);
  await assertCurrentSource();
  await recordRelease(release);
  return { deployed: needsPublication, releaseTag: release.tag };
}
