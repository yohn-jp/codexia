import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeConsoleReturnLocation, createConsoleReturnLocation, resolveConsoleReturnLocation } from './console-return.js';
import { checkOwnerSession } from './console-session.js';

test('owner session check sends same-origin cookies only and rejects incomplete responses', async () => {
  let request: { input: string | URL | Request; init?: RequestInit } | undefined;
  const response = await checkOwnerSession(async (input, init) => {
    request = { input, init };
    return Response.json({ authenticated: true });
  });
  assert.equal(response, 'owner');
  assert.equal(request?.input, '/api/auth/codexia/owner-session');
  assert.equal(request?.init?.method, 'POST');
  assert.equal(request?.init?.credentials, 'same-origin');
  assert.equal(request?.init?.cache, 'no-store');
  assert.deepEqual(new Headers(request?.init?.headers), new Headers({ accept: 'application/json', 'content-type': 'application/json' }));
  assert.equal(request?.init?.body, '{}');
  assert.equal(new Headers(request?.init?.headers).has('authorization'), false);
  assert.equal(await checkOwnerSession(async () => new Response(null, { status: 401 })), 'unauthorized');
  assert.equal(await checkOwnerSession(async () => new Response(null, { status: 403 })), 'forbidden');
  assert.equal(await checkOwnerSession(async () => new Response(null, { status: 503 })), 'unavailable');
  assert.equal(await checkOwnerSession(async () => Response.json({ authenticated: true, user: { id: 'private' } })), 'unavailable');
  assert.equal(
    await checkOwnerSession(async () => {
      throw new Error('offline');
    }),
    'unavailable',
  );
});

test('console return handoff preserves only a local Desktop path and consumes it once', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const location = createConsoleReturnLocation(
    '/desktop/projects/work/scenes/chapter?panel=editor&code=secret#cursor-2',
    storage,
    () => '11111111-1111-4111-8111-111111111111',
  );
  assert.equal(location, '/console?return=11111111-1111-4111-8111-111111111111');
  const resolved = resolveConsoleReturnLocation('?return=11111111-1111-4111-8111-111111111111', storage);
  assert.deepEqual(resolved, {
    target: '/desktop/projects/work/scenes/chapter?panel=editor#cursor-2',
    id: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(consumeConsoleReturnLocation('?return=11111111-1111-4111-8111-111111111111', storage), resolved.target);
  assert.equal(resolveConsoleReturnLocation('?return=11111111-1111-4111-8111-111111111111', storage).target, '/desktop/');
  assert.equal(resolveConsoleReturnLocation('?return=%2F%2Fattacker.example', storage).target, '/desktop/');
  assert.throws(() => createConsoleReturnLocation('https://attacker.example/desktop', storage), /safe Desktop/u);
});
