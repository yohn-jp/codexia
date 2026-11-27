import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EvidenceId, RevisionId } from '@codexia/persistence-contracts';
import { api, setOAuthAccessToken } from './api.js';
import {
  getJobEventsGetUrl,
  getPersistenceDocumentAnchorsGetUrl,
  getPersistenceDocumentsGetUrl,
  getPersistenceStatusGetUrl,
} from './generated/http/client.js';

test('generated persistence status uses the authenticated transport and preserves response errors', async t => {
  const controller = new AbortController();
  let respond = () => Response.json({ available: false, provider: null, future: 'retained' });
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, getPersistenceStatusGetUrl());
    assert.equal(url, '/api/v1/persistence/status');
    assert.equal(init.method, 'GET');
    assert.equal(init.signal, controller.signal);
    assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer short-lived-token');
    return respond();
  });

  setOAuthAccessToken('short-lived-token');
  t.after(() => setOAuthAccessToken(null));
  assert.deepEqual(await api.persistenceStatus(controller.signal), {
    available: false,
    provider: null,
    future: 'retained',
  });

  respond = () => Response.json({ available: false, provider: 'unknown' });
  await assert.rejects(api.persistenceStatus(controller.signal), { status: 502, code: 'INVALID_RESPONSE' });
  respond = () => Response.json({ error: 'Persistence is unavailable', code: 'PERSISTENCE_UNAVAILABLE' }, { status: 503 });
  await assert.rejects(api.persistenceStatus(controller.signal), { status: 503, code: 'PERSISTENCE_UNAVAILABLE' });
  respond = () => {
    throw controller.signal.reason;
  };
  controller.abort();
  await assert.rejects(api.persistenceStatus(controller.signal), error => error === controller.signal.reason);
  assert.equal(fetch.mock.callCount(), 4);
});

test('the generated document list URL preserves Desktop queries and the response boundary', async t => {
  const projectId = 'project/with space?#';
  const parentId = 'volume/with space&';
  const controller = new AbortController();
  const document = {
    id: 'document-1',
    projectId,
    parentId: null,
    kind: 'scene',
    title: 'A scene',
    orderKey: '0001',
    headRevisionId: null,
    version: 2 ** 31,
    createdAt: '2026-11-23T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
    summary: 'retained',
  };
  const list = { documents: [document], future: true };
  let respond = () => Response.json(list);
  const requestedUrls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrls.push(String(input));
    assert.equal(init?.signal, controller.signal);
    assert.equal(init?.credentials, 'omit');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer list-token');
    return respond();
  });
  setOAuthAccessToken('list-token');
  t.after(() => setOAuthAccessToken(null));

  assert.deepEqual(await api.persistenceDocuments(projectId, undefined, controller.signal), list);
  assert.deepEqual(await api.persistenceDocuments(projectId, null, controller.signal), list);
  assert.deepEqual(await api.persistenceDocuments(projectId, parentId, controller.signal), list);

  const root = '/api/v1/persistence/projects/project%2Fwith%20space%3F%23/documents?limit=1000';
  assert.deepEqual(requestedUrls, [root, `${root}&parentId=root`, `${root}&parentId=volume%2Fwith+space%26`]);
  assert.equal(getPersistenceDocumentsGetUrl(projectId, { limit: 1000, parentId }), requestedUrls[2]);

  respond = () => Response.json({ documents: [{ ...document, createdAt: 'not-an-OpenAPI-date' }] });
  await assert.rejects(api.persistenceDocuments(projectId, parentId, controller.signal), { status: 502, code: 'INVALID_RESPONSE' });
  respond = () => Response.json({ documents: [{ ...document, version: -1 }] });
  await assert.rejects(api.persistenceDocuments(projectId, parentId, controller.signal), { status: 502, code: 'INVALID_RESPONSE' });
  respond = () => Response.json({ documents: [{ ...document, version: 0 }] });
  assert.deepEqual(await api.persistenceDocuments(projectId, parentId, controller.signal), { documents: [{ ...document, version: 0 }] });
  respond = () => Response.json({ error: 'Invalid query', code: 'INVALID_QUERY' }, { status: 400 });
  await assert.rejects(api.persistenceDocuments(projectId, parentId, controller.signal), { status: 400, code: 'INVALID_QUERY' });
  assert.equal(requestedUrls.length, 7);
});

test('generated Text Anchor creation preserves the authored request and response invariants', async t => {
  const projectId = 'project/with space';
  const documentId = 'document?with#markers';
  const controller = new AbortController();
  const input = {
    id: 'anchor-1' as EvidenceId,
    revisionId: 'revision-1' as RevisionId,
    fromUtf16: 1,
    toUtf16: 3,
    status: 'confirmed',
    nodeId: 'node-1',
  } as const;
  const anchor = {
    ...input,
    projectId,
    documentId,
    quoteSha256: 'a'.repeat(64),
    version: 1,
    createdAt: '2026-11-23T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
    future: 'retained',
  };
  const result = { anchor, quote: '😀', nodeId: input.nodeId, authorId: 'author-1', future: true };
  let respond = () => Response.json(result, { status: 201 });
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, '/api/v1/persistence/projects/project%2Fwith%20space/documents/document%3Fwith%23markers/anchors');
    assert.equal(init.method, 'POST');
    assert.equal(init.signal, controller.signal);
    assert.equal(init.credentials, 'omit');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Authorization'), 'Bearer anchor-token');
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(String(init.body)), input);
    return respond();
  });
  setOAuthAccessToken('anchor-token');
  t.after(() => setOAuthAccessToken(null));
  const create = () => api.createPersistenceAnchor(projectId, documentId, input, controller.signal);

  assert.deepEqual(await create(), result);
  respond = () => Response.json({ ...result, anchor: { ...anchor, toUtf16: 0 } }, { status: 201 });
  await assert.rejects(create(), { status: 502, code: 'INVALID_RESPONSE' });
  respond = () => Response.json({ ...result, anchor: { ...anchor, createdAt: 'invalid timestamp' } }, { status: 201 });
  await assert.rejects(create(), { status: 502, code: 'INVALID_RESPONSE' });
  respond = () => Response.json({ error: 'Anchor conflict', code: 'PERSISTENCE_CONFLICT' }, { status: 409 });
  await assert.rejects(create(), { status: 409, code: 'PERSISTENCE_CONFLICT' });
  respond = () => {
    throw controller.signal.reason;
  };
  controller.abort();
  await assert.rejects(create(), error => error === controller.signal.reason);
  assert.equal(fetch.mock.callCount(), 5);
});

test('generated job events leave the response stream readable and retain admission errors', async t => {
  const controller = new AbortController();
  const stream = 'data: {"type":"job-status"}\n\n';
  const response = new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  let reply = response;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, getJobEventsGetUrl());
    assert.equal(url, '/api/jobs/events');
    assert.equal(init.method, 'GET');
    assert.equal(init.signal, controller.signal);
    assert.equal(new Headers(init.headers).get('Accept'), 'text/event-stream');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer stream-token');
    assert.equal(init.credentials, 'omit');
    return reply;
  });
  setOAuthAccessToken('stream-token');
  t.after(() => setOAuthAccessToken(null));

  const result = await api.jobEventStream(controller.signal);
  assert.equal(result.bodyUsed, false);
  assert.equal(await result.text(), stream);

  reply = Response.json({ error: 'Busy', code: 'STREAM_BUSY' }, { status: 503 });
  await assert.rejects(api.jobEventStream(controller.signal), { status: 503, code: 'STREAM_BUSY' });
});

test('generated document anchor reads keep the maximum page independent of cancellation', async t => {
  const controller = new AbortController();
  const urls: string[] = [];
  const signals: Array<AbortSignal | null> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    urls.push(url);
    signals.push(init.signal ?? null);
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer anchor-read-token');
    return Response.json({ revisionId: null, anchors: [] });
  });
  setOAuthAccessToken('anchor-read-token');
  t.after(() => setOAuthAccessToken(null));

  await api.persistenceDocumentAnchors('project-1', 'document-1');
  await api.persistenceDocumentAnchors('project-1', 'document-1', 'revision-1', controller.signal);

  assert.deepEqual(urls, [
    getPersistenceDocumentAnchorsGetUrl('project-1', 'document-1', { limit: 500 }),
    getPersistenceDocumentAnchorsGetUrl('project-1', 'document-1', { revision: 'revision-1', limit: 500 }),
  ]);
  assert.deepEqual(urls, [
    '/api/v1/persistence/projects/project-1/documents/document-1/anchors?limit=500',
    '/api/v1/persistence/projects/project-1/documents/document-1/anchors?revision=revision-1&limit=500',
  ]);
  assert.deepEqual(signals, [null, controller.signal]);
});

test('open work download uses generated bearer transport and rejects a truncated ZIP response', async t => {
  let length = '4';
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => {
    assert.equal(url, '/api/v1/persistence/projects/fixture/open-export');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Authorization'), 'Bearer export-token');
    assert.equal(headers.get('Accept'), 'application/zip');
    return Promise.resolve(
      new Response(new Uint8Array([80, 75, 3, 4]), {
        headers: { 'Content-Type': 'application/zip', 'Content-Length': length },
      }),
    );
  });
  setOAuthAccessToken('export-token');
  t.after(() => setOAuthAccessToken(null));
  assert.equal((await api.downloadOpenWorkExport('fixture')).size, 4);
  length = '5';
  await assert.rejects(api.downloadOpenWorkExport('fixture'), { code: 'OPEN_WORK_EXPORT_INCOMPLETE' });
  length = '134217729';
  await assert.rejects(api.downloadOpenWorkExport('fixture'), { code: 'OPEN_WORK_EXPORT_INCOMPLETE' });
});
