import assert from 'node:assert/strict';
import { Octokit } from '../ci/evidence/github-rest-sdk.mjs';

const API_ORIGIN = 'https://api.github.com';
const REPOSITORY_PATH = '/repos/yohn-jp/codexia/';

/** Construct the repository-scoped Octokit instance used by automation scripts. */
export function createGitHubOctokit({ token, fetchImpl = fetch, timeout = 15_000 } = {}) {
  assert.ok(typeof token === 'string' && token.length > 0, 'GitHub REST token is required');
  assert.equal(typeof fetchImpl, 'function', 'GitHub REST fetch implementation is invalid');
  assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 300_000, 'GitHub REST timeout is invalid');

  const guardedFetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, API_ORIGIN, 'GitHub REST requests must stay on api.github.com');
    assert.ok(url.pathname.startsWith(REPOSITORY_PATH), 'GitHub REST request is outside the canonical repository');
    const timeoutSignal = AbortSignal.timeout(timeout);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetchImpl(input, { ...init, signal, redirect: 'manual' });
    const artifactDownload = /^\/repos\/yohn-jp\/codexia\/actions\/artifacts\/[1-9]\d*\/zip$/u.test(url.pathname);
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
