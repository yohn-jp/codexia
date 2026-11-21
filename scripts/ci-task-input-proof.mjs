import assert from 'node:assert/strict';
import { VERIFICATION_GROUPS, VERIFICATION_TASKS } from './ci-contract.mjs';
import { planDigest, validateVerificationPlan } from './ci-impact.mjs';

export const TASK_INPUT_DIMENSIONS = Object.freeze([
  'source', 'tests', 'dependencies', 'environment', 'toolchain', 'recipe', 'producers',
]);

const sha256Pattern = /^[a-f0-9]{64}$/u;
const sourceShaPattern = /^[a-f0-9]{40}$/u;
const positive = value => Number.isSafeInteger(value) && value > 0;

export function sanitizeProducerArguments(args) {
  assert.ok(Array.isArray(args) && args.every(value => typeof value === 'string'), 'Invalid producer arguments');
  const output = [];
  let redactNext = false;
  for (const value of args) {
    if (redactNext) {
      output.push('[redacted]');
      redactNext = false;
    } else if (/^--?(?:token|password|secret|credential|private[-_]?key|authorization)$/iu.test(value)) {
      output.push(value);
      redactNext = true;
    } else if (/^(.*(?:token|password|secret|credential|private[-_]?key|authorization))=(.*)$/iu.test(value)) {
      output.push(value.replace(/=.*/u, '=[redacted]'));
    } else output.push(value);
  }
  return output;
}

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

function assertInvocationList(invocations, label, { required = false } = {}) {
  assert.ok(Array.isArray(invocations), `Missing ${label} invocation inventory`);
  if (required) assert.ok(invocations.length > 0, `Passed task has no ${label} invocation`);
  for (const invocation of invocations) {
    assert.ok(invocation && typeof invocation === 'object', `Invalid ${label} invocation`);
    assert.ok(typeof invocation.executable === 'string' && invocation.executable.length > 0, `Invalid ${label} executable`);
    assert.ok(Array.isArray(invocation.arguments) && invocation.arguments.every(value => typeof value === 'string'), `Invalid ${label} arguments`);
    assert.ok(Array.isArray(invocation.environmentKeys) && invocation.environmentKeys.every(value => typeof value === 'string'), `Invalid ${label} environment inventory`);
    assert.deepEqual([...invocation.environmentKeys].sort(), [...new Set(invocation.environmentKeys)].sort(), `Duplicate ${label} environment key`);
  }
}

/** Validate report-only execution provenance. It is not an input-closure proof and cannot authorize task reuse. */
export function assertTaskProducerInventory({ plan, report, inventory }) {
  validateVerificationPlan(plan);
  assert.ok(inventory && typeof inventory === 'object', 'Missing producer inventory');
  assert.equal(inventory.format, 'codexia-ci-task-producer-inventory/v1', 'Unknown producer inventory format');
  assert.ok(typeof inventory.group === 'string' && Object.hasOwn(VERIFICATION_GROUPS, inventory.group), 'Invalid producer inventory group');
  assert.ok(plan.groups.includes(inventory.group), 'Producer inventory group is not selected');
  assert.equal(report?.group, inventory.group, 'Producer inventory report group mismatch');
  assert.equal(report?.sha, plan.sha, 'Producer inventory report source mismatch');
  assert.equal(report?.planDigest, planDigest(plan), 'Producer inventory report plan mismatch');
  for (const key of ['workflowRunId', 'workflowAttempt', 'workflowJob', 'workflowRef', 'workflowSha']) {
    assert.equal(inventory[key], report[key], `Producer inventory ${key} mismatch`);
  }
  assert.equal(inventory.sourceSha, plan.sha, 'Producer inventory source mismatch');
  assert.equal(inventory.planDigest, planDigest(plan), 'Producer inventory plan mismatch');
  assert.ok(Number.isSafeInteger(inventory.workflowRunId) && inventory.workflowRunId > 0, 'Invalid producer workflow run');
  assert.ok(Number.isSafeInteger(inventory.workflowAttempt) && inventory.workflowAttempt > 0, 'Invalid producer workflow attempt');
  assert.ok(typeof inventory.workflowJob === 'string' && /^[a-z0-9_-]+$/iu.test(inventory.workflowJob), 'Invalid producer workflow job');
  assert.ok(typeof inventory.workflowRef === 'string' && inventory.workflowRef.length > 0, 'Missing producer workflow ref');
  assert.match(inventory.workflowSha, sourceShaPattern, 'Invalid producer workflow source');
  assert.ok(inventory.runner && typeof inventory.runner === 'object', 'Missing producer runner identity');
  for (const key of ['os', 'arch', 'nodeVersion']) assert.ok(typeof inventory.runner[key] === 'string' && inventory.runner[key].length > 0, `Missing producer runner ${key}`);
  for (const key of ['imageOS', 'imageVersion']) assert.ok(inventory.runner[key] === null || typeof inventory.runner[key] === 'string', `Invalid producer runner ${key}`);

  const expectedTasks = VERIFICATION_GROUPS[inventory.group].filter(task => plan.tasks.includes(task));
  assert.deepEqual(inventory.selectedTasks, expectedTasks, 'Producer selected-task inventory mismatch');
  assert.deepEqual(report.results?.map(item => item.task), expectedTasks, 'Producer report task inventory mismatch');
  assert.ok(Array.isArray(inventory.taskInvocations), 'Missing task invocation inventory');
  assert.deepEqual(inventory.taskInvocations.map(item => item.task), expectedTasks, 'Producer task invocation inventory mismatch');
  for (let index = 0; index < expectedTasks.length; index += 1) {
    const recorded = inventory.taskInvocations[index];
    const result = report.results[index];
    assert.equal(recorded.status, result.status, 'Producer task result mismatch');
    assert.deepEqual(recorded.invocations, result.invocations, 'Producer task invocation mismatch');
    assertInvocationList(recorded.invocations, recorded.task, { required: result.status === 'passed' });
  }
  assertInvocationList(inventory.groupInvocations, 'group');
  return inventory;
}
