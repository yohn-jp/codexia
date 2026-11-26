import assert from 'node:assert/strict';
import { VERIFICATION_GROUPS } from '../impact/contract.mjs';
import { planDigest, validateVerificationPlan } from '../impact/plan.mjs';

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
