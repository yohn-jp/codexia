import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessMergeReadiness, isMergeObservationCurrent } from './merge-readiness.mjs';
import { createVerificationPlan } from '../impact/plan.mjs';

const mainSha = 'a'.repeat(40), head = 'b'.repeat(40);
const repo = { id: 1, full_name: 'yohn-jp/codexia' };
const pr = { state: 'open', head: { sha: head, repo }, base: { ref: 'main', sha: mainSha, repo } };
const run = { id: 2, run_number: 3, workflow_id: 4, path: '.github/workflows/verify.yml', event: 'pull_request',
  head_sha: head, repository: repo, head_repository: repo, status: 'completed', conclusion: 'success' };
const input = { pr, mainSha, mergeBase: mainSha, runs: [run], workflowId: 4 };
const plan = files => createVerificationPlan({ files, event: 'pull_request', sha: head, base: mainSha });

test('merge readiness distinguishes full proof, affected proof, stale base and latest failed or pending runs', () => {
  assert.equal(assessMergeReadiness(input).status, 'inspect-plan');
  assert.equal(assessMergeReadiness({ ...input, plan: plan(['package.json']) }).status, 'compact-candidate');
  assert.equal(assessMergeReadiness({ ...input, plan: plan(['docs/authoring.sdoc']) }).status, 'full-main-required');
  assert.equal(assessMergeReadiness({ ...input, mergeBase: 'c'.repeat(40) }).status, 'not-ready');
  assert.equal(assessMergeReadiness({ ...input, runs: [run, { ...run, id: 3, run_number: 4, status: 'in_progress', conclusion: null }] }).status, 'not-ready');
  assert.equal(assessMergeReadiness({ ...input, runs: [run, { ...run, id: 3, run_number: 4, conclusion: 'failure' }] }).status, 'not-ready');
  assert.equal(assessMergeReadiness({ ...input, plan: createVerificationPlan({ files: null, event: 'pull_request', sha: head, base: 'c'.repeat(40) }) }).status, 'not-ready');
  assert.equal(assessMergeReadiness({ ...input, runs: [run, run] }).status, 'not-ready');
});

test('merge readiness rejects a PR whose base changes during observation', () => {
  assert.equal(isMergeObservationCurrent({ initialPr: pr, currentPr: pr, mainSha, currentMainSha: mainSha }), true);
  assert.equal(isMergeObservationCurrent({
    initialPr: pr, currentPr: { ...pr, base: { ...pr.base, ref: 'release' } }, mainSha, currentMainSha: mainSha,
  }), false);
  assert.equal(isMergeObservationCurrent({
    initialPr: pr, currentPr: { ...pr, base: { ...pr.base, sha: 'c'.repeat(40) } }, mainSha, currentMainSha: mainSha,
  }), false);
  assert.equal(isMergeObservationCurrent({
    initialPr: pr, currentPr: { ...pr, head: { ...pr.head, sha: 'c'.repeat(40) } }, mainSha, currentMainSha: mainSha,
  }), false);
  assert.equal(isMergeObservationCurrent({ initialPr: pr, currentPr: pr, mainSha, currentMainSha: 'd'.repeat(40) }), false);
});
