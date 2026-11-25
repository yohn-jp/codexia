import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  requestApi,
  requestApiNoContent,
} from './api-transport.js';
import { jobEventsGet } from './generated/http/client.js';

test('API transport preserves RequestInit and uses bearer auth without ambient cookies', async () => {
  const controller = new AbortController();
  let seen: RequestInit | undefined;
  const result = await requestApi(
    (value): value is { ok: true; future?: string } =>
      typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true,
    '/api/data',
    { method: 'PATCH', body: '{}', signal: controller.signal, keepalive: true, headers: new Headers({ 'X-Test': 'yes' }) },
    { auth: 'api' },
    async (_input, init) => {
      seen = init;
      return Response.json({ ok: true, future: 'kept' });
    },
  );
  assert.deepEqual(result, { ok: true, future: 'kept' });
  assert.equal(seen?.method, 'PATCH');
  assert.equal(seen?.body, '{}');
  assert.equal(seen?.signal, controller.signal);
  assert.equal(seen?.keepalive, true);
  const headers = new Headers(seen?.headers);
  assert.equal(headers.get('X-Test'), 'yes');
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(seen?.credentials, 'same-origin');
});

test('same-origin and anonymous routes never forward explicit authorization headers', async () => {
  for (const [path, auth, expectedCredentials] of [
    ['/api/auth/codexia/owner-session', 'same-origin', 'same-origin'],
    ['/api/auth/codexia/auth-methods', 'anonymous', 'omit'],
  ] as const) {
    let seen: RequestInit | undefined;
    await requestApi(
      (value): value is { ok: boolean } =>
        typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean',
      path,
      { method: 'POST', headers: { Authorization: 'Bearer do-not-forward', 'X-Request': 'kept' } },
      { auth },
      async (_input, init) => {
        seen = init;
        return Response.json({ ok: true });
      },
    );
    const headers = new Headers(seen?.headers);
    assert.equal(headers.has('Authorization'), false);
    assert.equal(headers.get('X-Request'), 'kept');
    assert.equal(seen?.credentials, expectedCredentials);
  }
});

test('Codexia auth adapter routes reject implicit API bearer policy', async () => {
  await assert.rejects(
    requestApi(
      (value): value is unknown => true,
      '/api/auth/codexia/owner-session',
      {},
      { auth: 'api' },
      async () => Response.json({}),
    ),
    { code: 'AUTH_TRANSPORT_POLICY_REQUIRED' },
  );
});

test('no-content transport accepts only 204 and preserves other response errors', async () => {
  await requestApiNoContent('/api/projects/p/approvals', {}, { auth: 'api' }, async () => new Response(null, { status: 204 }));
  await assert.rejects(
    requestApiNoContent('/api/projects/p/approvals', {}, { auth: 'api' }, async () => Response.json({}, { status: 200 })),
    { status: 502, code: 'INVALID_RESPONSE' },
  );
  await assert.rejects(
    requestApiNoContent('/api/projects/p/approvals', {}, { auth: 'api' }, async () =>
      Response.json({ error: 'Denied', code: 'FORBIDDEN' }, { status: 403 }),
    ),
    { status: 403, code: 'FORBIDDEN' },
  );
});

test('generated job event operation can return the raw SSE Response', async () => {
  const controller = new AbortController();
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  const body = new ReadableStream<Uint8Array>();
  const response = new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  const stream = await jobEventsGet({
    responseMode: 'raw',
    signal: controller.signal,
    headers: { Accept: 'text/event-stream' },
    fetcher: async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return response;
    },
  });
  assert.equal(stream, response);
  assert.equal(requestedUrl, '/api/jobs/events');
  assert.equal(requestedInit?.signal, controller.signal);
  assert.equal(new Headers(requestedInit?.headers).get('Accept'), 'text/event-stream');
});
