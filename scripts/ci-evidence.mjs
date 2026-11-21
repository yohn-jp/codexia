import assert from 'node:assert/strict';
import { VERIFICATION_GROUPS } from './ci-contract.mjs';
import { planDigest, validateVerificationPlan } from './ci-impact.mjs';
import { assertTaskInputFingerprint } from './ci-task-inputs.mjs';

export function assertPlanEvidence(plan, jobs, reports) {
  validateVerificationPlan(plan);
  const names = new Set();
  const supplementalFullModelNames = new Set();
  for (const job of jobs) {
    assert.equal(job.head_sha, plan.sha, 'Job source SHA mismatch');
    if (job.name === 'certification') continue;
    if (job.name === 'full-model-oci' || job.name.startsWith('full-model-oci / ')) {
      // The path-scoped reusable lifecycle run is a workflow-level gate, not artifact-report evidence.
      assert.equal(supplementalFullModelNames.has(job.name), false, 'Duplicate supplemental Full-model OCI job');
      supplementalFullModelNames.add(job.name);
      continue;
    }
    assert.ok(!names.has(job.name), `Duplicate verification job: ${job.name}`);
    names.add(job.name);
    if (job.name === 'plan' || plan.groups.includes(job.name)) {
      assert.equal(job.status, 'completed', `Unfinished verification job: ${job.name}`);
      assert.equal(job.conclusion, 'success', `Verification job did not succeed: ${job.name}`);
    } else {
      // GitHub can emit one skipped placeholder for an entirely unselected matrix.
      assert.equal(job.conclusion, 'skipped', `Unexpected executed verification job: ${job.name}`);
    }
  }
  for (const name of ['plan', ...plan.groups]) assert.ok(names.has(name), `Missing verification job: ${name}`);
  assert.equal(reports.length, plan.groups.length, 'Missing or extra execution evidence');
  const groups = new Set();
  for (const report of reports) {
    assert.ok(plan.groups.includes(report.group) && !groups.has(report.group), 'Unknown or duplicate execution evidence');
    groups.add(report.group);
    assert.equal(report.sha, plan.sha);
    assert.equal(report.planDigest, planDigest(plan));
    const expected = VERIFICATION_GROUPS[report.group].filter(task => plan.tasks.includes(task));
    assert.deepEqual(report.results.map(item => item.task), expected, 'Execution evidence omitted or duplicated a validation');
    assert.ok(report.results.every(item => item.status === 'passed'), 'A selected validation failed, was blocked or skipped');
  }
}

export function assertSafetyTaskEvidence(planValue, reports) {
  const plan = validateVerificationPlan(planValue);
  const group = reports.find(report => report.group === 'types-sources');
  const task = group?.results?.find(result => result.task === 'safety');
  if (!plan.tasks.includes('safety')) {
    assert.equal(task?.reuse, undefined, 'Unselected safety task cannot carry a reuse proof');
    return null;
  }
  assert.ok(task, 'Selected safety task is missing');
  if (group.taskInputs?.safety) assertTaskInputFingerprint(group.taskInputs.safety);
  if (task.reuse) {
    assert.equal(plan.event, 'push', 'Safety task reuse is main-push only');
    assert.equal(plan.mode, 'full', 'Safety task reuse must retain the full canonical plan');
    assert.equal(task.status, 'passed', 'Reused safety task is not passed');
    assert.ok(group.taskInputs?.safety, 'Reused safety task is missing its input fingerprint');
    const receipt = task.reuse;
    assert.equal(receipt.format, 'codexia-safety-task-proof/v1');
    assert.equal(receipt.sourceSha, plan.sha);
    assert.equal(assertTaskInputFingerprint(receipt.fingerprint).digest, group.taskInputs.safety.digest,
      'Safety task fingerprint differs from its first-parent proof');
    return receipt;
  }
  return null;
}
