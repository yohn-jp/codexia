import assert from 'node:assert/strict';
import path from 'node:path';
import { VERIFICATION_GROUPS, VERIFICATION_TASKS } from '../impact/contract.mjs';
import { planDigest, validateVerificationPlan } from '../impact/plan.mjs';
import { taskInvocation } from './task-inputs.mjs';

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
    assert.ok(typeof proof.workflowJob === 'string' && /^[a-z0-9_-]+$/iu.test(proof.workflowJob), 'Invalid task input proof job');
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

/** Validate the immutable GitHub identities that authorize consuming one task input proof. */
export function assertTrustedTaskInputProof({ inputProof, identity, run, job, artifact, expected }) {
  assert.ok(identity && expected, 'Missing task proof trust context');
  assertIdentity(identity, 'expected');
  assert.ok(inputProof && typeof inputProof === 'object', 'Missing task input proof');
  assertCompleteTaskInputProofSet({ tasks: [inputProof.task], proofs: [inputProof], ...identity });
  assert.ok(Number.isSafeInteger(expected.repositoryId) && expected.repositoryId > 0, 'Invalid expected repository');
  assert.ok(Number.isSafeInteger(expected.workflowId) && expected.workflowId > 0, 'Invalid expected workflow');
  assert.ok(typeof expected.jobName === 'string' && expected.jobName.length > 0, 'Invalid expected task job');
  assert.ok(typeof expected.workflowJob === 'string' && /^[a-z0-9_-]+$/iu.test(expected.workflowJob), 'Invalid expected workflow job ID');
  assert.ok(typeof expected.artifactName === 'string' && expected.artifactName.length > 0, 'Invalid expected proof artifact');

  assert.equal(run?.id, identity.workflowRunId, 'Task proof run ID mismatch');
  assert.equal(run.workflow_id, expected.workflowId, 'Task proof workflow mismatch');
  assert.equal(run.repository?.id, expected.repositoryId, 'Task proof repository mismatch');
  assert.equal(run.head_sha, identity.sourceSha, 'Task proof source mismatch');
  assert.equal(run.event, 'push', 'Task proof is not from a main push');
  assert.equal(run.head_branch, 'main', 'Task proof branch mismatch');
  assert.equal(run.run_attempt, identity.workflowAttempt, 'Task proof run attempt mismatch');
  assert.equal(run.status, 'completed', 'Task proof main run is unfinished');
  assert.equal(run.conclusion, 'success', 'Task proof main run did not succeed');

  assert.ok(Number.isSafeInteger(job?.id) && job.id > 0, 'Invalid task proof job ID');
  assert.equal(job.run_id, identity.workflowRunId, 'Task proof job run mismatch');
  assert.equal(job.run_attempt, identity.workflowAttempt, 'Task proof job attempt mismatch');
  assert.equal(job.head_sha, identity.sourceSha, 'Task proof job source mismatch');
  assert.equal(job.name, expected.jobName, 'Task proof job name mismatch');
  assert.equal(inputProof.task, expected.task ?? 'coverage', 'Task proof task mismatch');
  assert.equal(inputProof.workflowJob, expected.workflowJob, 'Task proof workflow job ID mismatch');
  assert.equal(inputProof.format, 'codexia-ci-task-input-proof/v2', 'Unknown task input proof format');
  assert.ok(inputProof.task === 'coverage' ? inputProof.mode === 'static-coverage' : inputProof.mode === 'task-execution',
    'Unsupported reusable task input proof mode');
  assert.equal(inputProof.status, 'passed', 'Reusable task input proof did not pass');
  assert.equal(job.status, 'completed', 'Task proof job is unfinished');
  assert.equal(job.conclusion, 'success', 'Task proof job did not succeed');

  assert.equal(artifact?.id, expected.artifactId, 'Task proof artifact ID mismatch');
  assert.equal(artifact.name, expected.artifactName, 'Task proof artifact name mismatch');
  assert.equal(artifact.digest, expected.artifactDigest, 'Task proof artifact digest mismatch');
  assert.equal(artifact.expired, false, 'Task proof artifact is expired');
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/u, 'Task proof artifact digest is invalid');
  assert.equal(String(artifact.workflow_run?.id), String(identity.workflowRunId), 'Task proof artifact run mismatch');
  assert.equal(artifact.workflow_run?.head_sha, identity.sourceSha, 'Task proof artifact source mismatch');
  return inputProof;
}

/** Trust a PR task receipt only when its exact merge source passed main certification. */
export function assertTrustedCertifiedSourceTaskInputProof({ inputProof, identity, sourceRun, job, artifact,
  mainRun, certificationJob, certificationStep, certification, expected }) {
  assert.ok(identity && expected, 'Missing certified task proof context');
  assertIdentity(identity, 'expected');
  assertCompleteTaskInputProofSet({ tasks: [inputProof?.task], proofs: [inputProof], ...identity });
  assert.equal(inputProof.format, 'codexia-ci-task-input-proof/v2', 'Unknown certified task input proof format');
  assert.equal(inputProof.task, expected.task ?? 'coverage', 'Certified task proof task mismatch');
  assert.ok(inputProof.task === 'coverage' ? inputProof.mode === 'static-coverage' : inputProof.mode === 'task-execution',
    'Unsupported certified task input proof mode');
  assert.equal(inputProof.status, 'passed', 'Certified source task proof did not pass');
  assert.equal(inputProof.workflowJob, expected.workflowJob, 'Certified source proof workflow job ID mismatch');

  assert.equal(sourceRun?.id, identity.workflowRunId, 'Certified source proof run mismatch');
  assert.equal(sourceRun.workflow_id, expected.workflowId, 'Certified source proof workflow mismatch');
  assert.equal(sourceRun.path, '.github/workflows/verify.yml', 'Certified source proof workflow path mismatch');
  assert.equal(sourceRun.repository?.id, expected.repositoryId, 'Certified source proof repository mismatch');
  assert.equal(sourceRun.head_repository?.id, expected.repositoryId, 'Certified source proof is from a foreign repository');
  assert.equal(sourceRun.head_sha, identity.sourceSha, 'Certified source proof SHA mismatch');
  assert.equal(sourceRun.event, 'pull_request', 'Certified source proof is not from a pull request');
  assert.equal(sourceRun.status, 'completed', 'Certified source proof run is unfinished');
  assert.equal(sourceRun.conclusion, 'success', 'Certified source proof run did not succeed');
  assert.equal(sourceRun.run_attempt, identity.workflowAttempt, 'Certified source proof attempt mismatch');

  assert.equal(job?.id, expected.jobId, 'Certified task proof job ID mismatch');
  assert.equal(job.run_id, identity.workflowRunId, 'Certified task proof job run mismatch');
  assert.equal(job.run_attempt, identity.workflowAttempt, 'Certified task proof job attempt mismatch');
  assert.equal(job.head_sha, identity.sourceSha, 'Certified task proof job source mismatch');
  assert.equal(job.name, expected.jobName, 'Certified task proof job name mismatch');
  assert.equal(job.status, 'completed', 'Certified task proof job is unfinished');
  assert.equal(job.conclusion, 'success', 'Certified task proof job did not succeed');

  assert.equal(artifact?.id, expected.artifactId, 'Certified task proof artifact ID mismatch');
  assert.equal(artifact.name, expected.artifactName, 'Certified task proof artifact name mismatch');
  assert.equal(artifact.digest, expected.artifactDigest, 'Certified task proof artifact digest mismatch');
  assert.equal(artifact.expired, false, 'Certified task proof artifact is expired');
  assert.equal(String(artifact.workflow_run?.id), String(identity.workflowRunId), 'Certified task proof artifact run mismatch');
  assert.equal(artifact.workflow_run?.head_sha, identity.sourceSha, 'Certified task proof artifact source mismatch');

  assert.ok(certification && typeof certification === 'object', 'Main certification identity missing from task proof');
  assert.equal(mainRun?.id, certification.workflowRunId, 'Main task certification run mismatch');
  assert.equal(mainRun.workflow_id, certification.workflowId, 'Main task certification workflow mismatch');
  assert.equal(mainRun.repository?.id, certification.repositoryId, 'Main task certification repository mismatch');
  assert.equal(mainRun.head_sha, certification.sourceSha, 'Main task certification source mismatch');
  assert.equal(mainRun.event, 'push', 'Task proof certification is not from a main push');
  assert.equal(mainRun.head_branch, 'main', 'Task proof certification branch mismatch');
  assert.equal(mainRun.status, 'completed', 'Main task certification run is unfinished');
  assert.equal(mainRun.conclusion, 'success', 'Main task certification run did not succeed');
  assert.equal(mainRun.run_attempt, certification.workflowAttempt, 'Main task certification attempt mismatch');
  assert.equal(certificationJob?.id, certification.jobId, 'Main certification job ID mismatch');
  assert.equal(certificationJob.run_id, mainRun.id, 'Main certification job run mismatch');
  assert.equal(certificationJob.run_attempt, mainRun.run_attempt, 'Main certification job attempt mismatch');
  assert.equal(certificationJob.head_sha, mainRun.head_sha, 'Main certification job source mismatch');
  assert.equal(certificationJob.name, 'certification', 'Unexpected main certification job');
  assert.equal(certificationJob.status, 'completed', 'Main certification job is unfinished');
  assert.equal(certificationJob.conclusion, 'success', 'Main certification job did not succeed');
  assert.equal(certificationStep?.name, 'Certify reused merged PR proof', 'Unexpected main task certification step');
  assert.equal(certificationStep.conclusion, 'success', 'Main task proof was not certified');
  return inputProof;
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
    assert.deepEqual(recorded.inputProof, result.inputProof, 'Producer task input proof mismatch');
    if (recorded.inputProof !== undefined) {
      const proof = recorded.inputProof;
      assert.equal(proof.task, recorded.task, 'Input closure task mismatch');
      assert.equal(result.status, 'passed', 'Input closure requires a passed task');
      assert.equal(proof.format, 'codexia-ci-task-input-proof/v2', 'Unknown task input proof format');
      assert.ok(proof.task === 'coverage' ? proof.mode === 'static-coverage' : proof.mode === 'task-execution',
        'Unsupported task input proof mode');
      assert.equal(proof.status, 'passed', 'Task input proof did not pass');
      assert.equal(proof.sourceSha, plan.sha, 'Task input proof source mismatch');
      assert.equal(proof.planDigest, planDigest(plan), 'Task input proof plan mismatch');
      assert.equal(proof.workflowRunId, report.workflowRunId, 'Task input proof run mismatch');
      assert.equal(proof.workflowAttempt, report.workflowAttempt, 'Task input proof attempt mismatch');
      assert.equal(proof.workflowJob, report.workflowJob, 'Task input proof job mismatch');
      if (proof.reusedFrom !== undefined) {
        if (proof.task === 'coverage') {
          assert.deepEqual(proof.reusedFrom, plan.coverageReuse, 'Task proof reuse receipt mismatch');
          assert.equal(plan.base, proof.reusedFrom.sourceSha, 'Task proof base source mismatch');
        } else {
          assert.equal(plan.event, 'push', 'Merged task proof must belong to a main push');
          const prior = plan.mergedTaskReuse?.proofs.find(item => item.task === proof.task);
          assert.ok(prior, 'Missing merged task reuse candidate');
          assert.deepEqual(proof.reusedFrom, prior, 'Merged task reuse receipt mismatch');
          assert.deepEqual(recorded.invocations, [], 'Reused task cannot claim fresh execution');
        }
        assert.deepEqual(proof.inputClosure, proof.reusedFrom.inputClosure, 'Task proof reused input closure mismatch');
      }
      assert.ok(proof.runtime && typeof proof.runtime === 'object', 'Missing task input proof runtime');
      for (const key of ['platform', 'arch', 'nodeVersion', 'execPath', 'cwd']) {
        assert.ok(typeof proof.runtime[key] === 'string' && proof.runtime[key].length > 0, `Missing task input proof runtime ${key}`);
      }
      assert.ok(path.isAbsolute(proof.runtime.execPath) && path.isAbsolute(proof.runtime.cwd), 'Task input proof runtime paths must be absolute');
      for (const key of ['imageOS', 'imageVersion']) assert.ok(proof.runtime[key] === null || typeof proof.runtime[key] === 'string', `Invalid task input proof runtime ${key}`);
      assert.ok(proof.inputClosure && typeof proof.inputClosure === 'object', 'Missing task input closure');
      assert.deepEqual(Object.keys(proof.inputClosure).sort(), [...TASK_INPUT_DIMENSIONS].sort(), 'Incomplete task input closure');
      for (const dimension of TASK_INPUT_DIMENSIONS) assert.match(proof.inputClosure[dimension], sha256Pattern, `Invalid ${dimension} input closure digest`);
      assert.equal(proof.runtime.nodeVersion, inventory.runner.nodeVersion, 'Task input proof Node runtime mismatch');
      assert.equal(proof.runtime.imageOS, inventory.runner.imageOS, 'Task input proof image OS mismatch');
      assert.equal(proof.runtime.imageVersion, inventory.runner.imageVersion, 'Task input proof image version mismatch');
      assert.equal(proof.runtime.platform, inventory.runner.os.toLowerCase(), 'Task input proof platform mismatch');
      assert.equal(proof.runtime.arch, inventory.runner.arch.toLowerCase(), 'Task input proof architecture mismatch');
      if (proof.mode === 'task-execution' && proof.reusedFrom === undefined) {
        const expectedInvocations = taskInvocation(recorded.task, proof.runtime.execPath);
        assert.deepEqual(recorded.invocations, Array.isArray(expectedInvocations) ? expectedInvocations : [expectedInvocations],
          'Task input proof invocation does not match the canonical runner');
      }
    }
    assertInvocationList(recorded.invocations, recorded.task, { required: result.status === 'passed' && recorded.inputProof?.reusedFrom === undefined });
  }
  assertInvocationList(inventory.groupInvocations, 'group');
  return inventory;
}
