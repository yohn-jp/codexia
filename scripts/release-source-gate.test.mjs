import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { selectReleaseSource, verifiedReleaseEvent } from './release-source-gate.mjs';

const sha='a'.repeat(40);
const run={id:123,path:'.github/workflows/verify.yml',event:'push',head_branch:'main',
  head_sha:sha,status:'completed',conclusion:'success',
  repository:{full_name:'yohn-jp/codexia'},head_repository:{full_name:'yohn-jp/codexia'}};
const env={GITHUB_EVENT_NAME:'workflow_run',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'yohn-jp/codexia',
  CODEXIA_SOURCE_SHA:sha,CODEXIA_VERIFY_RUN_ID:'123'};

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
  commit('README.md', 'initial');
  const frontend = commit('app/src/source.ts', 'initial frontend');
  const backend = commit('deploy/backend/config.json', 'backend only');
  const unrelated = commit('docs/notes.md', 'documentation');
  assert.equal(selectReleaseSource('frontend', frontend, unrelated, git).affected, true);
  assert.equal(selectReleaseSource('frontend', unrelated, unrelated, git).affected, false);
  assert.equal(selectReleaseSource('backend', backend, unrelated, git).affected, true);

  const updated = commit('app/src/source.ts', 'new frontend');
  const reverted = commit('app/src/source.ts', 'initial frontend');
  assert.equal(selectReleaseSource('frontend', frontend, reverted, git).affected, false);
  assert.equal(selectReleaseSource('frontend', updated, reverted, git).affected, false);
  assert.equal(selectReleaseSource('backend', backend, reverted, git).affected, true);

  git('checkout', '-b', 'fixture', frontend);
  const side = commit('app/src/side.ts', 'unmerged');
  git('checkout', 'main');
  git('merge', '--no-ff', '--no-edit', 'fixture');
  const merged = git('rev-parse', 'HEAD').trim();
  assert.equal(selectReleaseSource('frontend', merged, merged, git).affected, true);
  assert.throws(() => selectReleaseSource('frontend', side, merged, git), /first-parent/);
});
