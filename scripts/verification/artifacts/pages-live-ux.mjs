import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const published = 'https://yohn-jp.github.io/codexia/';
const sha = /^[a-f0-9]{40}$/u;

export async function verifyLiveUx(pageUrl, sourceSha, get = fetch) {
  assert.equal(pageUrl, published, 'Unexpected Pages deployment URL');
  assert.match(sourceSha, sha, 'Expected the exact GitHub Pages checkout SHA');
  const read = async (path) => {
    const url = new URL(path, pageUrl);
    url.searchParams.set('source', sourceSha);
    const response = await get(url, { redirect: 'error', signal: AbortSignal.timeout(6000) });
    assert.ok(response.ok, 'Published route did not return a successful response: ' + url.pathname);
    return response.text();
  };
  const [html, siteBytes, uxBytes, snapshotBytes] = await Promise.all(
    ['ux/', 'site-manifest.json', 'ux/manifest.json', 'ux/snapshot.json'].map(read));
  assert.match(html, /<title>UX Simulator · Codexia<\/title>/u);
  const site = JSON.parse(siteBytes);
  const ux = JSON.parse(uxBytes);
  const snapshot = JSON.parse(snapshotBytes);
  assert.equal(site.sourceSha, sourceSha, 'Published site still serves another revision');
  assert.equal(ux.sourceSha, sourceSha, 'Published UX manifest still serves another revision');
  assert.equal(snapshot.sourceSha, sourceSha, 'Published UX projection still serves another revision');
  assert.equal(ux.schemaVersion, 2);
  assert.equal(ux.route, '/ux/');
  const route = site.routes.find(({ route }) => route === '/ux/');
  assert.equal(route?.sourceSha, sourceSha, 'Published site is missing the UX route at this revision');
  assert.equal(route.coverageStatus, ux.status);
  assert.equal(createHash('sha256').update(snapshotBytes).digest('hex'), ux.outputs['snapshot.json'],
    'Published UX projection digest differs from its manifest');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , pageUrl, sourceSha] = process.argv;
  assert.equal(pageUrl, published, 'Unexpected Pages deployment URL');
  assert.match(sourceSha, sha, 'Expected the exact GitHub Pages checkout SHA');
  for (let attempt = 1; attempt <= 18; attempt++) {
    try {
      await verifyLiveUx(pageUrl, sourceSha);
      process.stdout.write('Verified public /ux/ for ' + sourceSha + '\n');
      break;
    } catch (error) {
      if (attempt === 18) throw error;
      await delay(5000);
    }
  }
}
