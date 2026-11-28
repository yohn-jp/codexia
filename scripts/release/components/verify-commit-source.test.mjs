import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { REQUIRED_VERIFICATION_JOBS } from '../../ci/impact/contract.mjs';

test('commit publication CLI requires exact main source and the complete successful job set', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'codexia-release-gate-'));
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const mock = path.join(directory, 'fetch.mjs');
    writeFileSync(mock, `
      let calls = 0;
      const empty = () => process.env.WAIT && calls === 1;
      globalThis.fetch = async url => {
        if (process.env.API_ERROR) return new Response('', { status: 503 });
        calls++;
        return Response.json(url.includes('/jobs?') ? {
          total_count: ${REQUIRED_VERIFICATION_JOBS.length},
          jobs: ${JSON.stringify(REQUIRED_VERIFICATION_JOBS)}.map(name => ({
            name, run_id: 1, run_attempt: 2, head_sha: process.env.GITHUB_SHA, status: 'completed', conclusion: name === process.env.FAIL_JOB ? 'failure' : 'success',
          })),
        } : {
          total_count: empty() ? 0 : 1,
          workflow_runs: empty() ? [] : [{
            id: 1, run_attempt: 2, path: '.github/workflows/verify.yml', head_sha: process.env.GITHUB_SHA, head_branch: 'main',
            repository: {full_name: process.env.PROOF_REPOSITORY || process.env.GITHUB_REPOSITORY, id: 100, owner: {id: 50}},
            head_repository: {full_name: process.env.GITHUB_REPOSITORY, id: 100, owner: {id: 50}},
            event: 'push', status: 'completed', conclusion: 'success',
          }],
        });
      };
    `);
    const env = { ...process.env, GH_TOKEN: 'test', GITHUB_REPOSITORY: 'yohn-jp/codexia', GITHUB_REPOSITORY_ID: '100', GITHUB_REPOSITORY_OWNER_ID: '50', GITHUB_SHA: sha, GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main', CODEXIA_COMMIT_RELEASE: '1', CODEXIA_SOURCE_SHA: '', CODEXIA_VERIFY_RUN_ID: '' };
    const run = changes => {
      const result = spawnSync(process.execPath, ['--import', mock, 'scripts/release/components/verify-source.mjs'], { env: { ...env, ...changes }, encoding: 'utf8', timeout: 15_000 });
      assert.ifError(result.error);
      return result;
    };
    assert.equal(run({}).status, 0);
    assert.equal(run({ GITHUB_REPOSITORY: 'fork-owner/codexia' }).status, 0);
    assert.notEqual(run({ GITHUB_REPOSITORY: 'fork-owner/codexia', PROOF_REPOSITORY: 'yohn-jp/codexia' }).status, 0);
    assert.notEqual(run({ GITHUB_REPOSITORY_OWNER_ID: '51' }).status, 0);
    const output = path.join(directory,'verified-source.txt');
    assert.equal(run({ GITHUB_OUTPUT: output }).status, 0);
    assert.equal(existsSync(output), false, 'API-derived run data is not written to a workflow output file');
    assert.notEqual(run({ WAIT: '1' }).status, 0, 'Missing completed Verify proof must fail promptly without polling');
    for (const changes of [{ API_ERROR: '1' }, { FAIL_JOB: 'certification' }, { FAIL_JOB: 'browser-core-ui-v1' }, { GITHUB_SHA: 'a'.repeat(40) }, { GITHUB_REF: 'refs/heads/other' }]) {
      const result = run(changes);
      assert.notEqual(result.status, 0, result.stdout);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
