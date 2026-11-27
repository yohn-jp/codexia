import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { verifyLiveUx } from './pages-live-ux.mjs';

const base = 'https://yohn-jp.github.io/codexia/';
const sourceSha = 'a'.repeat(40);

test('[TEST-TRC-07-002] live Pages proof checks public response revision, route and snapshot bytes', async () => {
  const snapshot = JSON.stringify({ sourceSha });
  const html = '<title>UX Simulator · Codexia</title>';
  const traceHtml = '<title>Implementation Traceability · Codexia</title>';
  const publisherExecution = { status: 'IN_PROGRESS', repository: 'yohn-jp/codexia', sourceSha, runId: '42', attempt: 1, job: 'specification', task: 'pages-requirements-trace', runUrl: 'https://github.com/yohn-jp/codexia/actions/runs/42' };
  const trace = { sourceSha, execution: publisherExecution, pagesQualification: { status: 'PENDING_PAGES_PUBLISH', sourceSha, publisher: '.github/workflows/repository-audit.yml', strictDocStaticStaging: 'PASSED', strictDocBrowserAcceptance: 'PASSED', publicUrlConfirmation: 'PENDING', publisherExecution, detail: 'pending' }, qualificationGates: {}, verificationReceipt: { status: 'NOT_AVAILABLE', sourceSha } };
  const traceBytes = JSON.stringify(trace);
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  const site = { sourceSha, routes: [
    { route: '/ux/', sourceSha, coverageStatus: 'partial' },
    { route: '/requirements/traceability/', sourceSha, generationStatus: 'ready' },
  ] };
  const requirements = { sourceSha, pagesQualification: trace.pagesQualification, qualificationGates: trace.qualificationGates,
    verificationReceipt: trace.verificationReceipt, outputs: [
      { name: 'traceability/index.html', bytes: Buffer.byteLength(traceHtml), sha256: digest(traceHtml) },
      { name: 'traceability/traceability.json', bytes: Buffer.byteLength(traceBytes), sha256: digest(traceBytes) },
    ] };
  const urls = new Map([
    ['/codexia/ux/', html],
    ['/codexia/site-manifest.json', JSON.stringify(site)],
    ['/codexia/ux/manifest.json', JSON.stringify({ schemaVersion: 2, route: '/ux/', status: 'partial',
      sourceSha, outputs: { 'index.html': digest(html), 'snapshot.json': digest(snapshot) } })],
    ['/codexia/ux/snapshot.json', snapshot],
    ['/codexia/requirements/traceability/', traceHtml],
    ['/codexia/requirements/traceability/traceability.json', traceBytes],
    ['/codexia/requirements/manifest.json', JSON.stringify(requirements)],
  ]);
  const get = async (url, options) => {
    assert.equal(url.origin, new URL(base).origin);
    assert.equal(url.searchParams.get('source'), sourceSha);
    assert.equal(options.redirect, 'error');
    assert.ok(urls.has(url.pathname));
    return new Response(urls.get(url.pathname));
  };
  await verifyLiveUx(base, sourceSha, get, { repository: 'yohn-jp/codexia', runId: '42', attempt: 1, event: 'push' });
  urls.set('/codexia/ux/snapshot.json', snapshot + ' ');
  await assert.rejects(verifyLiveUx(base, sourceSha, get), /projection digest/);
  urls.set('/codexia/ux/snapshot.json', snapshot);
  urls.set('/codexia/ux/', html + '<p>Older page</p>');
  await assert.rejects(verifyLiveUx(base, sourceSha, get), /page digest/);
  urls.set('/codexia/ux/', html);
  urls.set('/codexia/requirements/traceability/traceability.json', JSON.stringify({ ...trace, sourceSha: 'b'.repeat(40) }));
  await assert.rejects(verifyLiveUx(base, sourceSha, get), /another revision/);
  urls.set('/codexia/requirements/traceability/traceability.json', traceBytes);
  await assert.rejects(verifyLiveUx(base, sourceSha, get, { repository: 'yohn-jp/codexia', runId: '42', attempt: 2, event: 'push' }), /attempt mismatch/);
  await assert.rejects(verifyLiveUx('https://other.example/', sourceSha, get), /Unexpected Pages deployment URL/);
});
