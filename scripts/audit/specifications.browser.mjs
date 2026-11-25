import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '@playwright/test';

test('integrated Pages shows requirements, trace matrix and LikeC4 provenance', async () => {
  const root = path.resolve(process.env.CODEXIA_PAGES_SITE ?? '');
  assert.ok(process.env.CODEXIA_PAGES_SITE, 'CODEXIA_PAGES_SITE is required');
  const registry = JSON.parse(await readFile(path.join(root, 'site-manifest.json'), 'utf8'));
  assert.equal(registry.likec4?.sourceSha, registry.sourceSha);
  assert.equal(registry.likec4?.publication, 'public');
  assert.equal(registry.routes.find(item => item.route === '/requirements/html/')?.generationStatus, 'ready');
  assert.equal(registry.routes.find(item => item.route === '/requirements/traceability/')?.generationStatus, 'ready');
  const types = {'.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json', '.svg':'image/svg+xml'};
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const name = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
    const file = path.resolve(root, `.${decodeURIComponent(name)}`);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try { res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream'); res.end(await readFile(file)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true, executablePath:process.env.CODEXIA_E2E_CHROMIUM});
    const page = await browser.newPage();
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await page.goto(`${base}/`)).status(), 200);
    const link = page.locator('a[href="requirements/html/"]').first();
    assert.equal(await link.count(), 1);
    await link.click();
    assert.match(page.url(), /\/requirements\/html\/$/u);
    assert.ok(await page.getByRole('link', {name:'Development Portal'}).isVisible());
    assert.equal((await page.goto(`${base}/requirements/html/requirements/REQUIREMENT-REGISTER.md-TRACE.html`)).status(), 200);
    assert.match(await page.locator('body').innerText(), /REQ-CORE-001/u);
    assert.equal((await page.goto(`${base}/`)).status(), 200);
    const traceLink = page.locator('a[href="requirements/traceability/"]').first();
    await traceLink.click();
    assert.match(page.url(), /\/requirements\/traceability\/$/u);
    assert.equal((await page.goto(`${base}/requirements/traceability/`)).status(), 200);
    assert.match(await page.getByRole('heading', { name: 'Requirements traceability status' }).innerText(), /Requirements traceability status/u);
    assert.match(await page.locator('body').innerText(), /Reverse surface inventory/u);
    assert.match(await page.locator('body').innerText(), /UNMAPPED|No exact-source run/u);
    const traceResponse = await page.request.get(`${base}/requirements/traceability/traceability.json`);
    assert.equal(traceResponse.status(), 200);
    const trace = await traceResponse.json();
    assert.equal(trace.sourceSha, registry.sourceSha);
    assert.ok(trace.summary.requirementCount > 0 && trace.summary.obligationCount > 0);
    assert.ok(trace.summary.obligationGapCount + trace.summary.reverseGapCount > 0, 'Known gaps must remain visible in the Pages projection');
    assert.ok(trace.requirements.some(item => item.requirementId === 'REQ-TRACE-001'));
    await page.addInitScript(() => {
      window.cspViolations = [];
      document.addEventListener('securitypolicyviolation', event => {
        window.cspViolations.push(event.violatedDirective + ' ' + event.blockedURI);
      });
    });
    const remoteRequests = [];
    page.on('request', request => {
      if (!request.url().startsWith(base + '/') && !request.url().startsWith('data:')) remoteRequests.push(request.url());
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const {id, viewId} of registry.likec4.views) {
      assert.equal((await page.goto(`${base}/architecture/#${id}`)).status(), 200);
      const diagram = page.locator(`likec4-view[view-id="${viewId}"]`);
      await diagram.waitFor();
      await diagram.locator('.react-flow__node').first().waitFor();
      assert.deepEqual(await page.evaluate(() => window.cspViolations), [], 'LikeC4 must satisfy the Atlas CSP');
    }
    assert.deepEqual(errors, [], 'LikeC4 must render without browser errors');
    assert.deepEqual(remoteRequests, [], 'LikeC4 must load without external requests');
    for (const {path: name, sha256} of registry.likec4.outputs) {
      const asset = await page.request.get(`${base}/${name}`);
      assert.equal(asset.status(), 200);
      assert.equal(createHash('sha256').update(await asset.body()).digest('hex'), sha256, `LikeC4 asset digest mismatch: ${name}`);
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
