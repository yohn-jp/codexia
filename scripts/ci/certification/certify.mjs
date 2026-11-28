#!/usr/bin/env node
import { actionsRepository, matchesRunRepository } from '../../github/repository.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CERTIFICATION_DEPENDENCIES } from '../impact/contract.mjs';
import { validateVerificationPlan, assertExactPrImpact, readVerificationFiles } from '../impact/plan.mjs';
import { assertPlanEvidence } from '../evidence/validation.mjs';
import { assertProfileArtifactEvidence } from '../evidence/profile-artifact.mjs';
import { resolveProducerJobAttempts } from '../evidence/artifact-selection.mjs';
import { normalizeVerificationJobs } from '../evidence/job-name.mjs';
import { assertReusedCoverageProof } from '../evidence/proof-reuse.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';
import { readReusableMainEvidence, selectMergedTaskReuse } from './reuse-merged-pr.mjs';
import { createGitHubProofClient } from '../evidence/proof-client.mjs';
import { downloadArtifact, extractJsonEntry } from '../evidence/download-artifacts.mjs';
import { assertTaskProducerInventory } from '../evidence/input-proof.mjs';
import { captureTaskInputSource, isReadOnlyMergedTask, taskInvocation } from '../evidence/task-inputs.mjs';

const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, CODEXIA_EXPECTED_SHA, CODEXIA_REQUIRED_RESULTS } = process.env;
assert.match(GITHUB_REPOSITORY ?? '', /^[\w.-]+\/[\w.-]+$/);
assert.match(GITHUB_RUN_ID ?? '', /^\d+$/);
assert.match(CODEXIA_EXPECTED_SHA ?? '', /^[a-f0-9]{40}$/);
assert.ok(GH_TOKEN, 'Read token is required');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), CODEXIA_EXPECTED_SHA);
const outcomes = JSON.parse(CODEXIA_REQUIRED_RESULTS ?? 'null');
assert.deepEqual(Object.keys(outcomes ?? {}).sort(), CERTIFICATION_DEPENDENCIES.toSorted(), 'All required DAG groups must be present');
assert.equal(outcomes.plan?.result, 'success', 'Impact planning did not succeed');
assert.ok(Object.values(outcomes).every(value => ['success', 'skipped'].includes(value.result)), 'A required DAG group failed, was cancelled or unexecuted');
const plan = validateVerificationPlan(JSON.parse(await readFile(process.env.CODEXIA_CI_PLAN_PATH ?? 'ci-plan.json', 'utf8')));
assert.equal(plan.sha, CODEXIA_EXPECTED_SHA);
const context = actionsRepository();
const github = createGitHubOctokit({ token: GH_TOKEN });
const { owner, repo } = context;
const run = (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(GITHUB_RUN_ID) })).data;
assert.ok(matchesRunRepository(run, context, { sameHead: run.event !== 'pull_request' }), 'Verification repository mismatch');
assert.equal(run.path, '.github/workflows/verify.yml', 'Verification workflow path mismatch');
assert.equal(run.head_sha, CODEXIA_EXPECTED_SHA, 'Workflow run must bind exact source');
assert.equal(run.event, plan.event, 'Impact plan event mismatch');
if (run.event !== 'pull_request') assert.equal(plan.mode, 'full', 'Main/manual verification must execute all unconditional validations');
if (run.event === 'pull_request') {
  const base = process.env.CODEXIA_EXPECTED_BASE;
  assertExactPrImpact(plan, base, readVerificationFiles({ event: run.event, base, sha: plan.sha }));
} else if (run.event === 'push') {
  const base = process.env.CODEXIA_PUSH_BASE;
  assert.equal(plan.base, base, 'Impact plan push base does not match the event');
  assert.deepEqual(plan.files, readVerificationFiles({ event: run.event, base, sha: plan.sha }),
    'Impact plan does not match the exact push diff');
}
const jobs = normalizeVerificationJobs(await paginateActionsInventory(github, github.rest.actions.listJobsForWorkflowRun,
  { owner, repo, run_id: Number(GITHUB_RUN_ID), filter: 'latest' }, 'jobs'));
const directory = process.env.CODEXIA_CI_EVIDENCE_DIR;
assert.ok(directory, 'Execution evidence directory is required');
const reports = [];
const evidenceEntries = await readdir(directory, { withFileTypes: true });
const rootReports = evidenceEntries.filter(entry => entry.name === 'report.json' && entry.isFile());
if (rootReports.length === 1) {
  assert.ok(evidenceEntries.every(entry => entry.isFile() && ['report.json', 'workspace-preparation.json'].includes(entry.name)),
    'Unexpected root execution evidence entry');
  reports.push(JSON.parse(await readFile(path.join(directory, rootReports[0].name), 'utf8')));
} else {
  for (const entry of evidenceEntries) {
    if (!entry.isDirectory()) throw new Error('Unexpected execution evidence entry');
    reports.push(JSON.parse(await readFile(path.join(directory, entry.name, 'report.json'), 'utf8')));
  }
}
assertPlanEvidence(plan, jobs, reports);
const reusedCoverageReports = reports.filter(report => report.results?.some(result => result.task === 'coverage' && result.inputProof?.reusedFrom));
const mergedReuseReports = reports.filter(report => report.results?.some(result => result.task !== 'coverage' && result.inputProof?.reusedFrom));
assert.ok(reusedCoverageReports.length <= 1, 'Duplicate task proof consumption reports');
const artifacts = await paginateActionsInventory(github, github.rest.actions.listWorkflowRunArtifacts,
  { owner, repo, run_id: Number(GITHUB_RUN_ID) }, 'artifacts');
const producerNames = [...new Set(['build-core', 'build-full', 'types-trace', ...mergedReuseReports.map(report => report.group)])];
if (reusedCoverageReports.length === 1) producerNames.push('types-tests');
const producerJobs = await resolveProducerJobAttempts(jobs, run,
  (runId, attempt) => paginateActionsInventory(github, github.rest.actions.listJobsForWorkflowRunAttempt,
    { owner, repo, run_id: runId, attempt_number: attempt }, 'jobs'),
  producerNames);
if (reusedCoverageReports.length === 1) {
  const candidateJob = producerJobs.find(job => job.name === 'types-tests');
  await assertReusedCoverageProof({ plan, report: reusedCoverageReports[0], current: run, candidateJob,
    repository: GITHUB_REPOSITORY, token: GH_TOKEN });
}
if (mergedReuseReports.length) {
  assert.ok(plan.mergedTaskReuse, 'Unexpected merged task reuse');
  const client = createGitHubProofClient({ repository: GITHUB_REPOSITORY, token: GH_TOKEN });
  const evidence = await readReusableMainEvidence({
    sourceSha: plan.sha, before: plan.base, repository: GITHUB_REPOSITORY, currentRun: run, request: client.get, allowAffected: true,
    git: args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15000 }),
    readArtifact: async (artifact, filename) => JSON.parse(await extractJsonEntry(await downloadArtifact(artifact, GITHUB_REPOSITORY, GH_TOKEN), filename)),
  });
  assert.deepEqual(plan.mergedTaskReuse, selectMergedTaskReuse(evidence), 'Merged task proof changed since planning');
  for (const report of mergedReuseReports) {
    const job = producerJobs.find(item => item.name === report.group);
    assert.equal(report.workflowRunId, run.id, 'Merged task consumer run mismatch');
    assert.equal(report.workflowAttempt, job.run_attempt, 'Merged task consumer attempt mismatch');
    assertTaskProducerInventory({ plan, report, inventory: report.producerInventory });
    for (const result of report.results) {
      const proof = result.inputProof;
      if (result.task === 'coverage' || !proof?.reusedFrom) continue;
      assert.ok(isReadOnlyMergedTask(process.cwd(), plan.sha, result.task), 'Task is not read-only');
      const actual = captureTaskInputSource({ root: process.cwd(), sha: plan.sha, runtime: proof.runtime })(result.task, taskInvocation(result.task, proof.runtime.execPath));
      assert.deepEqual(actual, proof.inputClosure, 'Current merged task input closure mismatch');
      assert.deepEqual(actual, proof.reusedFrom.inputClosure, 'Merged PR task input closure mismatch');
    }
  }
}
if (plan.tasks.includes('requirements-trace')) {
  const traceReport = reports.find(report => report.group === 'types-trace');
  const traceJob = producerJobs.find(job => job.name === 'types-trace');
  assert.equal(traceReport.workflowAttempt, traceJob.run_attempt, 'Trace evidence does not match the producer execution attempt');
}
assertProfileArtifactEvidence(plan, producerJobs, reports, artifacts, GITHUB_RUN_ID);
const message = `Verified ${plan.mode} plan: ${plan.tasks.length} validations at ${CODEXIA_EXPECTED_SHA}; run ${GITHUB_RUN_ID}. ${plan.excluded.length} explicitly NOT_SELECTED.\n`;
console.log(message.trim());
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, message);
