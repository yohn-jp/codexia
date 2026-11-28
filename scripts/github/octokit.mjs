import { deploymentRepository } from './repository.mjs';
import assert from 'node:assert/strict';
import { Octokit } from '../ci/evidence/github-rest-sdk.mjs';

const API_ORIGIN = 'https://api.github.com';

/** Construct the repository-scoped Octokit instance used by automation scripts. */
export function createGitHubOctokit({ token, repository = process.env.GITHUB_REPOSITORY,
  repositoryId = repository === process.env.GITHUB_REPOSITORY ? process.env.GITHUB_REPOSITORY_ID : undefined,
  fetchImpl = fetch, timeout = 15_000 } = {}) {
  deploymentRepository(repository);
  const repositoryPath = '/repos/' + repository;
  // GitHub can return pagination links that address a repository by its numeric ID.
  if (repositoryId !== undefined) {
    assert.match(String(repositoryId), /^[1-9]\d*$/u, 'Invalid GitHub repository ID');
    assert.ok(Number.isSafeInteger(Number(repositoryId)), 'Invalid GitHub repository ID');
  }
  const repositoryIdPath = repositoryId === undefined ? null : '/repositories/' + repositoryId + '/';
  assert.ok(typeof token === 'string' && token.length > 0, 'GitHub REST token is required');
  assert.equal(typeof fetchImpl, 'function', 'GitHub REST fetch implementation is invalid');
  assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 300_000, 'GitHub REST timeout is invalid');

  const guardedFetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, API_ORIGIN, 'GitHub REST requests must stay on api.github.com');
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const canonicalPath = url.pathname === repositoryPath || url.pathname.startsWith(repositoryPath + '/');
    const canonicalReadAlias = method === 'GET' && repositoryIdPath && url.pathname.startsWith(repositoryIdPath);
    assert.ok(canonicalPath || canonicalReadAlias, 'GitHub REST request is outside the canonical repository');
    const timeoutSignal = AbortSignal.timeout(timeout);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetchImpl(input, { ...init, signal, redirect: 'manual' });
    const artifactDownload = method === 'GET' && canonicalPath &&
      /^\/actions\/artifacts\/[1-9]\d*\/zip$/u.test(url.pathname.slice(repositoryPath.length));
    if (response.status >= 300 && response.status < 400 && !artifactDownload) {
      throw new Error('GitHub REST redirects are forbidden');
    }
    if (!response.url) Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };

  return new Octokit({
    auth: token,
    baseUrl: API_ORIGIN,
    userAgent: 'codexia-github-rest',
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    request: { fetch: guardedFetch },
    retry: { retryCount: 0 },
  });
}
