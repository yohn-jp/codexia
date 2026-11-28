#!/usr/bin/env node
// Read-only pre-merge advisory. The canonical main certifier remains authoritative.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';
import { selectLatestPlanArtifact } from '../evidence/artifact-selection.mjs';
import { downloadArtifact, extractJsonEntry } from '../evidence/download-artifacts.mjs';
import { validateVerificationPlan } from '../impact/plan.mjs';

const repository = 'yohn-jp/codexia';
const [owner, repo] = repository.split('/');
const shaPattern = /^[a-f0-9]{40}$/u;

export function assessMergeReadiness({ pr, mainSha, mergeBase, runs, workflowId, plan }) {
  const result = (status, reason) => ({ status, reason, headSha: pr.head?.sha ?? null, mainSha });
  assert.match(mainSha, shaPattern);
  if (pr.state !== 'open' || pr.base?.ref !== 'main' || pr.head?.repo?.id !== pr.base?.repo?.id ||
      pr.base?.repo?.full_name !== repository || pr.head?.repo?.full_name !== repository ||
      !shaPattern.test(pr.head?.sha ?? '')) return result('not-ready', 'Not an open same-repository main PR');
  if (mergeBase !== mainSha) return result('not-ready', 'PR head is not based on current main');
  const exact = runs.filter(run => run.workflow_id === workflowId && run.path === '.github/workflows/verify.yml' &&
    run.event === 'pull_request' && run.head_sha === pr.head.sha && run.repository?.id === pr.base.repo.id &&
    run.head_repository?.id === pr.head.repo.id);
  const ids = new Set(exact.map(run => run.id)), numbers = new Set(exact.map(run => run.run_number));
  if (!exact.length || ids.size !== exact.length || numbers.size !== exact.length ||
      exact.some(run => !Number.isSafeInteger(run.run_number) || !Number.isSafeInteger(run.id))) {
    return result('not-ready', 'Missing or ambiguous exact-head Verify inventory');
  }
  const latest = [...exact].sort((a,b) => b.run_number - a.run_number)[0];
  if (latest.status !== 'completed' || latest.conclusion !== 'success') return result('not-ready', 'Latest exact-head Verify is not successful');
  if (!plan) return { ...result('inspect-plan', 'Read the exact successful plan artifact'), runId: latest.id };
  const checked = validateVerificationPlan(plan);
  if (checked.event !== 'pull_request' || checked.sha !== pr.head.sha || checked.base !== mainSha) {
    return result('not-ready', 'Verify plan is not bound to the current head and main base');
  }
  if (checked.mode !== 'full') return result('full-main-required', 'Affected PR proof cannot replace full main verification');
  return result('compact-candidate', 'Full exact-base PR proof candidate; main must independently certify the actual merged tree and evidence');
}

export function isMergeObservationCurrent({ initialPr, currentPr, mainSha, currentMainSha }) {
  return currentMainSha === mainSha && currentPr.state === 'open' &&
    currentPr.head?.sha === initialPr.head?.sha && currentPr.base?.ref === initialPr.base?.ref &&
    currentPr.base?.sha === mainSha && currentPr.base?.repo?.id === initialPr.base?.repo?.id &&
    currentPr.head?.repo?.id === initialPr.head?.repo?.id;
}

async function main() {
  const [number, ...extra] = process.argv.slice(2);
  assert.match(number ?? '', /^[1-9]\d*$/u, 'Usage: merge-readiness.mjs PR_NUMBER');
  assert.equal(extra.length, 0);
  const token = process.env.GH_TOKEN;
  const probe = createGitHubOctokit({ token, repository });
  const { data: target } = await probe.rest.repos.get({ owner, repo });
  assert.equal(target.full_name, repository);
  const github = createGitHubOctokit({ token, repository, repositoryId: target.id });
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: Number(number) });
  const readMain = async () => (await github.rest.repos.getBranch({ owner, repo, branch: 'main' })).data.commit.sha;
  const mainSha = await readMain();
  const { data: workflow } = await github.rest.actions.getWorkflow({ owner, repo, workflow_id: 'verify.yml' });
  // Require a fetched, real git graph; do not infer ancestry from the PR base field.
  const mergeBase = execFileSync('git', ['merge-base', mainSha, pr.head.sha], { encoding: 'utf8', timeout: 15000 }).trim();
  const runs = await paginateActionsInventory(github, github.rest.actions.listWorkflowRuns,
    { owner, repo, workflow_id: workflow.id, head_sha: pr.head.sha, event: 'pull_request' }, 'workflow_runs');
  const input = { pr, mainSha, mergeBase, runs, workflowId: workflow.id };
  let result = assessMergeReadiness(input);
  if (result.status === 'inspect-plan') {
    const run = runs.find(item => item.id === result.runId);
    const jobs = await paginateActionsInventory(github, github.rest.actions.listJobsForWorkflowRun,
      { owner, repo, run_id: run.id, filter: 'latest' }, 'jobs');
    const artifacts = await paginateActionsInventory(github, github.rest.actions.listWorkflowRunArtifacts,
      { owner, repo, run_id: run.id }, 'artifacts');
    const identity = { runId: run.id, sourceSha: pr.head.sha };
    const artifact = selectLatestPlanArtifact(artifacts, jobs, identity);
    const plan = JSON.parse(await extractJsonEntry(await downloadArtifact(artifact, repository, token), 'ci-plan.json'));
    result = assessMergeReadiness({ ...input, plan });
  }
  // Never report readiness from a moving base or replaced PR head.
  const currentMain = await readMain();
  const { data: currentPr } = await github.rest.pulls.get({ owner, repo, pull_number: Number(number) });
  if (!isMergeObservationCurrent({ initialPr: pr, currentPr, mainSha, currentMainSha: currentMain })) {
    result = { status: 'not-ready', reason: 'PR, base or main moved during observation', headSha: pr.head.sha, mainSha };
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'not-ready') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('Merge readiness unavailable: ' + error.message); process.exitCode = 1; });
}
