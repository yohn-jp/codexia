import { deploymentRepository } from '../../github/repository.mjs';
import assert from 'node:assert/strict';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory, paginateGitHubArray } from '../../github/paginate-actions.mjs';

const PROOF_ENDPOINTS = [
  /^actions\/workflows\/verify\.yml$/u,
  /^actions\/workflows\/[1-9]\d*\/runs$/u,
  /^actions\/runs\/[1-9]\d*$/u,
  /^actions\/runs\/[1-9]\d*\/jobs$/u,
  /^actions\/runs\/[1-9]\d*\/artifacts$/u,
  /^actions\/runs\/[1-9]\d*\/attempts\/[1-9]\d*\/jobs$/u,
  /^commits\/[a-f0-9]{40}\/pulls$/u,
  /^pulls\/[1-9]\d*$/u,
];

/** Read-only Octokit access for exact-source evidence reuse, limited to approved API paths. */
export function createGitHubProofClient({ repository, repositoryId, token, request = fetch }) {
  const { owner, repo } = deploymentRepository(repository);
  assert.ok(typeof token === 'string' && token.length > 0, 'GitHub read token is required');
  const octokit = createGitHubOctokit({ token, repository, repositoryId, fetchImpl: request });
  const route = (endpoint, parameters = {}) => {
    const prefix = `/repos/${repository}/`;
    if (typeof endpoint === 'string' && endpoint.startsWith(prefix)) endpoint = endpoint.slice(prefix.length);
    if (typeof endpoint !== 'string' || !PROOF_ENDPOINTS.some(pattern => pattern.test(endpoint))) {
      throw new Error('Unexpected GitHub task proof API endpoint');
    }
    const allowed = endpoint.startsWith('actions/workflows/') && endpoint.endsWith('/runs')
      ? new Set(['head_sha', 'event', 'per_page', 'page'])
      : endpoint.endsWith('/jobs') && endpoint.startsWith('actions/runs/')
        ? new Set(['filter', 'per_page', 'page'])
        : new Set(['per_page', 'page']);
    for (const [key, value] of Object.entries(parameters)) {
      if (!allowed.has(key) || (key === 'head_sha' && !/^[a-f0-9]{40}$/u.test(String(value))) ||
          (key === 'event' && !['push', 'pull_request'].includes(value)) || (key === 'filter' && value !== 'latest') ||
          (['per_page', 'page'].includes(key) && !/^[1-9]\d*$/u.test(String(value)))) {
        throw new Error('Unexpected GitHub task proof API endpoint');
      }
    }
    return endpoint;
  };
  const getResponse = async (endpoint, parameters = {}) => {
    const path = route(endpoint, parameters);
    const run = /^actions\/runs\/([1-9]\d*)$/u.exec(path);
    const workflow = /^actions\/workflows\/([^/]+)$/u.exec(path);
    const pull = /^pulls\/([1-9]\d*)$/u.exec(path);
    if (run) return octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(run[1]) });
    if (workflow) return octokit.rest.actions.getWorkflow({ owner, repo, workflow_id: workflow[1] });
    if (pull) return octokit.rest.pulls.get({ owner, repo, pull_number: Number(pull[1]) });
    throw new Error('Unexpected GitHub task proof API endpoint');
  };
  const get = async endpoint => {
    route(endpoint);
    try {
      return (await getResponse(endpoint)).data;
    } catch (error) {
      const status = Number.isSafeInteger(error?.status) ? `: HTTP ${error.status}` : '';
      throw new Error(`GitHub task proof lookup failed${status}`, { cause: error });
    }
  };
  const paginate = async (endpoint, parameters = {}, itemsKey) => {
    const path = route(endpoint, parameters);
    const workflowRuns = /^actions\/workflows\/([1-9]\d*)\/runs$/u.exec(path);
    const jobs = /^actions\/runs\/([1-9]\d*)\/jobs$/u.exec(path);
    const artifacts = /^actions\/runs\/([1-9]\d*)\/artifacts$/u.exec(path);
    const attemptJobs = /^actions\/runs\/([1-9]\d*)\/attempts\/([1-9]\d*)\/jobs$/u.exec(path);
    const pulls = /^commits\/([a-f0-9]{40})\/pulls$/u.exec(path);
    if (workflowRuns) return paginateActionsInventory(octokit, octokit.rest.actions.listWorkflowRuns,
      { owner, repo, workflow_id: Number(workflowRuns[1]), ...parameters }, itemsKey);
    if (jobs) return paginateActionsInventory(octokit, octokit.rest.actions.listJobsForWorkflowRun,
      { owner, repo, run_id: Number(jobs[1]), ...parameters }, itemsKey);
    if (artifacts) return paginateActionsInventory(octokit, octokit.rest.actions.listWorkflowRunArtifacts,
      { owner, repo, run_id: Number(artifacts[1]), ...parameters }, itemsKey);
    if (attemptJobs) return paginateActionsInventory(octokit, octokit.rest.actions.listJobsForWorkflowRunAttempt,
      { owner, repo, run_id: Number(attemptJobs[1]), attempt_number: Number(attemptJobs[2]), ...parameters }, itemsKey);
    if (pulls) {
      return paginateGitHubArray(octokit, octokit.rest.repos.listPullRequestsAssociatedWithCommit,
        { owner, repo, commit_sha: pulls[1], ...parameters }, { maxItems: 1000 });
    }
    throw new Error('Unexpected GitHub task proof API endpoint');
  };
  // The merged-source resolver accepts a callable request with a pagination method.
  // Bind that contract here so every caller uses the same restricted client.
  return { get: Object.assign(get, { paginate }), paginate };
}
