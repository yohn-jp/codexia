#!/usr/bin/env node
// A completed, exact-source Verify main run authorizes one component release.
// Evaluate only after Verify completes. A later change to the same component supersedes an older source.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentReleaseAffected } from './release-impact.mjs';

export function verifiedReleaseEvent(payload, env, checkoutSha) {
  const run = payload?.workflow_run;
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_run', 'Release requires a completed Verify event');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Release event must run on main');
  assert.equal(env.GITHUB_REPOSITORY, 'yohn-jp/codexia', 'Release repository mismatch');
  assert.equal(run?.path, '.github/workflows/verify.yml', 'Unexpected verification workflow');
  assert.equal(run?.event, 'push', 'PR verification cannot authorize releases');
  assert.equal(run?.head_branch, 'main', 'Release verification must come from main');
  assert.equal(run?.status, 'completed', 'Release verification is not complete');
  assert.equal(run?.conclusion, 'success', 'Unsuccessful verification cannot authorize release');
  assert.equal(run?.repository?.full_name, env.GITHUB_REPOSITORY, 'Verification repository mismatch');
  assert.equal(run?.head_repository?.full_name, env.GITHUB_REPOSITORY, 'Verification source repository mismatch');
  assert.ok(Number.isSafeInteger(run?.id) && run.id > 0, 'Invalid verification run ID');
  assert.match(run.head_sha ?? '', /^[a-f0-9]{40}$/u, 'Invalid verified commit');
  assert.equal(env.CODEXIA_SOURCE_SHA, run.head_sha, 'Release source SHA differs from verification event');
  assert.equal(String(env.CODEXIA_VERIFY_RUN_ID), String(run.id), 'Release verification run ID mismatch');
  assert.equal(checkoutSha, run.head_sha, 'Release checkout differs from verification source');
  return run;
}

export function selectReleaseSource(component, source, main, git) {
  assert.match(source, /^[a-f0-9]{40}$/u);
  assert.match(main, /^[a-f0-9]{40}$/u);
  const history = git('rev-list', '--first-parent', main).trim().split('\n');
  const index = history.indexOf(source);
  assert.ok(index >= 0, 'Verified source is outside the first-parent history of main');
  const changed = revision => {
    const files = git('diff-tree', '--root', '--diff-merges=first-parent', '--no-commit-id',
      '--name-only', '--no-renames', '-r', '-z', revision, '--').split('\0').filter(Boolean);
    return files.length > 0 && componentReleaseAffected(component, files);
  };
  if (!changed(source)) return { affected: false };
  const successor = history.slice(0, index).find(changed);
  return successor ? { affected: false, successor } : { affected: true };
}

const main = async () => {
  const [component, ...rest] = process.argv.slice(2);
  assert.ok(['frontend','backend'].includes(component) && rest.length === 0, 'Specify frontend or backend');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const git = (...args) => execFileSync('git', args, { cwd:root, encoding:'utf8', timeout:60_000 });
  const checkoutSha = git('rev-parse','HEAD').trim();
  const run = verifiedReleaseEvent(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')),process.env,checkoutSha);
  git('fetch', '--no-tags', 'origin', 'refs/heads/main');
  const remoteMain = git('rev-parse', 'FETCH_HEAD').trim();
  const { affected, successor } = selectReleaseSource(component, checkoutSha, remoteMain, git);
  if (affected) {
    assert.ok(process.env.GH_TOKEN, 'Release requires Actions read permission');
    execFileSync(process.execPath, ['scripts/verify-release-source.mjs'], {
      cwd:root,env:{...process.env,CODEXIA_COMMIT_RELEASE:'1'},stdio:'inherit',timeout:120_000,
    });
  }
  const output = 'affected=' + String(affected) + '\nsource-sha=' + checkoutSha +
    '\nverify-run-id=' + run.id + '\n';
  appendFileSync(process.env.GITHUB_OUTPUT,output);
  console.log(JSON.stringify({component,affected,sourceSha:checkoutSha,verifyRunId:run.id,
    ...(successor ? {skipped:'superseded by a newer component change',successor} : {})}));
};
if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error));process.exitCode=1; });
}
