import assert from 'node:assert/strict';

const PAGE_SIZE = 100;

/** Collect an Octokit paginated array while retaining the caller's inventory bound. */
export async function paginateGitHubArray(octokit, endpoint, parameters = {}, { maxItems = Number.MAX_SAFE_INTEGER } = {}) {
  assert.equal(typeof octokit?.paginate?.iterator, 'function', 'Octokit pagination is required');
  assert.equal(typeof endpoint, 'function', 'Octokit endpoint method is required');
  assert.ok(Number.isSafeInteger(maxItems) && maxItems > 0, 'GitHub pagination result limit is invalid');
  const items = [];
  for await (const response of octokit.paginate.iterator(endpoint, { ...parameters, per_page: PAGE_SIZE })) {
    assert.ok(Array.isArray(response.data), 'Invalid GitHub pagination array response');
    assert.ok(response.data.length <= PAGE_SIZE, 'Invalid GitHub pagination page size');
    assert.ok(items.length + response.data.length <= maxItems, 'GitHub pagination result exceeds its supported bound');
    items.push(...response.data);
  }
  return items;
}

/**
 * Use Octokit's Link-header iterator and validate GitHub Actions' counted list response.
 * @param {import('../ci/evidence/github-rest-sdk.mjs').Octokit} octokit
 * @param {Function} endpoint
 * @param {Record<string, unknown>} parameters
 * @param {string} itemsKey
 * @param {{ maxItems?: number }} options
 */
export async function paginateActionsInventory(octokit, endpoint, parameters, itemsKey, { maxItems = Number.MAX_SAFE_INTEGER } = {}) {
  assert.equal(typeof octokit?.paginate?.iterator, 'function', 'Octokit pagination is required');
  assert.equal(typeof endpoint, 'function', 'Octokit endpoint method is required');
  assert.ok(typeof itemsKey === 'string' && itemsKey.length > 0, 'GitHub pagination item key is invalid');
  assert.ok(Number.isSafeInteger(maxItems) && maxItems > 0, 'GitHub pagination result limit is invalid');

  const items = [];
  let expectedCount;
  for await (const response of octokit.paginate.iterator(endpoint, { ...parameters, per_page: PAGE_SIZE })) {
    const page = response.data;
    assert.ok(Array.isArray(page), `Invalid GitHub pagination response for ${itemsKey}`);
    assert.ok(page.length <= PAGE_SIZE, `Invalid GitHub pagination page size for ${itemsKey}`);
    assert.ok(items.length + page.length <= maxItems, 'GitHub pagination result exceeds its supported bound');
    const totalCount = page.total_count;
    assert.ok(Number.isSafeInteger(totalCount) && totalCount >= 0, `Invalid GitHub pagination count for ${itemsKey}`);
    if (expectedCount === undefined) expectedCount = totalCount;
    assert.equal(totalCount, expectedCount, `GitHub pagination count changed for ${itemsKey}`);
    assert.equal(page.length, Math.min(PAGE_SIZE, expectedCount - items.length), `Incomplete GitHub pagination response for ${itemsKey}`);
    const linkHeader = response.headers?.link ?? response.headers?.Link ?? response.headers?.get?.('link') ?? '';
    const hasNextPage = /rel\s*=\s*["']next["']/iu.test(linkHeader);
    assert.equal(hasNextPage, items.length + page.length < expectedCount,
      `Incomplete GitHub pagination links for ${itemsKey}`);
    items.push(...page);
  }
  assert.equal(items.length, expectedCount, `Incomplete GitHub pagination response for ${itemsKey}`);
  return items;
}
