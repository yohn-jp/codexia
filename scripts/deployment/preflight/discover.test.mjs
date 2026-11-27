import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { discoverPublication, discoverRequest } from './discover.mjs';

const source = 'a'.repeat(40);
const head = 'b'.repeat(40);
function fixture(component) {
  const repo = { full_name: 'yohn-jp/codexia' };
  const run = { id: 41, run_attempt: 2, head_sha: source, path: '.github/workflows/' + component + '-release.yml',
    event: 'workflow_run', head_branch: 'main', repository: repo, head_repository: repo,
    status: 'completed', conclusion: component === 'backend' ? 'success' : 'failure' };
  const archive = { id: 42, expired: false, digest: 'sha256:' + 'd'.repeat(64),
    name: component === 'backend' ? 'codexia-backend-deployment-certificate-' + source + '-run-41-attempt-2'
      : 'codexia-frontend-' + source + '-attempt-1' };
  const readers = {
    main: head, history: [head, source], currentSource: () => true,
    runs: async (_, sha) => sha === head ? [] : [run],
    artifacts: async () => [archive], jobs: async () => [{ name: 'Build and verify UI assets', run_attempt: 1, conclusion: 'success' }],
    verify: async () => 43,
  };
  return { run, archive, readers };
}

test('finds current component source through unrelated newer main changes', async () => {
  assert.equal(await discoverPublication('backend', fixture('backend').readers), 41);
});
test('accepts the certified frontend build when live publication is blocked and binds its actual attempt', async () => {
  assert.deepEqual(await discoverPublication('frontend', fixture('frontend').readers),
    { runId: 41, artifactId: 42, artifactDigest: 'd'.repeat(64), verifyRunId: 43 });
});
test('rejects superseded source, ambiguous jobs, expired artifacts and non-main origin', async () => {
  for (const mutate of [
    f => { f.readers.currentSource = (_, sha) => sha === head; },
    f => { f.readers.runs = async (_, sha) => sha === head ? [] : [f.run, f.run]; },
    f => { f.archive.expired = true; },
    f => { f.run.head_repository = { full_name: 'fork/codexia' }; },
    f => { f.archive.name = 'codexia-frontend-' + source + '-attempt-2'; },
  ]) {
    const f = fixture('frontend');
    mutate(f);
    await assert.rejects(discoverPublication('frontend', f.readers));
  }
});

test('the production REST reader recovers a first-install pair even with an unavailable ordinary frontend', async () => {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const repo = { full_name: 'yohn-jp/codexia', id: 1450072993 };
  const calls = [];
  const fetchImpl = async (input, options) => {
    assert.equal(options.method, 'GET');
    const url = new URL(input);
    const endpoint = url.pathname.slice('/repos/yohn-jp/codexia/actions/'.length);
    calls.push(endpoint);
    let data;
    const workflow = /^workflows\/(frontend-release|backend-release|verify)\.yml\/runs$/u.exec(endpoint);
    if (workflow) {
      const name = workflow[1];
      const verify = name === 'verify';
      assert.equal(url.searchParams.get('head_sha'), sha);
      assert.equal(url.searchParams.get('branch'), 'main');
      assert.equal(url.searchParams.get('event'), verify ? 'push' : 'workflow_run');
      data = { workflow_runs: [{
        id: name === 'backend-release' ? 10 : verify ? 12 : 11, run_number: 8, run_attempt: 2,
        head_sha: sha, head_branch: 'main', repository: repo, head_repository: repo,
        path: '.github/workflows/' + name + '.yml', status: 'completed',
        conclusion: name === 'frontend-release' ? 'failure' : 'success', event: verify ? 'push' : 'workflow_run',
      }] };
    } else if (endpoint === 'runs/11/jobs') {
      assert.equal(url.searchParams.get('filter'), 'latest');
      data = { jobs: [{ name: 'Build and verify UI assets', run_attempt: 1, conclusion: 'success' }] };
    } else if (endpoint === 'runs/10/artifacts' || endpoint === 'runs/11/artifacts') {
      const backend = endpoint === 'runs/10/artifacts';
      const name = backend ? 'codexia-backend-deployment-certificate-' + sha + '-run-10-attempt-2' :
        'codexia-frontend-' + sha + '-attempt-1';
      data = { artifacts: [{ id: 15, name, expired: false, digest: 'sha256:' + 'e'.repeat(64) }] };
    } else assert.fail('Unexpected REST endpoint ' + endpoint);
    return Response.json({ total_count: 1, ...data });
  };
  const request = await discoverRequest({
    GH_TOKEN: 'fixture', CODEXIA_REPOSITORY_ID: String(repo.id), GITHUB_SHA: sha, CODEXIA_PREFLIGHT_INTENT: 'install',
  }, fetchImpl);
  assert.equal(calls.length, 6);
  assert.deepEqual(request, { backendPublisherRunId: 10, frontend: {
    runId: 11, verifyRunId: 12, artifactId: 15, artifactDigest: 'e'.repeat(64),
  }, intent: 'install', window: null });
  const recoveryEnv = {
    GH_TOKEN: 'fixture', CODEXIA_REPOSITORY_ID: String(repo.id), GITHUB_SHA: sha, CODEXIA_PREFLIGHT_INTENT: 'restore',
    CODEXIA_WINDOW_START: '2026-11-24T00:00:00.000Z', CODEXIA_WINDOW_END: '2026-11-24T01:00:00.000Z',
  };
  await assert.rejects(discoverRequest(recoveryEnv, fetchImpl), /existing approved window ID/u);
  const restored = await discoverRequest({ ...recoveryEnv, CODEXIA_WINDOW_ID: 'approved-restoration' }, fetchImpl);
  assert.deepEqual(restored.window, {
    id: 'approved-restoration', notBefore: recoveryEnv.CODEXIA_WINDOW_START, notAfter: recoveryEnv.CODEXIA_WINDOW_END,
  });
});
