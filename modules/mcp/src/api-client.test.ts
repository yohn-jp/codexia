import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChangeOperation, ProjectObservation, SnapshotId } from '@codexia/contracts';
import { ApiClient, actionClientFromContext } from './api-client.js';

const snapshot: SnapshotId = {
  projectId: 'repo-one',
  projectVersion: 12,
};

test('stdio API client uses bearer actions and host-sourced proposals only', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const observation: ProjectObservation = {
    snapshot,
    observedAt: '2026-10-17T00:00:00.000Z',
    state: 'fresh',
  };
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/actions')) {
      return Response.json({ actions: [{ id: 'core.status', module: 'core', effect: 'read' }] });
    }
    if (url.endsWith('/observation')) return Response.json(observation);
    if (url.endsWith('/proposals')) {
      return Response.json({ id: 'proposal-1', snapshot, operations: [], source: 'mcp' });
    }
    if (url.endsWith('/actions/core.status')) {
      return Response.json({ ok: true, snapshot, data: { status: 'ready' } });
    }
    return Response.json({ error: 'missing' }, { status: 404 });
  };
  const client = new ApiClient({
    baseUrl: 'https://codexia.test/',
    token: 'test-token',
    projectId: 'project-one',
    fetch: fetcher,
  });

  assert.deepEqual(await client.listActions(), [{ id: 'core.status', module: 'core', effect: 'read' }]);
  assert.deepEqual(await client.forProject('project-two').listActions(), [{ id: 'core.status', module: 'core', effect: 'read' }]);
  assert.deepEqual(await client.invoke('core.status', {}), { ok: true, snapshot, data: { status: 'ready' } });
  const operation = { id: 'op-one' } as ChangeOperation;
  const proposal = await client.propose([operation], undefined, 'source-change-set-1');

  assert.equal(proposal.source, 'mcp');
  assert.deepEqual(
    calls.map(call => new URL(call.url).pathname),
    [
      '/api/projects/project-one/actions',
      '/api/projects/project-two/actions',
      '/api/projects/project-one/actions/core.status',
      '/api/projects/project-one/observation',
      '/api/projects/project-one/proposals',
    ],
  );
  for (const call of calls) {
    assert.equal(new Headers(call.init.headers).get('authorization'), 'Bearer test-token');
  }
  const body = JSON.parse(String(calls.at(-1)?.init.body)) as Record<string, unknown>;
  assert.deepEqual(body, { id: 'source-change-set-1', snapshot, operations: [operation] });
  assert.equal('source' in body, false);
});

test('stdio API client follows bounded project pages', async () => {
  const calls: string[] = [];
  const cursor = Buffer.from(
    JSON.stringify({ updatedAt: '2026-11-20T00:00:00.000Z', id: '00000000-0000-4000-8000-000000000001' }),
  ).toString('base64url');
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    calls.push(url);
    const query = new URL(url).searchParams;
    if (query.get('cursor') === cursor) return Response.json({ projects: [{ id: 'project-two', title: 'Two' }], nextCursor: null });
    return Response.json({ projects: [{ id: 'project-one', title: 'One' }], nextCursor: cursor });
  };
  const client = new ApiClient({ baseUrl: 'https://codexia.test', token: 'test-token', fetch: fetcher });
  const first = await client.listProjectPage(1);
  assert.deepEqual(first.projects, [{ id: 'project-one', title: 'One' }]);
  assert.equal(first.nextCursor, cursor);
  const second = await client.listProjectPage(1, first.nextCursor ?? undefined);
  assert.deepEqual(second, { projects: [{ id: 'project-two', title: 'Two' }], nextCursor: null });
  assert.equal(new URL(calls[0]!).pathname, '/api/projects');
  assert.equal(new URL(calls[0]!).searchParams.has('page'), false);
  assert.equal(new URL(calls[0]!).searchParams.get('limit'), '1');
  assert.equal(new URL(calls[1]!).searchParams.get('cursor'), cursor);
});

test('project discovery rejects a bare array emitted by the host', async () => {
  const legacy = new ApiClient({
    baseUrl: 'https://codexia.test',
    token: 'test-token',
    fetch: async () => Response.json([{ id: 'project-one', title: 'One' }]),
  });
  await assert.rejects(legacy.listProjectPage(), { code: 'INVALID_RESPONSE', status: 502 });
});

test('project discovery rejects an empty continuation emitted by the host', async () => {
  const client = new ApiClient({
    baseUrl: 'https://codexia.test',
    token: 'test-token',
    fetch: async () => Response.json({ projects: [{ id: 'project-one', title: 'One' }], nextCursor: '' }),
  });

  await assert.rejects(client.listProjectPage(1), { code: 'INVALID_RESPONSE', status: 502 });
});

test('stdio API client preserves OAuth rejection codes without a credential fallback', async () => {
  for (const { status, code } of [
    { status: 401, code: 'OAUTH_TOKEN_INVALID' },
    { status: 401, code: 'OAUTH_TOKEN_INACTIVE' },
    { status: 403, code: 'OAUTH_MCP_SCOPE_REQUIRED' },
  ]) {
    const authorizations: Array<string | null> = [];
    const client = new ApiClient({
      baseUrl: 'https://codexia.test',
      token: 'test-access-token',
      projectId: 'project-one',
      fetch: async (_url, init) => {
        authorizations.push(new Headers(init?.headers).get('authorization'));
        return Response.json({ error: { code, message: 'Access token rejected' } }, { status });
      },
    });

    await assert.rejects(client.listActions(), { status, code });
    assert.deepEqual(authorizations, ['Bearer test-access-token']);
  }
});

test('stdio API client cancels in-flight discovery and invocation requests', { timeout: 2_000 }, async () => {
  const fetcher: typeof fetch = async (_input, init = {}) => {
    const signal = init.signal;
    assert.ok(signal, 'the pending request needs a cancellation signal');
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const client = new ApiClient({
    baseUrl: 'https://codexia.test',
    token: 'test-token',
    projectId: 'project-one',
    fetch: fetcher,
  });
  const controller = new AbortController();
  const discovery = client.listActions(controller.signal);
  const invocation = client.invoke('core.status', {}, controller.signal);
  const canceled = new Error('MCP caller canceled');
  controller.abort(canceled);

  await Promise.all([assert.rejects(discovery, error => error === canceled), assert.rejects(invocation, error => error === canceled)]);
});

test('authorized Core action client preserves the SDK request cancellation signal', async () => {
  const signal = new AbortController().signal;
  const seen: AbortSignal[] = [];
  const client = actionClientFromContext({
    projectId: 'project-one',
    async listActions(receivedSignal) {
      seen.push(receivedSignal!);
      return [];
    },
    async invoke(_actionId, _input, receivedSignal) {
      seen.push(receivedSignal!);
      return { ok: true, snapshot, data: {} };
    },
    async propose(_operations, _evidence, _proposalId, receivedSignal) {
      seen.push(receivedSignal!);
      return { id: 'proposal-one', snapshot, operations: [], source: 'mcp' };
    },
  });

  await client.listActions(signal);
  await client.invoke('core.status', {}, signal);
  await client.propose([] as ChangeOperation[], undefined, undefined, signal);
  assert.deepEqual(seen, [signal, signal, signal]);
});
