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
    assert.match(await page.getByRole('heading', { name: '実装トレーサビリティ' }).innerText(), /実装トレーサビリティ/u);
    assert.match(await page.locator('body').innerText(), /実装面の逆引き/u);
    assert.match(await page.locator('body').innerText(), /UNMAPPED|No exact-source run/u);
    const traceResponse = await page.request.get(`${base}/requirements/traceability/traceability.json`);
    assert.equal(traceResponse.status(), 200);
    const trace = await traceResponse.json();
    assert.equal(trace.sourceSha, registry.sourceSha);
    assert.ok(trace.summary.requirementCount > 0 && trace.summary.obligationCount > 0);
    assert.ok(trace.summary.obligationGapCount + trace.summary.reverseGapCount > 0, 'Known gaps must remain visible in the Pages projection');
    assert.ok(trace.requirements.some(item => item.requirementId === 'REQ-TRACE-001'));
    assert.equal(trace.summary.evidenceFreshness.sourceSha, registry.sourceSha);
    assert.ok(trace.summary.areaCounts.API.obligationCount > 0);
    assert.equal(trace.referenceAudit.broken.length, 0, 'all declared repository references should resolve');

    const traceSearch = page.getByRole('searchbox', { name: '追跡データを検索' });
    await traceSearch.fill('REQ-OPS-004');
    const requirementRows = page.locator('#obligation-table tbody tr[data-trace-row]');
    assert.equal(await requirementRows.filter({ visible: true }).count(), 1);
    assert.match(await requirementRows.filter({ visible: true }).first().innerText(), /REQ-OPS-004/u);
    assert.match(page.url(), /[?&]q=REQ-OPS-004/u, 'filters should be addressable in the URL');
    await traceSearch.fill('');
    await page.getByLabel('状態').selectOption('EXPLICIT_NOT_IMPLEMENTED');
    const declaredUnimplemented = await requirementRows.filter({ visible: true }).evaluateAll(rows => rows.map(row => row.dataset.search));
    assert.ok(declaredUnimplemented.some(row => row.includes('req-ops-004') || row.includes('req-ops-005') || row.includes('req-ui-006')),
      'explicit implementation declarations should be filterable without changing conformance status');
    await page.getByRole('button', { name: '条件を解除' }).click();
    await page.getByLabel('状態').selectOption('UNMAPPED');
    const unmappedRequirementRows = await page.locator('#requirement-table tbody tr[data-trace-row]').filter({ visible: true }).evaluateAll(rows => rows.map(row => row.textContent));
    assert.ok(unmappedRequirementRows.some(row => /REQ-UI-006|REQ-OPS-004|REQ-OPS-005/u.test(row)),
      'conformance UNMAPPED should filter requirement obligations');
    await page.getByRole('button', { name: '条件を解除' }).click();
    await page.getByLabel('領域').selectOption('API');
    assert.ok(await requirementRows.filter({ visible: true }).count() > 0);
    const visibleAreas = await requirementRows.filter({ visible: true }).evaluateAll(rows => rows.map(row => row.dataset.area));
    assert.ok(visibleAreas.every(area => area === 'API'));
    await page.getByRole('button', { name: '条件を解除' }).click();

    await page.getByLabel('surface種別').selectOption('mcpTool');
    const surfaceRows = page.locator('#surface-table tbody tr[data-trace-row]');
    const visibleSurfaceKinds = await surfaceRows.filter({ visible: true }).evaluateAll(rows => rows.map(row => row.dataset.kind));
    assert.ok(visibleSurfaceKinds.length > 0 && visibleSurfaceKinds.every(kind => kind === 'mcpTool'));
    await page.getByLabel('surface種別').selectOption('');
    await page.getByLabel('状態').selectOption('UNVERIFIED');
    const visibleSurfaceStatuses = await surfaceRows.filter({ visible: true }).evaluateAll(rows => rows.map(row => row.dataset.status.split(/\s+/u)));
    assert.ok(visibleSurfaceStatuses.length > 0 && visibleSurfaceStatuses.every(statuses => statuses.includes('UNVERIFIED')));
    const unverifiedColor = await page.locator('#surface-table .state[data-state="UNVERIFIED"]').first().evaluate(element => getComputedStyle(element).color);
    assert.notEqual(unverifiedColor, 'rgb(120, 223, 180)', 'UNVERIFIED must not use the VERIFIED success color');
    await page.getByRole('button', { name: '条件を解除' }).click();

    await page.getByLabel('状態').selectOption('CANDIDATE_ONLY');
    const candidateRows = await surfaceRows.filter({ visible: true }).evaluateAll(rows => rows.map(row => row.dataset.status.split(/\s+/u)));
    assert.ok(candidateRows.length > 0 && candidateRows.every(statuses => statuses.includes('CANDIDATE_ONLY')));
    await page.getByLabel('状態').selectOption('LINKED');
    const reverseLink = surfaceRows.filter({ visible: true }).locator('a[href^="#obligation-"]').first();
    assert.ok(await reverseLink.count() > 0, 'reverse surface should link to its obligation');
    await reverseLink.click();
    assert.match(page.url(), /#obligation-OBL-REQ-/u);
    assert.equal(await page.getByLabel('状態').inputValue(), '', 'following an obligation link should reveal its filtered destination');
    assert.equal(await page.locator(new URL(page.url()).hash).isVisible(), true);
    const testLink = page.locator('#test-table a[href^="#obligation-"]').first();
    assert.ok(await testLink.count() > 0, 'test execution should link back to its obligation');
    await testLink.click();
    assert.match(page.url(), /#obligation-OBL-REQ-/u);
    const detail = page.locator('#obligation-table details[data-detail]').first();
    assert.ok(await detail.count() > 0);
    await detail.locator('summary').click();
    assert.equal(await detail.evaluate(element => element.open), true);

    await page.setViewportSize({ width: 390, height: 844 });
    const layout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      table: document.querySelector('#obligation-table-scroll').scrollWidth,
      tableViewport: document.querySelector('#obligation-table-scroll').clientWidth,
    }));
    assert.ok(layout.document <= layout.viewport, `Page should avoid body overflow at mobile width: ${JSON.stringify(layout)}`);
    assert.ok(layout.table > layout.tableViewport, 'Dense implementation table should scroll within its labelled region');
    const screenshotDir = process.env.PAGES_SCREENSHOTS || '/tmp';
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, 'requirements-traceability-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
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
      const response = await page.goto(`${base}/architecture/#${id}`);
      if (response) assert.equal(response.status(), 200);
      assert.equal(new URL(page.url()).hash, '#' + id);
      const diagram = page.locator(`likec4-view[view-id="${viewId}"]`);
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
