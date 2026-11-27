import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const published = 'https://yohn-jp.github.io/codexia/';
const sha = /^[a-f0-9]{40}$/u;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function assertPublisher(execution, sourceSha, { repository, runId, producerAttempt, deploymentAttempt, event }) {
  assert.equal(repository, 'yohn-jp/codexia', 'Unexpected Pages producer repository');
  assert.match(runId, /^[1-9][0-9]*$/u, 'Invalid Pages producer run ID');
  assert.ok(['push', 'workflow_dispatch'].includes(event), 'Unexpected live Pages event');
  assert.ok(Number.isSafeInteger(deploymentAttempt) && deploymentAttempt > 0, 'Invalid Pages deployment attempt');
  assert.ok(Number.isSafeInteger(producerAttempt) && producerAttempt > 0 && producerAttempt <= deploymentAttempt,
    'Invalid Pages producer attempt for deployment attempt');
  assert.equal(execution?.status, 'IN_PROGRESS', 'Published Pages producer execution is missing');
  assert.equal(execution.repository, repository, 'Published Pages producer repository mismatch');
  assert.equal(execution.runId, runId, 'Published Pages producer run mismatch');
  assert.equal(execution.attempt, producerAttempt, 'Published Pages producer attempt mismatch');
  assert.equal(execution.sourceSha, sourceSha, 'Published Pages producer SHA mismatch');
  assert.equal(execution.runUrl, `https://github.com/${repository}/actions/runs/${runId}`, 'Published Pages producer URL mismatch');
  assert.equal(execution.job, 'specification', 'Published Pages producer job mismatch');
  assert.equal(execution.task, 'pages-requirements-trace', 'Published Pages producer task mismatch');
}

export function preparePagesDeployment(manifestBytes, sourceSha, publisher) {
  assert.match(sourceSha, sha, 'Expected the exact GitHub Pages checkout SHA');
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.sourceSha, sourceSha, 'Pack requirements manifest source mismatch');
  assertPublisher(manifest.pagesQualification?.publisherExecution, sourceSha, publisher);
  return {
    artifactName: `github-pages-attempt-${publisher.deploymentAttempt}`,
    producerAttempt: publisher.producerAttempt,
    manifestSha256: digest(manifestBytes),
  };
}

export async function verifyLiveUx(pageUrl, sourceSha, get, publisherExecution) {
  assert.equal(pageUrl, published, 'Unexpected Pages deployment URL');
  assert.match(sourceSha, sha, 'Expected the exact GitHub Pages checkout SHA');
  assert.match(publisherExecution?.manifestSha256, /^[a-f0-9]{64}$/u, 'Invalid Pages pack manifest digest');
  const read = async (path) => {
    const url = new URL(path, pageUrl);
    url.searchParams.set('source', sourceSha);
    url.searchParams.set('manifest', publisherExecution.manifestSha256);
    const response = await get(url, { redirect: 'error', signal: AbortSignal.timeout(6000) });
    assert.ok(response.ok, 'Published route did not return a successful response: ' + url.pathname);
    return response.text();
  };
  const [html, siteBytes, uxBytes, snapshotBytes, traceHtml, traceBytes, requirementsManifestBytes] = await Promise.all(
    ['ux/', 'site-manifest.json', 'ux/manifest.json', 'ux/snapshot.json', 'requirements/traceability/', 'requirements/traceability/traceability.json', 'requirements/manifest.json'].map(read));
  assert.equal(digest(requirementsManifestBytes), publisherExecution.manifestSha256, 'Published requirements differ from the pack manifest digest');
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
  assertPublisher(trace.execution, sourceSha, publisherExecution);
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

async function main() {
  const [, , mode, target, source] = process.argv;
  const publisher = {
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    producerAttempt: Number(process.env.PAGES_PRODUCER_ATTEMPT),
    deploymentAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    event: process.env.GITHUB_EVENT_NAME,
  };
  if (mode === 'prepare') {
    const manifest = readFileSync(resolve(target, 'requirements/manifest.json'));
    const inputs = preparePagesDeployment(manifest, source, publisher);
    appendFileSync(process.env.GITHUB_OUTPUT, [
      `artifact-name=${inputs.artifactName}`, `producer-attempt=${inputs.producerAttempt}`,
      `manifest-sha256=${inputs.manifestSha256}`, '',
    ].join('\n'));
    return;
  }
  const [pageUrl, sourceSha] = [mode, target];
  assert.equal(pageUrl, published, 'Unexpected Pages deployment URL');
  assert.match(sourceSha, sha, 'Expected the exact GitHub Pages checkout SHA');
  const manifestSha256 = process.env.PAGES_MANIFEST_SHA256;
  assert.match(manifestSha256, /^[a-f0-9]{64}$/u, 'Invalid Pages pack manifest digest');
  for (let attempt = 1; attempt <= 18; attempt++) {
    try {
      await verifyLiveUx(pageUrl, sourceSha, fetch, { ...publisher, manifestSha256 });
      process.stdout.write('Verified public /ux/ for ' + sourceSha + '\n');
      break;
    } catch (error) {
      if (attempt === 18) throw error;
      await delay(5000);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
