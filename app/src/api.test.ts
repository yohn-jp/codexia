import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, clearNativeApiSession, configureNativeApiSession, setOAuthAccessToken } from './api.js';

function runtimeVersion(profile: 'core' | 'full') {
  return { name: 'codexia', version: '0.1.0', contractVersion: 2, profile, auth: ['oauth-owner', 'oauth-mcp'], runtime: {}, modules: [] };
}

test('browser version stays on the author application endpoint after denial, absence, or network failure', async t => {
  const requests: string[] = [];
  const version = runtimeVersion('full');
  let respond = () => Response.json(version);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(String(input));
    assert.equal(init?.credentials, 'same-origin');
    return respond();
  });

  assert.deepEqual(await api.version(), version);
  for (const [status, code] of [
    [401, 'UNAUTHORIZED'],
    [404, 'NOT_FOUND'],
  ] as const) {
    respond = () => Response.json({ error: 'Version endpoint unavailable', code }, { status });
    await assert.rejects(api.version(), { status, code });
  }
  const networkFailure = new TypeError('Failed to fetch');
  respond = () => {
    throw networkFailure;
  };
  await assert.rejects(api.version(), error => error === networkFailure);
  assert.deepEqual(
    requests,
    Array.from({ length: 4 }, () => '/api/browser/version'),
  );
});

test('OAuth API requests send a bearer token without ambient cookies', async () => {
  const originalFetch = globalThis.fetch;
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    requestInit = init;
    return Response.json(runtimeVersion('core'));
  };
  setOAuthAccessToken('short-lived-api-token');
  try {
    await api.version();
    assert.equal(new Headers(requestInit?.headers).get('Authorization'), 'Bearer short-lived-api-token');
    assert.equal(requestInit?.credentials, 'omit');
  } finally {
    setOAuthAccessToken(null);
    globalThis.fetch = originalFetch;
  }
});

test('OAuth API admission preserves 401, 403, and 503 without refresh or downgrade', async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async (_input, init) => {
    requestCount += 1;
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer api-token');
    return Response.json({ error: 'Denied', code: 'DENIED' }, { status: [401, 403, 503][requestCount - 1] });
  };
  setOAuthAccessToken('api-token');
  try {
    for (const status of [401, 403, 503]) {
      await assert.rejects(api.session(), (error: unknown) => error instanceof Error && 'status' in error && error.status === status);
    }
    assert.equal(requestCount, 3);
  } finally {
    setOAuthAccessToken(null);
    globalThis.fetch = originalFetch;
  }
});

test('native API requests use only the configured HTTPS transport and omit WebView credentials', async () => {
  const nativeCalls: Array<{ url: string; init: RequestInit }> = [];
  const tokenRequests: string[] = [];
  configureNativeApiSession({
    apiOrigin: 'https://api.example.test',
    accessTokenFor: async requestUrl => {
      tokenRequests.push(requestUrl);
      return 'native-api-access-token';
    },
    fetchRequest: async (url, init) => {
      nativeCalls.push({ url, init });
      return Response.json(runtimeVersion('core'));
    },
  });
  try {
    await api.version();
    assert.deepEqual(tokenRequests, ['https://api.example.test/api/version']);
    assert.equal(nativeCalls[0]?.url, 'https://api.example.test/api/version');
    assert.equal(new Headers(nativeCalls[0]?.init.headers).get('Authorization'), 'Bearer native-api-access-token');
    assert.equal(nativeCalls[0]?.init.credentials, 'omit');
  } finally {
    clearNativeApiSession();
  }
});

test('native API requests fail closed when the HTTPS API origin is missing', async () => {
  let calls = 0;
  configureNativeApiSession({
    apiOrigin: null,
    accessTokenFor: async () => {
      throw new Error('must not request a token');
    },
    fetchRequest: async () => {
      calls += 1;
      return Response.json({});
    },
  });
  try {
    await assert.rejects(
      api.session(),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'NATIVE_API_ORIGIN_MISSING',
    );
    assert.equal(calls, 0);
  } finally {
    clearNativeApiSession();
  }
});

test('native job streaming reports unsupported instead of using WebView fetch or retrying forever', async () => {
  let calls = 0;
  configureNativeApiSession({
    apiOrigin: 'https://api.example.test',
    accessTokenFor: async () => 'native-api-token',
    fetchRequest: async () => {
      calls += 1;
      return Response.json({});
    },
  });
  try {
    await assert.rejects(
      api.jobEventStream(new AbortController().signal),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'NATIVE_STREAM_UNSUPPORTED',
    );
    assert.equal(calls, 0);
  } finally {
    clearNativeApiSession();
  }
});

test('browser mutations never retry automatically after authorization or response loss', async t => {
  setOAuthAccessToken('author-token');
  t.after(() => setOAuthAccessToken(null));
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push(path);
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer author-token');
    if (path === '/api/v1/persistence/projects') {
      return Response.json({ error: 'Authentication required', code: 'UNAUTHORIZED' }, { status: 401 });
    }
    assert.equal(path, '/api/inbox/read-all');
    throw new TypeError('connection reset after request send');
  });
  await assert.rejects(api.createPersistenceProject({ title: 'Novel' }), { status: 401, code: 'UNAUTHORIZED' });
  await assert.rejects(api.markAllInboxRead(), { message: 'connection reset after request send' });
  assert.deepEqual(requests, ['/api/v1/persistence/projects', '/api/inbox/read-all']);
});

test('module snapshot requests only the active document revision', async () => {
  const originalFetch = globalThis.fetch;
  const snapshot = { projectId: 'project-1', projectVersion: 12 };
  const documentId = '00000000-0000-4000-8000-000000000001';
  const document = { path: `documents/${documentId}.md`, revision: '1'.repeat(64) };
  try {
    globalThis.fetch = async input => {
      assert.equal(String(input), `/api/projects/project-1/snapshot?projection=editor&documentId=${documentId}`);
      return Response.json({ snapshot, document });
    };
    assert.deepEqual(await api.moduleSnapshot('project-1', documentId), { snapshot, document });
    globalThis.fetch = async input => {
      assert.equal(String(input), '/api/projects/project-1/snapshot?projection=editor');
      return Response.json({ snapshot, document: null });
    };
    assert.deepEqual(await api.moduleSnapshot('project-1'), { snapshot, document: null });
    globalThis.fetch = async () => Response.json({ snapshot, document: { ...document, revision: 'invalid' } });
    await assert.rejects(api.moduleSnapshot('project-1', documentId), { code: 'INVALID_RESPONSE' });
    globalThis.fetch = async () => Response.json({ snapshot, document: { ...document, path: 'documents/another.md' } });
    await assert.rejects(api.moduleSnapshot('project-1', documentId), { code: 'INVALID_RESPONSE' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('module snapshot rejects a bulk file response', async () => {
  const originalFetch = globalThis.fetch;
  const snapshot = { projectId: 'project-1', projectVersion: 12 };
  const documentId = '00000000-0000-4000-8000-000000000002';
  const document = { path: `documents/${documentId}.md`, revision: '2'.repeat(64) };
  globalThis.fetch = async () =>
    Response.json({
      snapshot,
      files: [
        { path: 'meta/project.yaml', revision: '3'.repeat(64), content: 'title: Work' },
        { ...document, content: 'Manuscript' },
      ],
    });
  try {
    await assert.rejects(api.moduleSnapshot('project-1', documentId), { code: 'INVALID_RESPONSE' });
    await assert.rejects(api.moduleSnapshot('project-1'), { code: 'INVALID_RESPONSE' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('module invocations bind the exact PostgreSQL project revision', async () => {
  const originalFetch = globalThis.fetch;
  const snapshot = { projectId: 'project-1', projectVersion: 12 };
  globalThis.fetch = async (_input, options) => {
    assert.deepEqual(JSON.parse(String(options?.body)), { input: { query: 'term' }, snapshot });
    return Response.json({ ok: true, snapshot, data: [] });
  };
  try {
    assert.deepEqual((await api.action('project-1', 'search.query', { query: 'term' }, undefined, snapshot)).snapshot, snapshot);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('document deletion accepts the canonical PostgreSQL response envelope', async () => {
  const originalFetch = globalThis.fetch;
  const document = {
    id: 'document-1',
    projectId: 'project-1',
    parentId: null,
    kind: 'scene',
    title: 'Deleted scene',
    orderKey: '0001',
    headRevisionId: 'revision-1',
    version: 2,
    createdAt: '2026-11-09T00:00:00Z',
    updatedAt: '2026-11-09T00:01:00Z',
  };
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/api/v1/persistence/projects/project-1/documents/document-1');
    assert.equal(init?.method, 'DELETE');
    assert.deepEqual(JSON.parse(String(init?.body)), { expectedVersion: 1 });
    return Response.json({ document }, { status: 200 });
  };
  try {
    assert.deepEqual(await api.deletePersistenceDocument('project-1', 'document-1', 1), { document });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
