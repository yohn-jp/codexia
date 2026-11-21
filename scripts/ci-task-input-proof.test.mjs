import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCompleteTaskInputProofSet, selectEquivalentTaskProofs } from './ci-task-input-proof.mjs';

const sourceSha = 'a'.repeat(40);
const planDigest = 'b'.repeat(64);
const dimensions = ['source', 'tests', 'dependencies', 'environment', 'toolchain', 'recipe', 'producers'];

function proof(task, overrides = {}) {
  return {
    task,
    status: 'passed',
    sourceSha,
    planDigest,
    workflowRunId: 42,
    workflowAttempt: 1,
    jobId: 84,
    inputClosure: Object.fromEntries(dimensions.map(name => [name, name.charCodeAt(0).toString(16).padStart(64, '0')])),
    ...overrides,
  };
}

test('complete task proofs require every declared input dimension and exact run identity', () => {
  const proofs = [proof('unit-contracts'), proof('build-core')];
  assert.doesNotThrow(() => assertCompleteTaskInputProofSet({
    tasks: ['unit-contracts', 'build-core'], proofs, sourceSha, planDigest,
    workflowRunId: 42, workflowAttempt: 1,
  }));
  const incomplete = proof('unit-contracts', { inputClosure: { source: '0'.repeat(64) } });
  assert.throws(() => assertCompleteTaskInputProofSet({
    tasks: ['unit-contracts'], proofs: [incomplete], sourceSha, planDigest,
    workflowRunId: 42, workflowAttempt: 1,
  }), /input closure/);
  assert.throws(() => assertCompleteTaskInputProofSet({
    tasks: ['unit-contracts'], proofs: [proof('unit-contracts', { workflowAttempt: 2 })], sourceSha, planDigest,
    workflowRunId: 42, workflowAttempt: 1,
  }), /attempt/);
});

test('task proof selection fails closed on missing, duplicate, stale, or changed evidence', () => {
  const baseline = [proof('unit-contracts'), proof('build-core')];
  const candidate = [proof('unit-contracts'), proof('build-core')];
  assert.deepEqual(selectEquivalentTaskProofs({
    tasks: ['unit-contracts', 'build-core'], baseline, candidate,
    baselineIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
    candidateIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
  }), ['unit-contracts', 'build-core']);
  assert.throws(() => selectEquivalentTaskProofs({
    tasks: ['unit-contracts', 'build-core'], baseline, candidate: candidate.slice(0, 1),
    baselineIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
    candidateIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
  }), /task proof inventory/);
  assert.throws(() => selectEquivalentTaskProofs({
    tasks: ['unit-contracts', 'build-core'], baseline: [...baseline, baseline[0]], candidate,
    baselineIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
    candidateIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
  }), /task proof inventory/);
  assert.throws(() => selectEquivalentTaskProofs({
    tasks: ['unit-contracts', 'build-core'], baseline, candidate: [proof('unit-contracts'), proof('build-core', { sourceSha: 'c'.repeat(40) })],
    baselineIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
    candidateIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
  }), /source mismatch/);
  const changed = [proof('unit-contracts'), proof('build-core', { inputClosure: {
    ...proof('build-core').inputClosure, environment: 'f'.repeat(64),
  } })];
  assert.deepEqual(selectEquivalentTaskProofs({
    tasks: ['unit-contracts', 'build-core'], baseline, candidate: changed,
    baselineIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
    candidateIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
  }), ['unit-contracts']);
});
