import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { selectReleaseSource, verifiedReleaseEvent } from './source-gate.mjs';

const sha='a'.repeat(40);
const run={id:123,run_attempt:1,path:'.github/workflows/verify.yml',event:'push',head_branch:'main',
  head_sha:sha,status:'completed',conclusion:'success',
  repository:{full_name:'yohn-jp/codexia', id:100, owner:{id:50}},head_repository:{full_name:'yohn-jp/codexia', id:100, owner:{id:50}}};
const env={GITHUB_EVENT_NAME:'workflow_run',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'yohn-jp/codexia',
  GITHUB_REPOSITORY_ID:'100', GITHUB_REPOSITORY_OWNER_ID:'50', CODEXIA_SOURCE_SHA:sha,CODEXIA_VERIFY_RUN_ID:'123'};

test('only exact successful main Verify completion can authorize a privileged release',()=>{
  assert.equal(verifiedReleaseEvent({workflow_run:run},env,sha),run);
  for(const altered of [
    {event:'pull_request'}, {head_branch:'feature'}, {path:'.github/workflows/other.yml'},
    {head_sha:'b'.repeat(40)}, {status:'in_progress',conclusion:null},
    {conclusion:'failure'}, {repository:{full_name:'attacker/codexia'}},
    {head_repository:{full_name:'attacker/codexia'}}, {id:124},
  ]) assert.throws(()=>verifiedReleaseEvent({workflow_run:{...run,...altered}},env,sha));
  assert.throws(()=>verifiedReleaseEvent({workflow_run:run},{...env,GITHUB_REF:'refs/pull/123/merge'},sha));
  assert.throws(()=>verifiedReleaseEvent({workflow_run:run},env,'b'.repeat(40)));
});

test('full main verification persists the real push boundary as release evidence', t => {
  const directory=mkdtempSync(path.join(tmpdir(),'codexia-verification-boundary-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const eventPath=path.join(directory,'event.json');
  const planPath=path.join(directory,'plan.json');
  const before='b'.repeat(40);
  writeFileSync(eventPath,JSON.stringify({before,after:sha,ref:'refs/heads/main'}));
  execFileSync(process.execPath,[fileURLToPath(new URL('../../ci/impact/plan.mjs',import.meta.url))],{env:{
    ...process.env, CODEXIA_EXPECTED_SHA:sha, CODEXIA_CI_PLAN_PATH:planPath, GITHUB_EVENT_PATH:eventPath,
    GITHUB_EVENT_NAME:'push', GITHUB_OUTPUT:'', GITHUB_STEP_SUMMARY:'',
  }});
  const plan=JSON.parse(readFileSync(planPath,'utf8'));
  assert.equal(plan.base,before);
  assert.equal(plan.sha,sha);
  assert.equal(plan.mode,'full');
  assert.deepEqual(plan.excluded,[]);
});

test('only a newer change to the same component supersedes an affected source', t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'codexia-release-source-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Codexia CI fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const commit = (file, contents) => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), contents);
    git('add', '--', file);
    git('commit', '-m', file);
    return git('rev-parse', 'HEAD').trim();
  };
  const initial = commit('README.md', 'initial');
  const frontend = commit('app/src/source.ts', 'initial frontend');
  const backend = commit('deploy/backend/config.json', 'backend only');
  const unrelated = commit('docs/notes.md', 'documentation');
  assert.equal(selectReleaseSource('frontend', frontend, unrelated, git).affected, true);
  assert.equal(selectReleaseSource('frontend', unrelated, unrelated, git).affected, false);
  assert.equal(selectReleaseSource('backend', unrelated, unrelated, git, frontend).affected, true,
    'A single push may include a backend change before its final documentation commit');
  assert.equal(selectReleaseSource('frontend', unrelated, unrelated, git, frontend).affected, false);
  assert.equal(selectReleaseSource('frontend', unrelated, unrelated, git, null).affected, true,
    'A missing push plan cannot silently drop a release');
  assert.equal(selectReleaseSource('backend', backend, unrelated, git).affected, true);

  const updated = commit('app/src/source.ts', 'new frontend');
  const reverted = commit('app/src/source.ts', 'initial frontend');
  assert.equal(selectReleaseSource('frontend', frontend, reverted, git, initial).affected, true,
    'A later push with no net frontend delta leaves the earlier affected push eligible');
  assert.equal(selectReleaseSource('frontend', reverted, reverted, git, unrelated).affected, false,
    'The later change and revert arrived in a single push with no frontend impact');
  assert.equal(selectReleaseSource('frontend', frontend, updated, git).affected, false);
  assert.equal(selectReleaseSource('frontend', updated, reverted, git).affected, false);
  assert.equal(selectReleaseSource('frontend', reverted, reverted, git, updated).affected, true,
    'A revert pushed separately is itself affected and may release');
  assert.equal(selectReleaseSource('backend', backend, reverted, git).affected, true);

  git('checkout', '-b', 'fixture', frontend);
  const side = commit('app/src/side.ts', 'unmerged');
  git('checkout', 'main');
  git('merge', '--no-ff', '--no-edit', 'fixture');
  const merged = git('rev-parse', 'HEAD').trim();
  assert.equal(selectReleaseSource('frontend', merged, merged, git).affected, true);
  assert.throws(() => selectReleaseSource('frontend', side, merged, git), /first-parent/);
  // A publisher may finish out of order. Run the production entry point with
  // its certified checkout and the main ref fetched inside the deployment job.
  const workflowOutput = path.join(cwd, 'deployment-outputs');
  const summary = path.join(cwd, 'deployment-summary');
  const checkDeployment = (certified, head) => {
    git('checkout', '--detach', certified);
    git('update-ref', 'refs/remotes/origin/main', head);
    writeFileSync(workflowOutput, '');
    execFileSync(process.execPath, [fileURLToPath(new URL('./source-gate.mjs', import.meta.url)), 'backend-deployment'], {
      env: { ...process.env, GIT_DIR: path.join(cwd, '.git'), GIT_WORK_TREE: cwd,
        CODEXIA_VERIFIED_MAIN_SHA: certified, GITHUB_OUTPUT: workflowOutput, GITHUB_STEP_SUMMARY: summary },
    });
    return readFileSync(workflowOutput, 'utf8').trim();
  };
  assert.equal(checkDeployment(frontend, backend), 'current=false');
  assert.match(readFileSync(summary, 'utf8'), /newer backend inputs/u);
  assert.equal(checkDeployment(backend, unrelated), 'current=true');
});
