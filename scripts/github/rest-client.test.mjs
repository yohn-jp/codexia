import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHubRestClient } from './rest-client.mjs';

const jobsRoute = 'GET /repos/yohn-jp/codexia/actions/runs/{run_id}/jobs';

function responseFor(url, body, init) {
  const response = Response.json(body, init);
  Object.defineProperty(response, 'url', { value: String(url) });
  return response;
}

test('GitHub REST client rejects redirects before credentials can leave api.github.com', async () => {
  const requests = [];
  const client = createGitHubRestClient({
    token: 'private-token',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      const response = new Response(null, {
        status: 302,
        headers: { location: 'https://signed-storage.example/archive' },
      });
      if (options.redirect === 'error') throw new TypeError('redirect mode is error');
      return response;
    },
  });

  await assert.rejects(client.request('GET /repos/yohn-jp/codexia/actions/runs/{run_id}', { run_id: 44 }), /redirect mode is error/u);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).origin, 'https://api.github.com');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(new Headers(requests[0].options.headers).get('authorization'), 'token private-token');
});

test('GitHub REST client scopes metadata to the canonical repository and exposes expected 404 responses', async () => {
  let requestCount = 0;
  const client = createGitHubRestClient({
    token: 'read-token',
    fetchImpl: async url => {
      requestCount++;
      return responseFor(url, { message: 'Not Found' }, { status: 404 });
    },
  });
  const missing = await client.request('GET', '/repos/yohn-jp/codexia/releases/tags/missing');
  assert.equal(missing.status, 404);
  assert.equal(missing.data.message, 'Not Found');
  await assert.rejects(client.request('GET', '/repos/another-owner/codexia/actions/runs/77'), /outside the canonical repository/u);
  assert.equal(requestCount, 1);
});

test('Octokit client preserves JSON request bodies for component release recording', async () => {
  let received;
  const client = createGitHubRestClient({
    token: 'write-token',
    fetchImpl: async (url, options) => {
      received = { url: String(url), options };
      return responseFor(url, { ref: 'refs/tags/backend-v1.2.3' });
    },
  });
  const result = await client.request('POST', '/repos/yohn-jp/codexia/git/refs', {
    data: { ref: 'refs/tags/backend-v1.2.3', sha: 'a'.repeat(40) },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.ref, 'refs/tags/backend-v1.2.3');
  assert.equal(JSON.parse(received.options.body).sha, 'a'.repeat(40));
  assert.equal(new URL(received.url).pathname, '/repos/yohn-jp/codexia/git/refs');
});

test('GitHub REST pagination follows every linked page and verifies total_count', async () => {
  const requestedPages = [];
  const client = createGitHubRestClient({
    token: 'read-token',
    fetchImpl: async url => {
      const page = Number(new URL(url).searchParams.get('page') ?? '1');
      requestedPages.push(page);
      if (page === 1) {
        const jobs = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
        return responseFor(url, { total_count: 101, jobs }, {
          headers: { link: '<https://api.github.com/repos/yohn-jp/codexia/actions/runs/77/jobs?filter=latest&per_page=100&page=2>; rel="next"' },
        });
      }
      return responseFor(url, { total_count: 101, jobs: [{ id: 101 }] });
    },
  });

  const jobs = await client.paginate(jobsRoute, { run_id: 77, filter: 'latest', per_page: 100 }, 'jobs');

  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(jobs.length, 101);
  assert.deepEqual(jobs.slice(-2), [{ id: 100 }, { id: 101 }]);
});

test('GitHub REST pagination rejects a missing linked page and stops on rate limiting', async () => {
  let pageRequests = 0;
  const missingPageClient = createGitHubRestClient({
    token: 'read-token',
    fetchImpl: async url => {
      pageRequests++;
      return responseFor(url, { total_count: 101, jobs: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) });
    },
  });
  await assert.rejects(missingPageClient.paginate(jobsRoute, { run_id: 77, filter: 'latest', per_page: 100 }, 'jobs'), /incomplete.*pagination|pagination.*incomplete/iu);
  assert.equal(pageRequests, 1);

  const malformedClient = createGitHubRestClient({
    token: 'read-token',
    fetchImpl: async url => responseFor(url, { total_count: '101', jobs: [] }),
  });
  await assert.rejects(malformedClient.paginate(jobsRoute, { run_id: 77 }, 'jobs'), /Invalid GitHub pagination count/u);

  let rateLimitRequests = 0;
  const rateLimitClient = createGitHubRestClient({
    token: 'read-token',
    fetchImpl: async () => {
      rateLimitRequests++;
      return Response.json({ message: 'API rate limit exceeded' }, {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'retry-after': '0' },
      });
    },
  });
  await assert.rejects(rateLimitClient.paginate(jobsRoute, { run_id: 77, filter: 'latest', per_page: 100 }, 'jobs'), /403|rate limit/iu);
  assert.equal(rateLimitRequests, 1);
});

test('pagination refuses a next-page link to another repository before sending credentials', async () => {
  let requestCount = 0;
  const client = createGitHubRestClient({
    token: 'read-token',
    fetchImpl: async url => {
      requestCount++;
      return responseFor(url, { total_count: 101, jobs: Array.from({ length: 100 }, (_, index) => ({ id: index })) }, {
        headers: { link: '<https://api.github.com/repos/other-owner/other-repo/actions/runs/77/jobs?per_page=100&page=2>; rel="next"' },
      });
    },
  });
  await assert.rejects(client.paginate(jobsRoute, { run_id: 77 }, 'jobs'), /outside the canonical repository/u);
  assert.equal(requestCount, 1);
});

test('array pagination retains caller-specified inventory bounds', async () => {
  const client = createGitHubRestClient({
    token: 'read-token',
    fetchImpl: async url => responseFor(url, [{ id: 1 }, { id: 2 }, { id: 3 }]),
  });
  await assert.rejects(client.paginate('/repos/yohn-jp/codexia/releases', {}, null, { maxItems: 2 }), /exceeds its supported bound/u);
});
