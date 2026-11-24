import assert from 'node:assert/strict';
import { Octokit } from '../ci/evidence/github-rest-sdk.mjs';

const API_ORIGIN = 'https://api.github.com';
const CANONICAL_REPOSITORY = 'yohn-jp/codexia';
const PAGE_SIZE = 100;
const ROUTE = /^(GET|POST|PUT|PATCH|DELETE) \/repos\/yohn-jp\/codexia\/[a-zA-Z0-9_./{}-]+(?:\?[^\s]*)?$/u;
const PAGINATION_ROUTE = /^GET \/repos\/yohn-jp\/codexia\/[a-zA-Z0-9_./{}-]+(?:\?[^\s]*)?$/u;

function routeFor(method, endpoint) {
  assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method), 'GitHub REST method is not allowlisted');
  if (typeof endpoint === 'string' && endpoint.startsWith(`${method} `)) {
    const route = endpoint;
    assert.match(route, ROUTE, 'GitHub REST route is not allowlisted');
    return route;
  }
  const url = new URL(endpoint, API_ORIGIN);
  assert.equal(url.origin, API_ORIGIN, 'GitHub REST requests must stay on api.github.com');
  assert.ok(url.pathname.startsWith(`/repos/${CANONICAL_REPOSITORY}/`), 'GitHub REST request is outside the canonical repository');
  return `${method} ${url.pathname}${url.search}`;
}

function responseFromError(error) {
  return error?.response && Number.isSafeInteger(error.status)
    ? error.response
    : null;
}

/**
 * Create the repository-scoped GitHub REST client used by CI and release scripts.
 * Artifact archives are fetched separately by the verified, token-isolated downloader.
 */
export function createGitHubRestClient({ token, fetchImpl = fetch, timeout = 15_000 } = {}) {
  assert.ok(typeof token === 'string' && token.length > 0, 'GitHub REST token is required');
  assert.equal(typeof fetchImpl, 'function', 'GitHub REST fetch implementation is invalid');
  assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 300_000, 'GitHub REST timeout is invalid');

  const guardedFetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, API_ORIGIN, 'GitHub REST requests must stay on api.github.com');
    assert.ok(url.pathname.startsWith(`/repos/${CANONICAL_REPOSITORY}/`), 'GitHub REST request is outside the canonical repository');
    const response = await fetchImpl(input, { ...init, redirect: 'error' });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('GitHub REST redirects are forbidden');
    }
    if (!response.url) Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };

  const octokit = new Octokit({
    auth: token,
    baseUrl: API_ORIGIN,
    userAgent: 'codexia-github-rest',
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    request: { fetch: guardedFetch, timeout },
    retry: { retryCount: 0 },
  });

  return {
    /** @param {string} route @param {Record<string, unknown>} parameters */
    async request(methodOrRoute, endpointOrParameters = {}, parameters = {}) {
      const methodRoute = typeof methodOrRoute === 'string' && /^(?:GET|POST|PUT|PATCH|DELETE) \//u.test(methodOrRoute);
      const route = methodRoute ? methodOrRoute : routeFor(methodOrRoute, endpointOrParameters);
      const requestParameters = methodRoute ? endpointOrParameters : parameters;
      assert.match(route, ROUTE, 'GitHub REST route is not allowlisted');
      try {
        return await octokit.request(route, requestParameters);
      } catch (error) {
        const response = responseFromError(error);
        if (response) return response;
        throw error;
      }
    },

    /**
     * Collect every page through Octokit's Link-header paginator and reject
     * truncated or internally inconsistent Actions inventories.
     * @param {string} route
     * @param {Record<string, unknown>} parameters
     * @param {string | null} itemsKey
     * @param {{ maxItems?: number }} options
     */
    async paginate(route, parameters = {}, itemsKey = null, options = {}) {
      route = routeFor('GET', route);
      assert.match(route, PAGINATION_ROUTE, 'GitHub pagination route is not allowlisted');
      assert.ok(itemsKey === null || (typeof itemsKey === 'string' && itemsKey.length > 0), 'GitHub pagination item key is invalid');
      const maxItems = options.maxItems ?? Number.MAX_SAFE_INTEGER;
      assert.ok(Number.isSafeInteger(maxItems) && maxItems > 0, 'GitHub pagination result limit is invalid');
      const items = [];
      let expectedCount;
      for await (const response of octokit.paginate.iterator(route, { ...parameters, per_page: PAGE_SIZE })) {
        const page = itemsKey === null
          ? response.data
          : Array.isArray(response.data) ? response.data : response.data?.[itemsKey];
        assert.ok(Array.isArray(page), `Invalid GitHub pagination response for ${itemsKey ?? 'array'}`);
        assert.ok(page.length <= PAGE_SIZE, `Invalid GitHub pagination page size for ${itemsKey ?? 'array'}`);
        assert.ok(items.length + page.length <= maxItems, 'GitHub pagination result exceeds its supported bound');
        if (itemsKey !== null) {
          const totalCount = response.data?.total_count ?? page.total_count;
          assert.ok(Number.isSafeInteger(totalCount) && totalCount >= 0, `Invalid GitHub pagination count for ${itemsKey}`);
          if (expectedCount === undefined) expectedCount = totalCount;
          assert.equal(totalCount, expectedCount, `GitHub pagination count changed for ${itemsKey}`);
          assert.equal(page.length, Math.min(PAGE_SIZE, expectedCount - items.length), `Incomplete GitHub pagination response for ${itemsKey}`);
          const linkHeader = response.headers?.link ?? response.headers?.Link ?? response.headers?.get?.('link') ?? '';
          const hasNextPage = /rel\s*=\s*["']next["']/iu.test(linkHeader);
          assert.equal(hasNextPage, items.length + page.length < expectedCount,
            `Incomplete GitHub pagination links for ${itemsKey}`);
        }
        items.push(...page);
      }
      if (itemsKey !== null) assert.equal(items.length, expectedCount, `Incomplete GitHub pagination response for ${itemsKey}`);
      return items;
    },
  };
}
