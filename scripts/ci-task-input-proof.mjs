import assert from 'node:assert/strict';
import { VERIFICATION_TASKS } from './ci-contract.mjs';

export const TASK_INPUT_DIMENSIONS = Object.freeze([
  'source', 'tests', 'dependencies', 'environment', 'toolchain', 'recipe', 'producers',
]);

const sha256Pattern = /^[a-f0-9]{64}$/u;
const sourceShaPattern = /^[a-f0-9]{40}$/u;
const positive = value => Number.isSafeInteger(value) && value > 0;

function assertIdentity(identity, label) {
  assert.ok(identity && typeof identity === 'object', `Missing ${label} identity`);
  assert.match(identity.sourceSha, sourceShaPattern, `Invalid ${label} source`);
  assert.match(identity.planDigest, sha256Pattern, `Invalid ${label} plan digest`);
  assert.ok(positive(identity.workflowRunId), `Invalid ${label} workflow run`);
  assert.ok(positive(identity.workflowAttempt), `Invalid ${label} workflow attempt`);
}

export function assertCompleteTaskInputProofSet({ tasks, proofs, ...identity }) {
  assertIdentity(identity, 'expected');
  assert.ok(Array.isArray(tasks) && tasks.length > 0, 'Invalid task inventory');
  assert.ok(tasks.every(task => VERIFICATION_TASKS.includes(task)), 'Unknown task in required inventory');
  assert.equal(new Set(tasks).size, tasks.length, 'Duplicate task in required inventory');
  assert.ok(Array.isArray(proofs), 'Missing task proof inventory');
  assert.equal(proofs.length, tasks.length, 'Incomplete task proof inventory');
  const byTask = new Map();
  for (const proof of proofs) {
    assert.ok(proof && typeof proof === 'object', 'Invalid task input proof');
    assert.ok(tasks.includes(proof.task), 'Unexpected task input proof');
    assert.ok(!byTask.has(proof.task), 'Duplicate task input proof');
    assert.equal(proof.status, 'passed', 'Task input proof did not pass');
    assert.equal(proof.sourceSha, identity.sourceSha, 'Task input proof source mismatch');
    assert.equal(proof.planDigest, identity.planDigest, 'Task input proof plan mismatch');
    assert.equal(proof.workflowRunId, identity.workflowRunId, 'Task input proof run mismatch');
    assert.equal(proof.workflowAttempt, identity.workflowAttempt, 'Task input proof attempt mismatch');
    assert.ok(positive(proof.jobId), 'Invalid task input proof job');
    assert.ok(proof.inputClosure && typeof proof.inputClosure === 'object', 'Missing task input closure');
    assert.deepEqual(Object.keys(proof.inputClosure).sort(), [...TASK_INPUT_DIMENSIONS].sort(), 'Incomplete task input closure');
    for (const dimension of TASK_INPUT_DIMENSIONS) {
      assert.match(proof.inputClosure[dimension], sha256Pattern, `Invalid ${dimension} input closure digest`);
    }
    byTask.set(proof.task, proof);
  }
  assert.deepEqual([...byTask.keys()].sort(), [...tasks].sort(), 'Task proof inventory does not match required tasks');
  return byTask;
}

export function selectEquivalentTaskProofs({ tasks, baseline, candidate, baselineIdentity, candidateIdentity }) {
  const baselineProofs = assertCompleteTaskInputProofSet({ tasks, proofs: baseline, ...baselineIdentity });
  const candidateProofs = assertCompleteTaskInputProofSet({ tasks, proofs: candidate, ...candidateIdentity });
  return tasks.filter(task => TASK_INPUT_DIMENSIONS.every(dimension =>
    baselineProofs.get(task).inputClosure[dimension] === candidateProofs.get(task).inputClosure[dimension]));
}
