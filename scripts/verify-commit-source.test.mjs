import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { REQUIRED_VERIFICATION_JOBS } from './ci-contract.mjs';

test('commit publication CLI requires exact main source and the complete successful job set', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'codexia-release-gate-'));
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const mock = path.join(directory, 'fetch.mjs');
    writeFileSync(mock, `
      let calls = 0;
      const empty = () => process.env.TIMEOUT || (process.env.WAIT && calls === 1);
      if (process.env.TIMEOUT) {
        let now = 0;
        Date.now = () => (now += 3600001);
      }
      globalThis.setTimeout = callback => { callback(); };
      globalThis.fetch = async url => {
        if (process.env.API_ERROR) return new Response('', { status: 503 });
        calls++;
        return Response.json(url.includes('/jobs?') ? {
          total_count: ${REQUIRED_VERIFICATION_JOBS.length},
          jobs: ${JSON.stringify(REQUIRED_VERIFICATION_JOBS)}.map(name => ({
            name, status: 'completed', conclusion: name === process.env.FAIL_JOB ? 'failure' : 'success',
          })),
        } : {
          total_count: empty() ? 0 : 1,
          workflow_runs: empty() ? [] : [{
            id: 1, head_sha: process.env.GITHUB_SHA, head_branch: 'main',
            event: 'push', status: 'completed', conclusion: 'success',
          }],
        });
      };
    `);
    const env = { ...process.env, GH_TOKEN: 'test', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: sha, GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main', CODEXIA_COMMIT_RELEASE: '1' };
    const run = changes => spawnSync(process.execPath, ['--import', mock, 'scripts/verify-release-source.mjs'], { env: { ...env, ...changes }, encoding: 'utf8' });
    assert.equal(run({}).status, 0);
    assert.equal(run({ WAIT: '1' }).status, 0);
    for (const changes of [{ TIMEOUT: '1' }, { API_ERROR: '1' }, { FAIL_JOB: 'certification' }, { FAIL_JOB: REQUIRED_VERIFICATION_JOBS[0] }, { GITHUB_SHA: 'a'.repeat(40) }, { GITHUB_REF: 'refs/heads/other' }]) {
      const result = run(changes);
      assert.notEqual(result.status, 0, result.stdout);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
