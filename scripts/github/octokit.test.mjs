import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHubOctokit as scopedOctokit } from './octokit.mjs';
import { paginateActionsInventory, paginateGitHubArray } from './paginate-actions.mjs';

const createGitHubOctokit = options => scopedOctokit({ repository: 'yohn-jp/codexia', repositoryId: 1450072993, ...options });

function responseFor(url, body, init = {}) {
  const response = Response.json(body, init);
  Object.defineProperty(response, 'url', { value: String(url) });
  return response;
}

test('Octokit refuses API redirects and confines authorization to api.github.com', async () => {
  const requests = [];
  const octokit = createGitHubOctokit({ token: 'private-token', fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(null, { status: 302, headers: { location: 'https://signed-storage.example/archive' } });
  } });

  await assert.rejects(octokit.rest.actions.getWorkflowRun({ owner: 'yohn-jp', repo: 'codexia', run_id: 44 }), /redirects are forbidden/u);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).origin, 'https://api.github.com');
  assert.equal(requests[0].options.redirect, 'manual');
  assert.equal(new Headers(requests[0].options.headers).get('authorization'), 'token private-token');
});

test('Octokit rejects another origin or repository before sending a request', async () => {
  let requestCount = 0;
  const octokit = createGitHubOctokit({ token: 'read-token', fetchImpl: async () => {
    requestCount++;
    return Response.json({});
  } });
  await assert.rejects(octokit.request('GET https://attacker.invalid/repos/yohn-jp/codexia/actions/runs/1'),
    (error) => error.message.startsWith('GitHub REST requests must stay on api.github.com'));
  await assert.rejects(octokit.rest.actions.getWorkflowRun({ owner: 'another-owner', repo: 'codexia', run_id: 1 }), /outside the canonical repository/u);
  assert.equal(requestCount, 0);
});

test('Octokit typed mutations preserve JSON bodies and surfaced API errors', async () => {
  let received;
  const octokit = createGitHubOctokit({ token: 'write-token', fetchImpl: async (url, options) => {
    received = { url: String(url), options };
    if (String(url).endsWith('/actions/runs/45')) return responseFor(url, { message: 'Not Found' }, { status: 404 });
    if (String(url).endsWith('/actions/runs/46')) return responseFor(url, { message: 'Bad credentials' }, { status: 401 });
    return responseFor(url, { ref: 'refs/tags/backend-v1.2.3' });
  } });
  const result = await octokit.rest.git.createRef({ owner: 'yohn-jp', repo: 'codexia',
    ref: 'refs/tags/backend-v1.2.3', sha: 'a'.repeat(40) });
  assert.equal(result.data.ref, 'refs/tags/backend-v1.2.3');
  assert.equal(JSON.parse(received.options.body).sha, 'a'.repeat(40));
  assert.equal(new URL(received.url).pathname, '/repos/yohn-jp/codexia/git/refs');

  await assert.rejects(octokit.rest.actions.getWorkflowRun({ owner: 'yohn-jp', repo: 'codexia', run_id: 45 }), error => error.status === 404);
  await assert.rejects(octokit.rest.actions.getWorkflowRun({ owner: 'yohn-jp', repo: 'codexia', run_id: 46 }), error => error.status === 401);
});

test('Octokit enforces its configured timeout and preserves shorter caller timeouts', async t => {
  for (const [name, options, request] of [
    ['instance timeout', { timeout: 10 }, () => ({})],
    ['caller timeout', { timeout: 1_000 }, () => ({ request: { signal: AbortSignal.timeout(10) } })],
  ]) {
    await t.test(name, async () => {
      const octokit = createGitHubOctokit({ token: 'read-token', ...options, fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })) });
      const keepAlive = setTimeout(() => {}, 100);
      try {
        await assert.rejects(octokit.rest.actions.getWorkflowRun({ owner: 'yohn-jp', repo: 'codexia', run_id: 77, ...request() }), /timeout/iu);
      } finally {
        clearTimeout(keepAlive);
      }
    });
  }
});

test('Octokit Link pagination visits every page and Codexia validates total_count', async () => {
  const requested = [];
  const octokit = createGitHubOctokit({ token: 'read-token', fetchImpl: async url => {
    const parsed = new URL(String(url));
    const page = Number(parsed.searchParams.get('page') ?? '1');
    requested.push(page);
    const jobs = page === 1 ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) : [{ id: 101 }];
    const headers = page === 1 ? { link: '<https://api.github.com/repositories/1450072993/actions/runs/77/jobs?per_page=100&page=2>; rel="next"' } : {};
    return responseFor(url, { total_count: 101, jobs }, { headers });
  } });
  const jobs = await paginateActionsInventory(octokit, octokit.rest.actions.listJobsForWorkflowRun,
    { owner: 'yohn-jp', repo: 'codexia', run_id: 77, filter: 'latest' }, 'jobs');
  assert.deepEqual(requested, [1, 2]);
  assert.equal(jobs.length, 101);
  assert.deepEqual(jobs.slice(-2), [{ id: 100 }, { id: 101 }]);
});

test('Octokit follows repository-ID release pagination without leaving the canonical repository', async () => {
  const requested = [];
  const octokit = createGitHubOctokit({ token: 'read-token', fetchImpl: async (url, options) => {
    const parsed = new URL(String(url));
    requested.push(parsed.href);
    assert.equal(new Headers(options.headers).get('authorization'), 'token read-token');
    assert.equal(options.redirect, 'manual');
    const page = Number(parsed.searchParams.get('page') ?? '1');
    const releases = page === 1 ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) : [{ id: 101 }];
    const headers = page === 1 ? { link: '<https://api.github.com/repositories/1450072993/releases?per_page=100&page=2>; rel="next"' } : {};
    return responseFor(url, releases, { headers });
  } });
  const releases = await paginateGitHubArray(octokit, octokit.rest.repos.listReleases,
    { owner: 'yohn-jp', repo: 'codexia' }, { maxItems: 1999 });
  assert.deepEqual(requested, [
    'https://api.github.com/repos/yohn-jp/codexia/releases?per_page=100',
    'https://api.github.com/repositories/1450072993/releases?per_page=100&page=2',
  ]);
  assert.equal(releases.length, 101);
  assert.deepEqual(releases.at(-1), { id: 101 });
});

test('Octokit rejects foreign numeric repository links and mutations through the canonical numeric alias', async () => {
  let requestCount = 0;
  const octokit = createGitHubOctokit({ token: 'read-token', fetchImpl: async url => {
    requestCount++;
    return responseFor(url, Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })), {
      headers: { link: '<https://api.github.com/repositories/14500729930/releases?per_page=100&page=2>; rel="next"' },
    });
  } });
  await assert.rejects(paginateGitHubArray(octokit, octokit.rest.repos.listReleases,
    { owner: 'yohn-jp', repo: 'codexia' }), /outside the canonical repository/u);
  await assert.rejects(octokit.request('POST https://api.github.com/repositories/1450072993/releases', {}),
    /outside the canonical repository/u);
  await assert.rejects(octokit.request('GET https://attacker.invalid/repositories/1450072993/releases'),
    /must stay on api.github.com/u);
  assert.equal(requestCount, 1);
});

test('Octokit rejects missing or inconsistent pagination and stops on rate limiting', async () => {
  let pageRequests = 0;
  const missingPage = createGitHubOctokit({ token: 'read-token', fetchImpl: async url => {
    pageRequests++;
    return responseFor(url, { total_count: 101, jobs: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) });
  } });
  await assert.rejects(paginateActionsInventory(missingPage, missingPage.rest.actions.listJobsForWorkflowRun,
    { owner: 'yohn-jp', repo: 'codexia', run_id: 77 }, 'jobs'), /Incomplete.*pagination/u);
  assert.equal(pageRequests, 1);

  const malformed = createGitHubOctokit({ token: 'read-token', fetchImpl: async url => responseFor(url, { total_count: '101', jobs: [] }) });
  await assert.rejects(paginateActionsInventory(malformed, malformed.rest.actions.listJobsForWorkflowRun,
    { owner: 'yohn-jp', repo: 'codexia', run_id: 77 }, 'jobs'), /Invalid GitHub pagination count/u);

  let rateLimitRequests = 0;
  const rateLimited = createGitHubOctokit({ token: 'read-token', fetchImpl: async () => {
    rateLimitRequests++;
    return Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '0' } });
  } });
  await assert.rejects(rateLimited.rest.actions.getWorkflowRun({ owner: 'yohn-jp', repo: 'codexia', run_id: 77 }), error => error.status === 403);
  assert.equal(rateLimitRequests, 1);
});

test('Octokit pagination never sends credentials to a foreign linked page', async () => {
  let requestCount = 0;
  const octokit = createGitHubOctokit({ token: 'read-token', fetchImpl: async url => {
    requestCount++;
    return responseFor(url, { total_count: 101, jobs: Array.from({ length: 100 }, (_, index) => ({ id: index })) }, {
      headers: { link: '<https://api.github.com/repos/other-owner/other-repo/actions/runs/77/jobs?per_page=100&page=2>; rel="next"' },
    });
  } });
  await assert.rejects(paginateActionsInventory(octokit, octokit.rest.actions.listJobsForWorkflowRun,
    { owner: 'yohn-jp', repo: 'codexia', run_id: 77 }, 'jobs'), /outside the canonical repository/u);
  assert.equal(requestCount, 1);
});

test('bounded array pagination stops when an inventory exceeds its declared limit', async () => {
  const octokit = createGitHubOctokit({ token: 'read-token', fetchImpl: async url => responseFor(url, [{ id: 1 }, { id: 2 }, { id: 3 }]) });
  await assert.rejects(paginateGitHubArray(octokit, octokit.rest.repos.listReleases,
    { owner: 'yohn-jp', repo: 'codexia' }, { maxItems: 2 }), /exceeds its supported bound/u);
});

test('a fork token stays within its configured repository, including pagination', async () => {
  const paths = [];
  const octokit = createGitHubOctokit({
    repository: 'fork-owner/codexia', repositoryId: 888, token: 'test-token',
    fetchImpl: async url => {
      paths.push(new URL(url).pathname);
      return responseFor(url, {});
    },
  });
  await octokit.rest.repos.get({ owner: 'fork-owner', repo: 'codexia' });
  await octokit.request('GET https://api.github.com/repositories/888/releases');
  await assert.rejects(octokit.rest.git.createRef({
    owner: 'yohn-jp', repo: 'codexia', ref: 'refs/tags/backend-v1.2.3', sha: 'a'.repeat(40),
  }), /outside the canonical repository/u);
  await assert.rejects(octokit.request('GET https://api.github.com/repositories/1450072993/releases'), /outside the canonical repository/u);
  assert.deepEqual(paths, ['/repos/fork-owner/codexia', '/repositories/888/releases']);
});
