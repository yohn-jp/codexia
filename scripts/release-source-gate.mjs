#!/usr/bin/env node
// A completed, exact-source Verify main run authorizes one component release.
// Never poll on a runner, execute PR code, or publish a superseded main source.
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

const main = async () => {
  const [component, ...rest] = process.argv.slice(2);
  assert.ok(['frontend','backend'].includes(component) && rest.length === 0, 'Specify frontend or backend');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const git = (...args) => execFileSync('git', args, { cwd:root, encoding:'utf8', timeout:15_000 });
  const checkoutSha = git('rev-parse','HEAD').trim();
  const run = verifiedReleaseEvent(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')),process.env,checkoutSha);
  const remoteMain = git('ls-remote','origin','refs/heads/main').trim().split(/\s+/u)[0];
  assert.match(remoteMain ?? '', /^[a-f0-9]{40}$/u, 'Cannot establish current main HEAD');
  let affected = false;
  if (remoteMain === checkoutSha) {
    // Main merge commits use first-parent history, matching the original push change.
    const firstParent = git('rev-parse', 'HEAD^').trim();
    assert.match(firstParent, /^[a-f0-9]{40}$/u);
    const files = git('diff','--name-only','--no-renames','-z',firstParent,checkoutSha,'--').split('\0').filter(Boolean);
    affected = componentReleaseAffected(component, files);
    if (affected) {
      assert.ok(process.env.GH_TOKEN, 'Release requires Actions read permission');
      execFileSync(process.execPath, ['scripts/verify-release-source.mjs'], {
        cwd:root,env:{...process.env,CODEXIA_COMMIT_RELEASE:'1'},stdio:'inherit',timeout:120_000,
      });
    }
  }
  const output = 'affected=' + String(affected) + '\nsource-sha=' + checkoutSha +
    '\nverify-run-id=' + run.id + '\n';
  appendFileSync(process.env.GITHUB_OUTPUT,output);
  console.log(JSON.stringify({component,affected,sourceSha:checkoutSha,verifyRunId:run.id,
    ...(remoteMain !== checkoutSha ? {skipped:'superseded main HEAD'} : {})}));
};
if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error));process.exitCode=1; });
}
