import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVerificationPlan, planDigest } from '../impact/plan.mjs';
import { VERIFICATION_GROUPS } from '../impact/contract.mjs';
import { assertPlanEvidence } from './validation.mjs';

const sha = 'a'.repeat(40);
const fixture = (event, files = ['modules/search/src/browser.ts']) => {
  const plan = createVerificationPlan({ files, event, sha });
  return {
    plan,
    jobs: ['plan', ...plan.groups].map(name => ({ name, head_sha: sha, status: 'completed', conclusion: 'success' })),
    reports: plan.groups.map(group => ({ group, sha, planDigest: planDigest(plan), results: VERIFICATION_GROUPS[group].filter(task => plan.tasks.includes(task)).map(task => ({ task, status: 'passed' })) })),
  };
};
test('affected PR and complete main plans both require exact execution evidence', () => {
  for (const event of ['pull_request', 'push']) {
    const { plan, jobs, reports } = fixture(event);
    assert.doesNotThrow(() => assertPlanEvidence(plan, jobs, reports));
  }
});
test('supplemental Full-model OCI results stay outside authenticated artifact certification', () => {
  const plan = createVerificationPlan({ files: ['profiles/full/profile.json'], event: 'pull_request', sha });
  const jobs = ['plan', ...plan.groups].map(name => ({ name, head_sha: sha, status: 'completed', conclusion: 'success' }));
  const reports = plan.groups.map(group => ({ group, sha, planDigest: planDigest(plan), results: VERIFICATION_GROUPS[group].filter(task => plan.tasks.includes(task)).map(task => ({ task, status: 'passed' })) }));
  assert.equal(plan.full_model_oci, true);
  for (const result of [
    { status: 'completed', conclusion: 'success' },
    { status: 'completed', conclusion: 'failure' },
    { status: 'in_progress', conclusion: null },
  ]) {
    assert.doesNotThrow(() => assertPlanEvidence(plan, [...jobs,
      { name: 'full-model-oci', head_sha: sha, ...result },
      { name: 'full-model-oci / Run pinned Full model lifecycle on rootless Podman', head_sha: sha, ...result },
    ], reports));
  }
  assert.throws(() => assertPlanEvidence(plan, [...jobs,
    { name: 'full-model-oci', head_sha: sha, status: 'completed', conclusion: 'success' },
    { name: 'full-model-oci', head_sha: sha, status: 'completed', conclusion: 'success' },
  ], reports), /Duplicate supplemental Full-model OCI job/);
});
test('missing, stale, failed, skipped and duplicate evidence cannot certify selected work', () => {
  for (const mutate of [
    data => data.jobs.pop(),
    data => { data.jobs[1].conclusion = 'skipped'; },
    data => { data.jobs[1].status = 'in_progress'; },
    data => { data.jobs[1].head_sha = 'b'.repeat(40); },
    data => data.reports.pop(),
    data => { data.reports[0].sha = 'b'.repeat(40); },
    data => { data.reports[0].planDigest = 'stale'; },
    data => data.reports[0].results.pop(),
    data => { data.reports[0].results[0].status = 'skipped'; },
    data => { data.reports[0].results[0].status = 'blocked'; },
    data => { data.reports[0].results[0].status = 'failed'; },
    data => { data.reports[1] = data.reports[0]; },
    data => data.plan.tasks.pop(),
    data => data.plan.excluded.pop(),
  ]) {
    const data = fixture('pull_request');
    mutate(data);
    assert.throws(() => assertPlanEvidence(data.plan, data.jobs, data.reports));
  }
});
test('only unselected matrix placeholders may be skipped; executed extras fail', () => {
  const { plan, jobs, reports } = fixture('pull_request');
  jobs.push({ name: 'oci-${{ matrix.profile }}', head_sha: sha, status: 'completed', conclusion: 'skipped' });
  assert.doesNotThrow(() => assertPlanEvidence(plan, jobs, reports));
  jobs.at(-1).conclusion = 'success';
  assert.throws(() => assertPlanEvidence(plan, jobs, reports));
});

test('Swift Linux evidence is required only for a selected task in the shared unit group', () => {
  for (const event of ['pull_request', 'push']) {
    const source = ['docs/architecture/SYSTEM-DESIGN.md'];
    const unrelated = fixture(event, source);
    const architecture = unrelated.reports.find(report => report.group === 'unit-architecture');
    assert.deepEqual(architecture.results.map(result => result.task), ['architecture-g5']);
    assert.doesNotThrow(() => assertPlanEvidence(unrelated.plan, unrelated.jobs, unrelated.reports));
    architecture.results.push({ task: 'swift-linux', status: 'passed' });
    assert.throws(() => assertPlanEvidence(unrelated.plan, unrelated.jobs, unrelated.reports), /omitted or duplicated/);

    const selected = fixture(event, [...source, 'ios/CodexiaTransport/Package.swift']);
    const shared = selected.reports.find(report => report.group === 'unit-architecture');
    assert.deepEqual(shared.results.map(result => result.task), ['architecture-g5', 'swift-linux']);
    assert.doesNotThrow(() => assertPlanEvidence(selected.plan, selected.jobs, selected.reports));
    shared.results.pop();
    assert.throws(() => assertPlanEvidence(selected.plan, selected.jobs, selected.reports), /omitted or duplicated/);
  }
});
