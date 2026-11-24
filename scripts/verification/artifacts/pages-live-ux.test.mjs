import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { verifyLiveUx } from './pages-live-ux.mjs';

const base = 'https://yohn-jp.github.io/codexia/';
const sourceSha = 'a'.repeat(40);

test('live Pages proof checks public response revision, route and snapshot bytes', async () => {
  const snapshot = JSON.stringify({ sourceSha });
  const digest = createHash('sha256').update(snapshot).digest('hex');
  const urls = new Map([
    ['/codexia/ux/', '<title>UX Simulator · Codexia</title>'],
    ['/codexia/site-manifest.json', JSON.stringify({ sourceSha, routes: [{ route: '/ux/', sourceSha, coverageStatus: 'partial' }] })],
    ['/codexia/ux/manifest.json', JSON.stringify({ schemaVersion: 2, route: '/ux/', status: 'partial',
      sourceSha, outputs: { 'snapshot.json': digest } })],
    ['/codexia/ux/snapshot.json', snapshot],
  ]);
  const get = async (url, options) => {
    assert.equal(url.origin, new URL(base).origin);
    assert.equal(url.searchParams.get('source'), sourceSha);
    assert.equal(options.redirect, 'error');
    assert.ok(urls.has(url.pathname));
    return new Response(urls.get(url.pathname));
  };
  await verifyLiveUx(base, sourceSha, get);
  urls.set('/codexia/ux/snapshot.json', snapshot + ' ');
  await assert.rejects(verifyLiveUx(base, sourceSha, get), /digest/);
  await assert.rejects(verifyLiveUx('https://other.example/', sourceSha, get), /Unexpected Pages deployment URL/);
});
