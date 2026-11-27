#!/usr/bin/env node
// Re-evaluate the exact Backend Verify authority after entering the production queue.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { validatePushDeploymentCertificate } from '../admission/validate.mjs';
import { assertVerificationJobs } from '../../release/components/policy.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';

const repository = 'yohn-jp/codexia';

export function assertCurrentCertifiedVerify(runs, certificate) {
  const matches = runs.filter(run => run.path === '.github/workflows/verify.yml' &&
    run.event === 'push' && run.head_branch === 'main' &&
    run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    run.head_sha === certificate.verifiedMainSha &&
    Number.isSafeInteger(run.run_number) && run.run_number > 0 &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  assert.ok(matches.length > 0, 'No exact-main Verify run remains available after queue admission');
  matches.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  const current = matches[0];
  assert.equal(current.status, 'completed', 'Newer Verify run is not complete');
  assert.equal(current.conclusion, 'success', 'Newer Verify run failed or was cancelled');
  assert.equal(current.id, certificate.verifyRun.id, 'Certified Verify was superseded while queued');
  assert.equal(current.run_attempt, certificate.verifyRun.attempt,
    'Certified Verify attempt was superseded while queued');
  return current;
}

export async function reverifyQueuedBackend({ env = process.env, fetchImpl = fetch } = {}) {
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.ok(env.GH_TOKEN, 'Protected queue revalidation requires Actions read permission');
  const certificate = validatePushDeploymentCertificate(JSON.parse(Buffer.from(
    env.CODEXIA_DEPLOYMENT_CERTIFICATE_B64 ?? '', 'base64').toString('utf8')),
  env.CODEXIA_VERIFIED_MAIN_SHA);
  const github = createGitHubOctokit({ token: env.GH_TOKEN, fetchImpl, timeout: 20_000 });
  const params = { owner: 'yohn-jp', repo: 'codexia' };
  const runs = await paginateActionsInventory(github, github.rest.actions.listWorkflowRuns,
    { ...params, workflow_id: 'verify.yml', head_sha: certificate.verifiedMainSha,
      branch: 'main', event: 'push' }, 'workflow_runs');
  const current = assertCurrentCertifiedVerify(runs, certificate);
  const exact = (await github.rest.actions.getWorkflowRun({ ...params, run_id: current.id })).data;
  assertCurrentCertifiedVerify([exact], certificate);
  const jobs = await paginateActionsInventory(github, github.rest.actions.listJobsForWorkflowRun,
    { ...params, run_id: current.id, filter: 'latest' }, 'jobs');
  assertVerificationJobs(jobs);
  console.log('The exact successful Backend Verify run and attempt remain current after the production queue.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  reverifyQueuedBackend().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
