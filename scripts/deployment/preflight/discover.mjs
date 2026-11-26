import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';
import { selectReleaseSource } from '../../release/components/source-gate.mjs';
import { selectExactMainVerifyRun } from '../../verification/artifacts/frontend.mjs';

const repo = { owner: 'yohn-jp', repo: 'codexia' };
const positive = value => Number.isSafeInteger(value) && value > 0;

// An artifact is only a locator. readLifecycleCandidate independently verifies
// both producers, the archive, the Verify source, OCI contents and compatibility.
export async function discoverPublication(component, { main, history, currentSource, runs, artifacts, jobs, verify }) {
  for (const source of history) {
    if (!currentSource(component, source, main)) break;
    const matches = await runs(component, source);
    // Multiple workflow_run events can share a dispatch head. Only an archive
    // with the requested source and the latest producing job attempt qualifies.
    const candidates = [];
    for (const run of matches) {
      assert.equal(run.head_sha, source);
      assert.equal(run.path, '.github/workflows/' + component + '-release.yml');
      assert.equal(run.event, 'workflow_run');
      assert.equal(run.head_branch, 'main');
      assert.equal(run.repository?.full_name, 'yohn-jp/codexia');
      assert.equal(run.head_repository?.full_name, 'yohn-jp/codexia');
      assert.ok(positive(run.id) && positive(run.run_attempt));
      if (run.status !== 'completed') throw new Error('Release producer is still running');
      const inventory = await artifacts(run.id);
      if (component === 'backend') {
        const name = 'codexia-backend-deployment-certificate-' + source + '-run-' + run.id + '-attempt-' + run.run_attempt;
        if (inventory.some(item => item.name === name)) {
          assert.equal(run.conclusion, 'success');
          candidates.push(run.id);
        }
      } else {
        const producers = (await jobs(run.id)).filter(job => job.name === 'Build and verify UI assets');
        if (!producers.length || producers.every(job => job.conclusion === 'skipped')) continue;
        assert.equal(producers.length, 1);
        const producer = producers[0];
        assert.equal(producer.conclusion, 'success');
        assert.ok(positive(producer.run_attempt));
        const name = 'codexia-frontend-' + source + '-attempt-' + producer.run_attempt;
        const archives = inventory.filter(item => item.name === name);
        assert.equal(archives.length, 1, 'Missing or ambiguous certified UI archive');
        const [archive] = archives;
        assert.equal(archive.expired, false);
        assert.match(archive.digest, /^sha256:[a-f0-9]{64}$/u);
        candidates.push({ runId: run.id, artifactId: archive.id, artifactDigest: archive.digest.slice(7) });
      }
    }
    assert.ok(candidates.length <= 1, 'Ambiguous certified ' + component + ' producers');
    if (candidates.length) {
      return component === 'backend' ? candidates[0] : { ...candidates[0], verifyRunId: await verify(source) };
    }
  }
  throw new Error('No certified ' + component + ' artifact matches current production source');
}

export async function discoverRequest(env, fetchImpl = fetch) {
  const github = createGitHubOctokit({ token: env.GH_TOKEN, fetchImpl, timeout: 30_000 });
  const actions = github.rest.actions;
  const pages = (endpoint, parameters, key) => paginateActionsInventory(github, endpoint, { ...repo, ...parameters }, key);
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 60_000 });
  const main = env.GITHUB_SHA;
  const readers = {
    main, history: git('rev-list', '--first-parent', main).trim().split('\n'),
    currentSource: (component, source) => selectReleaseSource(component, source, main, git, null).affected,
    runs: (component, source) => pages(actions.listWorkflowRuns,
      { workflow_id: component + '-release.yml', head_sha: source, branch: 'main', event: 'workflow_run' }, 'workflow_runs'),
    artifacts: id => pages(actions.listWorkflowRunArtifacts, { run_id: id }, 'artifacts'),
    jobs: id => pages(actions.listJobsForWorkflowRun, { run_id: id, filter: 'latest' }, 'jobs'),
    verify: async source => {
      const runs = await pages(actions.listWorkflowRuns,
        { workflow_id: 'verify.yml', head_sha: source, branch: 'main', event: 'push' }, 'workflow_runs');
      const run = selectExactMainVerifyRun(runs, {
        repository: 'yohn-jp/codexia', repositoryId: Number(env.CODEXIA_REPOSITORY_ID), sourceSha: source,
      });
      assert.equal(run.status, 'completed');
      return run.id;
    },
  };
  const [backendPublisherRunId, frontend] = await Promise.all(
    ['backend', 'frontend'].map(component => discoverPublication(component, readers)));
  const window = env.CODEXIA_WINDOW_START || env.CODEXIA_WINDOW_END
    ? { id: 'preflight-' + env.GITHUB_RUN_ID, notBefore: env.CODEXIA_WINDOW_START, notAfter: env.CODEXIA_WINDOW_END }
    : null;
  return { backendPublisherRunId, frontend, intent: env.CODEXIA_PREFLIGHT_INTENT, window,
    ...(env.CODEXIA_PRIOR_PUBLISHER ? { priorBackendPublisherRunId: Number(env.CODEXIA_PRIOR_PUBLISHER) } : {}) };
}
