import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const published = 'https://yohn-jp.github.io/codexia/';
const sha = /^[a-f0-9]{40}$/u;

export async function verifyLiveUx(pageUrl, sourceSha, get = fetch, publisherExecution = undefined) {
  assert.equal(pageUrl, published, 'Unexpected Pages deployment URL');
  assert.match(sourceSha, sha, 'Expected the exact GitHub Pages checkout SHA');
  const read = async (path) => {
    const url = new URL(path, pageUrl);
    url.searchParams.set('source', sourceSha);
    const response = await get(url, { redirect: 'error', signal: AbortSignal.timeout(6000) });
    assert.ok(response.ok, 'Published route did not return a successful response: ' + url.pathname);
    return response.text();
  };
  const [html, siteBytes, uxBytes, snapshotBytes, traceHtml, traceBytes, requirementsManifestBytes] = await Promise.all(
    ['ux/', 'site-manifest.json', 'ux/manifest.json', 'ux/snapshot.json', 'requirements/traceability/', 'requirements/traceability/traceability.json', 'requirements/manifest.json'].map(read));
  assert.match(html, /<title>UX Simulator · Codexia<\/title>/u);
  const site = JSON.parse(siteBytes);
  const ux = JSON.parse(uxBytes);
  const snapshot = JSON.parse(snapshotBytes);
  const trace = JSON.parse(traceBytes);
  const requirements = JSON.parse(requirementsManifestBytes);
  assert.equal(site.sourceSha, sourceSha, 'Published site still serves another revision');
  assert.equal(ux.sourceSha, sourceSha, 'Published UX manifest still serves another revision');
  assert.equal(snapshot.sourceSha, sourceSha, 'Published UX projection still serves another revision');
  assert.equal(ux.schemaVersion, 2);
  assert.equal(ux.route, '/ux/');
  const route = site.routes.find(({ route }) => route === '/ux/');
  assert.equal(route?.sourceSha, sourceSha, 'Published site is missing the UX route at this revision');
  assert.equal(route.coverageStatus, ux.status);
  assert.equal(createHash('sha256').update(html).digest('hex'), ux.outputs['index.html'],
    'Published UX page digest differs from its manifest');
  assert.equal(createHash('sha256').update(snapshotBytes).digest('hex'), ux.outputs['snapshot.json'],
    'Published UX projection digest differs from its manifest');
  assert.match(traceHtml, /<title>Implementation Traceability · Codexia<\/title>/u);
  assert.equal(trace.sourceSha, sourceSha, 'Published requirements traceability still serves another revision');
  assert.equal(requirements.sourceSha, sourceSha, 'Published requirements manifest still serves another revision');
  assert.deepEqual(trace.pagesQualification, requirements.pagesQualification, 'Published Pages qualification differs from its manifest');
  assert.equal(trace.pagesQualification.status, 'PENDING_PAGES_PUBLISH', 'Published trace must not self-certify its live URL');
  assert.equal(trace.pagesQualification.publicUrlConfirmation, 'PENDING', 'Build artifact must not claim post-deployment confirmation');
  assert.deepEqual(trace.pagesQualification.publisherExecution, trace.execution, 'Published Pages qualification is not bound to its producer execution');
  if (publisherExecution) {
    assert.equal(trace.execution.status, 'IN_PROGRESS', 'Published Pages producer execution is missing');
    assert.equal(trace.execution.repository, publisherExecution.repository, 'Published Pages producer repository mismatch');
    assert.equal(trace.execution.runId, publisherExecution.runId, 'Published Pages producer run mismatch');
    assert.equal(trace.execution.attempt, publisherExecution.attempt, 'Published Pages producer attempt mismatch');
    assert.equal(trace.execution.sourceSha, sourceSha, 'Published Pages producer SHA mismatch');
    assert.equal(publisherExecution.repository, 'yohn-jp/codexia', 'Unexpected Pages producer repository');
    assert.ok(['push', 'workflow_dispatch'].includes(publisherExecution.event), 'Unexpected live Pages event');
  }
  assert.deepEqual(trace.qualificationGates, requirements.qualificationGates, 'Published qualification gates differ from their manifest');
  assert.deepEqual(trace.verificationReceipt, requirements.verificationReceipt, 'Published Verify artifact receipt differs from its manifest');
  const outputByName = new Map(requirements.outputs.map(item => [item.name, item]));
  for (const [name, value] of [['traceability/index.html', traceHtml], ['traceability/traceability.json', traceBytes]]) {
    const output = outputByName.get(name);
    assert.ok(output, `Published requirements manifest is missing ${name}`);
    assert.equal(output.bytes, Buffer.byteLength(value), `Published output size mismatch for ${name}`);
    assert.equal(output.sha256, createHash('sha256').update(value).digest('hex'), `Published output digest mismatch for ${name}`);
  }
  const traceRoute = site.routes.find(({ route }) => route === '/requirements/traceability/');
  assert.equal(traceRoute?.generationStatus, 'ready', 'Published site is missing the traceability route');
  assert.equal(traceRoute.sourceSha, sourceSha, 'Published traceability route source SHA mismatch');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , pageUrl, sourceSha] = process.argv;
  assert.equal(pageUrl, published, 'Unexpected Pages deployment URL');
  assert.match(sourceSha, sha, 'Expected the exact GitHub Pages checkout SHA');
  for (let attempt = 1; attempt <= 18; attempt++) {
    try {
      await verifyLiveUx(pageUrl, sourceSha, fetch, {
        repository: process.env.GITHUB_REPOSITORY,
        runId: process.env.GITHUB_RUN_ID,
        attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        event: process.env.GITHUB_EVENT_NAME,
      });
      process.stdout.write('Verified public /ux/ for ' + sourceSha + '\n');
      break;
    } catch (error) {
      if (attempt === 18) throw error;
      await delay(5000);
    }
  }
}
