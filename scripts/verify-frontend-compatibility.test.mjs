import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBackendCompatibility, probeLiveDeployment, verifyFrontendCompatibility } from './verify-frontend-compatibility.mjs';

const frontend = { format: 'codexia-frontend-identity/v1', version: '0.1.2', sourceSha: 'a'.repeat(40), profile: 'full', apiEpoch: 1 };
const backend = { name: 'codexia', hosted: false, version: '0.1.3', profile: 'full', apiEpoch: 1 };
const env = { CODEXIA_PUBLIC_ORIGIN: 'https://example.invalid', CODEXIA_ACCESS_CLIENT_ID: 'ci-id', CODEXIA_ACCESS_CLIENT_SECRET: 'test-secret', GITHUB_SHA: frontend.sourceSha };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'cf-ray': 'abcdef-NRT' } });
const allowedPaths = ['/api/version', '/desktop/update-identity.json'];
const normal = (url, options) => {
  assert.equal(url.origin, env.CODEXIA_PUBLIC_ORIGIN);
  assert.equal(options.redirect, 'manual');
  const authenticated = options.headers['CF-Access-Client-Id'] === env.CODEXIA_ACCESS_CLIENT_ID;
  if (!authenticated || !allowedPaths.includes(url.pathname)) return response({}, 403);
  assert.equal(options.headers['CF-Access-Client-Secret'], env.CODEXIA_ACCESS_CLIENT_SECRET);
  return response(url.pathname === '/api/version' ? backend : frontend);
};

test('preflight checks two identities and both anonymous and out-of-scope denial without redirecting', async () => {
  const calls = [];
  const observed = await probeLiveDeployment({ env, checkBoundary: true, fetchImpl: async (url, options) => {
    calls.push([url.pathname, Boolean(options.headers['CF-Access-Client-Id'])]);
    return normal(url, options);
  } });
  assert.deepEqual(observed, { backend, deployed: frontend });
  assert.deepEqual(calls, [['/api/version', true], ['/desktop/update-identity.json', true], ['/api/version', false], ['/desktop/update-identity.json', false], ['/', true], ['/api/ready', true]]);
});
test('preflight reports both independent failures, status and ray without disclosing response or credentials', async () => {
  await assert.rejects(probeLiveDeployment({ env, fetchImpl: async url => response({ secret: env.CODEXIA_ACCESS_CLIENT_SECRET }, url.pathname === '/api/version' ? 403 : 404) }), error => {
    assert.match(error.message, /ACCESS_DENIED: \/api\/version \(HTTP 403, CF-Ray abcdef-NRT\)/);
    assert.match(error.message, /IDENTITY_UNAVAILABLE: \/desktop\/update-identity.json \(HTTP 404/);
    assert.doesNotMatch(error.message, /test-secret|ci-id/);
    return true;
  });
});
test('preflight rejects an unexpectedly accessible non-probe route and anonymous identity', async () => {
  await assert.rejects(probeLiveDeployment({ env, checkBoundary: true, fetchImpl: async (url, options) =>
    url.pathname === '/api/ready' || (url.pathname === '/api/version' && !options.headers['CF-Access-Client-Id']) ? response({}) : normal(url, options) }),
    /ACCESS_BOUNDARY: anonymous request to \/api\/version[\s\S]*ACCESS_BOUNDARY: CI token request to \/api\/ready/);
});
test('release admission still rejects incompatible epoch and skips exact deployed identity', async () => {
  const exact = await verifyFrontendCompatibility({ frontend, env, fetchImpl: async (url, options) => normal(url, options) });
  assert.equal(exact.deploy, false);
  await assert.rejects(verifyFrontendCompatibility({ frontend: { ...frontend, apiEpoch: 2 }, env, fetchImpl: async (url, options) => normal(url, options) }), /API epochs are incompatible/);
});
test('preflight distinguishes redirects, network failures, and invalid JSON', async () => {
  await assert.rejects(probeLiveDeployment({ env, fetchImpl: async url => url.pathname === '/api/version' ? new Response('', { status: 302, headers: { location: 'https://example.invalid/login' } }) : new Response('not JSON') }), /ACCESS_DENIED[\s\S]*IDENTITY_INVALID_JSON/);
  await assert.rejects(probeLiveDeployment({ env, fetchImpl: async () => { throw Error('test-secret'); } }), error => {
    assert.match(error.message, /NETWORK: \/api\/version/);
    assert.doesNotMatch(error.message, /test-secret/);
    return true;
  });
});

test('ordinary navigation redirects cannot prove a denied Access boundary', async () => {
  const fetchImpl = async (url, options) => url.pathname === '/' ? new Response('', { status: 302, headers: { location: '/desktop/' } }) : normal(url, options);
  await assert.rejects(probeLiveDeployment({ env, checkBoundary: true, fetchImpl }), /ACCESS_BOUNDARY: CI token request to \//);
  const accessRedirect = async (url, options) => url.pathname === '/' ? new Response('', { status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/example.invalid' } }) : normal(url, options);
  await probeLiveDeployment({ env, checkBoundary: true, fetchImpl: accessRedirect });
});

test('early preflight can reject the required Full profile and API epoch before an artifact is built', () => {
  assert.doesNotThrow(() => assertBackendCompatibility(backend, 'full', 1));
  assert.throws(() => assertBackendCompatibility(backend, 'core', 1), /Backend profile mismatch/);
  assert.throws(() => assertBackendCompatibility(backend, 'full', 2), /API epochs are incompatible/);
  assert.throws(() => assertBackendCompatibility(backend, 'full', undefined), /Required frontend API epoch is invalid/);
});

test('invalid live identity fields never disclose their values in preflight diagnostics', async () => {
  await assert.rejects(probeLiveDeployment({ env, fetchImpl: async url =>
    response(url.pathname === '/api/version' ? { ...backend, name: 'unexpected-private-value' } : { ...frontend, format: 'another-private-value' })
  }), error => {
    assert.match(error.message, /Live backend identity name is invalid/);
    assert.match(error.message, /Frontend identity format is invalid/);
    assert.doesNotMatch(error.message, /private-value/);
    return true;
  });
});

test('post-deploy identity mismatch does not disclose untrusted additional response fields', async () => {
  await assert.rejects(verifyFrontendCompatibility({
    frontend, env, mode: 'deployed',
    fetchImpl: async () => response({ ...frontend, unexpected: 'private-value' }),
  }), error => {
    assert.match(error.message, /Deployed frontend identity does not match/);
    assert.doesNotMatch(error.message, /private-value/);
    return true;
  });
});

test('interactive edge challenges on identity paths are distinct from Access denial', async () => {
  const challenged = () => new Response('private-body', { status: 403, headers: { 'cf-mitigated': 'challenge', 'cf-ray': 'abcdef-NRT' } });
  await assert.rejects(probeLiveDeployment({ env, fetchImpl: async (url, options) =>
    url.pathname === '/api/version' ? challenged() : normal(url, options)
  }), error => {
    assert.match(error.message, /EDGE_CHALLENGE: \/api\/version/);
    assert.doesNotMatch(error.message, /ACCESS_DENIED|private-body/);
    return true;
  });
  await assert.rejects(probeLiveDeployment({ env, checkBoundary: true, fetchImpl: async (url, options) =>
    url.pathname === '/api/version' && !options.headers['CF-Access-Client-Id'] ? challenged() : normal(url, options)
  }), /EDGE_CHALLENGE: anonymous identity request to \/api\/version/);
  await probeLiveDeployment({ env, checkBoundary: true, fetchImpl: async (url, options) =>
    !allowedPaths.includes(url.pathname) ? challenged() : normal(url, options)
  });
});
