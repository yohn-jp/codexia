import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';
import { selectReleaseSource } from '../../release/components/source-gate.mjs';
import { selectExactMainVerifyRun } from '../../verification/artifacts/frontend.mjs';

import { actionsRepository, matchesRunRepository } from '../../github/repository.mjs';
const positive = value => Number.isSafeInteger(value) && value > 0;

// An artifact is only a locator. readLifecycleCandidate independently verifies
// both producers, the archive, the Verify source, OCI contents and compatibility.
export async function discoverPublication(component, { main, history, currentSource, runs, artifacts, jobs, verify, context = actionsRepository() }) {
  for (const [dispatchIndex, workflowSha] of history.entries()) {
    if (!currentSource(component, workflowSha, main)) break;
    const matches = await runs(component, workflowSha);
    // The release workflow's main dispatch SHA is distinct from a frontend
    // archive's certified component source. Unrelated later main merges may
    // retain the same tested frontend bytes.
    const candidates = [];
    for (const run of matches) {
      assert.equal(run.head_sha, workflowSha);
      assert.equal(run.path, '.github/workflows/' + component + '-release.yml');
      assert.equal(run.event, 'workflow_run');
      assert.equal(run.head_branch, 'main');
      assert.ok(matchesRunRepository(run, context), 'Release producer repository mismatch');
      assert.ok(positive(run.id) && positive(run.run_attempt));
      if (run.status !== 'completed') throw new Error('Release producer is still running');
      const inventory = await artifacts(run.id);
      if (component === 'backend') {
        const name = 'codexia-backend-deployment-certificate-' + workflowSha + '-run-' + run.id + '-attempt-' + run.run_attempt;
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
        const archives = inventory.flatMap(item => {
          const match = /^codexia-frontend-([a-f0-9]{40})-attempt-([1-9][0-9]*)$/u.exec(item.name ?? '');
          if (!match || Number(match[2]) !== producer.run_attempt) return [];
          // Both revisions must be on the trusted main first-parent chain,
          // with no intervening component change or conflicting producer.
          const sourceIndex = history.indexOf(match[1]);
          if (sourceIndex < dispatchIndex || !currentSource(component, match[1], main)) return [];
          return [{ archive: item, sourceSha: match[1] }];
        });
        assert.equal(archives.length, 1, 'Missing or ambiguous certified UI archive');
        const { archive, sourceSha } = archives[0];
        assert.equal(archive.expired, false);
        assert.ok(positive(archive.id));
        assert.match(archive.digest, /^sha256:[a-f0-9]{64}$/u);
        candidates.push({ runId: run.id, artifactId: archive.id, artifactDigest: archive.digest.slice(7), sourceSha });
      }
    }
    assert.ok(candidates.length <= 1, 'Ambiguous certified ' + component + ' producers');
    if (candidates.length) {
      if (component === 'backend') return candidates[0];
      const { sourceSha, ...selected } = candidates[0];
      return { ...selected, verifyRunId: await verify(sourceSha) };
    }
  }
  throw new Error('No certified ' + component + ' artifact matches current production source');
}

export async function discoverRequest(env, fetchImpl = fetch) {
  const context = actionsRepository(env);
  const { owner, repo } = context;
  const hasWindow = Boolean(env.CODEXIA_WINDOW_ID || env.CODEXIA_WINDOW_START || env.CODEXIA_WINDOW_END);
  if (hasWindow) {
    assert.ok(env.CODEXIA_WINDOW_START && env.CODEXIA_WINDOW_END, 'Both approved window timestamps are required');
    if (env.CODEXIA_PREFLIGHT_INTENT === 'restore') {
      assert.ok(env.CODEXIA_WINDOW_ID, 'Restoration requires the existing approved window ID');
    }
  }
  const github = createGitHubOctokit({ ...context, token: env.GH_TOKEN, fetchImpl, timeout: 30_000 });
  const actions = github.rest.actions;
  const pages = (endpoint, parameters, key) => paginateActionsInventory(github, endpoint, { owner, repo, ...parameters }, key);
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 60_000 });
  const main = env.GITHUB_SHA;
  const readers = {
    main, context, history: git('rev-list', '--first-parent', main).trim().split('\n'),
    currentSource: (component, source) => selectReleaseSource(component, source, main, git, null).affected,
    runs: (component, source) => pages(actions.listWorkflowRuns,
      { workflow_id: component + '-release.yml', head_sha: source, branch: 'main', event: 'workflow_run' }, 'workflow_runs'),
    artifacts: id => pages(actions.listWorkflowRunArtifacts, { run_id: id }, 'artifacts'),
    jobs: id => pages(actions.listJobsForWorkflowRun, { run_id: id, filter: 'latest' }, 'jobs'),
    verify: async source => {
      const runs = await pages(actions.listWorkflowRuns,
        { workflow_id: 'verify.yml', head_sha: source, branch: 'main', event: 'push' }, 'workflow_runs');
      const run = selectExactMainVerifyRun(runs, {
        ...context, sourceSha: source,
      });
      assert.equal(run.status, 'completed');
      return run.id;
    },
  };
  const [backendPublisherRunId, frontend] = await Promise.all(
    ['backend', 'frontend'].map(component => discoverPublication(component, readers)));
  const window = hasWindow
    ? { id: env.CODEXIA_WINDOW_ID || 'preflight-' + env.GITHUB_RUN_ID, notBefore: env.CODEXIA_WINDOW_START, notAfter: env.CODEXIA_WINDOW_END }
    : null;
  return { backendPublisherRunId, frontend, intent: env.CODEXIA_PREFLIGHT_INTENT, window,
    ...(env.CODEXIA_PRIOR_PUBLISHER ? { priorBackendPublisherRunId: Number(env.CODEXIA_PRIOR_PUBLISHER) } : {}) };
}
