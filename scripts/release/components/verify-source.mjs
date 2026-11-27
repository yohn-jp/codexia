#!/usr/bin/env node
// Read-only gates for tag and commit-addressed publication.
import { execFileSync } from 'node:child_process';
import { assertReleaseIdentity, assertRemoteReleaseTag, assertVerificationJobs, verifiedSourceRun } from './policy.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';

const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME;
const commitRelease = process.env.CODEXIA_COMMIT_RELEASE === '1';
const expectedSha = process.env.CODEXIA_SOURCE_SHA || process.env.GITHUB_SHA;
const token = process.env.GH_TOKEN;
if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !tag || !expectedSha || !token) throw new Error('Release verification requires repository, tag, source and read token');
const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (commitRelease) {
  if (!/^[a-f0-9]{40}$/.test(expectedSha) || checkoutSha !== expectedSha || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Commit publication requires exact main source');
} else assertReleaseIdentity(tag, expectedSha, checkoutSha);
if(repository!=='yohn-jp/codexia') throw new Error('Release repository mismatch');
const github=createGitHubOctokit({token});
const [owner, repo] = repository.split('/');
if (!commitRelease) await assertRemoteReleaseTag(github, { owner, repo, tag, sha: expectedSha });
// The caller starts only after verification completed. One bounded read; no
// 30-second polling loop and no idle runner while tests are still running.
const exactId = process.env.CODEXIA_VERIFY_RUN_ID;
let runs;
if (commitRelease && exactId) {
  const id = Number(exactId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid completed Verify run ID');
  const run = (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: id })).data;
  if (run.id !== id || run.path !== '.github/workflows/verify.yml' ||
      run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) {
    throw new Error('Release completion event does not identify the canonical Verify run');
  }
  runs = [run];
} else {
  runs = await paginateActionsInventory(github, github.rest.actions.listWorkflowRuns,
    { owner, repo, workflow_id: 'verify.yml', head_sha: expectedSha, branch: 'main', event: 'push' }, 'workflow_runs');
}
const verified = verifiedSourceRun(runs, expectedSha);
const jobs = await paginateActionsInventory(github, github.rest.actions.listJobsForWorkflowRun,
  { owner, repo, run_id: verified.id, filter: 'latest' }, 'jobs');
assertVerificationJobs(jobs);
console.log(`Verified release ${tag} source ${expectedSha} with run ${verified.id}. No publication performed by this gate.`);
