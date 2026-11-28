#!/usr/bin/env node
// A completed, exact-source Verify main run authorizes one component release.
// Evaluate only after Verify completes. Only a net change to the same component supersedes a source.
import { actionsRepository, assertArtifactRunRepository, deploymentRepository, matchesRunRepository } from '../../github/repository.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentReleaseAffected } from './impact.mjs';
import { selectLatestPlanArtifact } from '../../ci/evidence/artifact-selection.mjs';
import { downloadArtifact, extractJsonEntry } from '../../ci/evidence/download-artifacts.mjs';
import { validateVerificationPlan } from '../../ci/impact/plan.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';

export function verifiedReleaseEvent(payload, env, checkoutSha) {
  const run = payload?.workflow_run;
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_run', 'Release requires a completed Verify event');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Release event must run on main');
  const context = actionsRepository(env);
  assert.equal(run?.path, '.github/workflows/verify.yml', 'Unexpected verification workflow');
  assert.equal(run?.event, 'push', 'PR verification cannot authorize releases');
  assert.equal(run?.head_branch, 'main', 'Release verification must come from main');
  assert.equal(run?.status, 'completed', 'Release verification is not complete');
  assert.equal(run?.conclusion, 'success', 'Unsuccessful verification cannot authorize release');
  assert.ok(matchesRunRepository(run, context), 'Verification repository mismatch');
  assert.ok(Number.isSafeInteger(run?.id) && run.id > 0, 'Invalid verification run ID');
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, 'Invalid verification run attempt');
  assert.match(run.head_sha ?? '', /^[a-f0-9]{40}$/u, 'Invalid verified commit');
  assert.equal(env.CODEXIA_SOURCE_SHA, run.head_sha, 'Release source SHA differs from verification event');
  assert.equal(String(env.CODEXIA_VERIFY_RUN_ID), String(run.id), 'Release verification run ID mismatch');
  assert.equal(checkoutSha, run.head_sha, 'Release checkout differs from verification source');
  return run;
}

export function selectReleaseSource(component, source, main, git, before) {
  assert.match(source, /^[a-f0-9]{40}$/u);
  assert.match(main, /^[a-f0-9]{40}$/u);
  const history = git('rev-list', '--first-parent', main).trim().split('\n');
  assert.ok(history.includes(source), 'Verified source is outside the first-parent history of main');
  const changed = (revision, base) => {
    const output = base === undefined
      ? git('diff-tree', '--root', '--diff-merges=first-parent', '--no-commit-id',
        '--name-only', '--no-renames', '-r', '-z', revision, '--')
      : git('diff', '--name-only', '--no-renames', '-z', base, revision, '--');
    const files = output.split('\0').filter(Boolean);
    return files.length > 0 && componentReleaseAffected(component, files);
  };
  // An unknown push boundary cannot prove that the component was unaffected.
  if (before !== null && !changed(source, before)) return { affected: false };
  // A change and revert in a later push can leave both component trees equivalent.
  if (source !== main && changed(main, source)) return { affected: false, successor: main };
  return { affected: true };
}

async function readVerifiedPushBase(run, runId, repository, token) {
  assert.ok(token, 'Release requires Actions read permission');
  assert.ok(Number.isSafeInteger(runId) && runId > 0, 'Invalid trusted Verify run ID');
  const { owner, repo } = deploymentRepository(repository);
  const github = createGitHubOctokit({ token });
  const [jobs, artifacts] = await Promise.all([
    paginateActionsInventory(github, github.rest.actions.listJobsForWorkflowRun,
      { owner, repo, run_id: runId, filter: 'latest' }, 'jobs'),
    paginateActionsInventory(github, github.rest.actions.listWorkflowRunArtifacts,
      { owner, repo, run_id: runId }, 'artifacts'),
  ]);
  const planArtifact = selectLatestPlanArtifact(artifacts, jobs, { runId, sourceSha: run.head_sha });
  assertArtifactRunRepository(planArtifact, run);
  const data = await extractJsonEntry(await downloadArtifact(planArtifact, repository, token), 'ci-plan.json');
  const plan = validateVerificationPlan(JSON.parse(data));
  assert.equal(plan.event, 'push');
  assert.equal(plan.sha, run.head_sha);
  return plan.base;
}

const main = async () => {
  const [component, ...rest] = process.argv.slice(2);
  assert.ok(['frontend', 'backend', 'backend-deployment'].includes(component) && rest.length === 0, 'Specify a release gate');
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const git = (...args) => execFileSync('git', args, { cwd:root, encoding:'utf8', timeout:60_000 });
  const checkoutSha = git('rev-parse','HEAD').trim();
  if (component === 'backend-deployment') {
    assert.equal(checkoutSha, process.env.CODEXIA_VERIFIED_MAIN_SHA, 'Deployment checkout differs from the certified main revision');
    const currentMain = git('rev-parse', 'refs/remotes/origin/main').trim();
    const current = selectReleaseSource('backend', checkoutSha, currentMain, git, null).affected;
    appendFileSync(process.env.GITHUB_OUTPUT, `current=${current}\n`);
    if (!current) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `Skipped certified backend ${checkoutSha} because main ${currentMain} has newer backend inputs.\n`);
    }
    return;
  }
  const run = verifiedReleaseEvent(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')),process.env,checkoutSha);
  const runId = Number(process.env.CODEXIA_VERIFY_RUN_ID);
  git('fetch', '--no-tags', 'origin', 'refs/heads/main');
  const remoteMain = git('rev-parse', 'FETCH_HEAD').trim();
  let before = await readVerifiedPushBase(run, runId, process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN).catch(() => null);
  if (before !== null) {
    try { git('cat-file', '-e', before + '^{commit}'); } catch { before = null; }
  }
  const { affected, successor } = selectReleaseSource(component, checkoutSha, remoteMain, git, before);
  if (affected) {
    assert.ok(process.env.GH_TOKEN, 'Release requires Actions read permission');
    execFileSync(process.execPath, ['scripts/release/components/verify-source.mjs'], {
      cwd:root,env:{...process.env,CODEXIA_COMMIT_RELEASE:'1',CODEXIA_VERIFY_RUN_ATTEMPT:String(run.run_attempt)},stdio:'inherit',timeout:120_000,
    });
  }
  const output = 'affected=' + String(affected) + '\nsource-sha=' + checkoutSha +
    '\nverify-run-id=' + runId + '\n';
  appendFileSync(process.env.GITHUB_OUTPUT,output);
  console.log(JSON.stringify({component,affected,sourceSha:checkoutSha,verifyRunId:runId,pushBase:before,
    ...(successor ? {skipped:'superseded by a newer component change',successor} : {})}));
};
if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error));process.exitCode=1; });
}
