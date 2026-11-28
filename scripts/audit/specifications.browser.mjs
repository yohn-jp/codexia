import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '@playwright/test';

test('public trace confirms a deploy retry only for its verified manifest', async (t) => {
  const sourceSha = 'a'.repeat(40);
  const publisher = { status: 'IN_PROGRESS', repository: 'yohn-jp/codexia', sourceSha, runId: '42', attempt: 1,
    job: 'specification', task: 'pages-requirements-trace', runUrl: 'https://github.com/yohn-jp/codexia/actions/runs/42' };
  const pagesQualification = { status: 'PENDING_PAGES_PUBLISH', publicUrlConfirmation: 'PENDING', publisherExecution: publisher };
  const trace = JSON.stringify({ sourceSha, execution: publisher, pagesQualification });
  const html = `<!doctype html><form id="trace-filter"><input name="q"><input name="area"><input name="status"><input name="kind"></form>
    <div id="pages-live-confirmation" data-source-sha="${sourceSha}"><p data-live-status></p></div><script defer src="./traceability-ui.js"></script>`;
  const digest = value => createHash('sha256').update(value).digest('hex');
  const manifest = JSON.stringify({ sourceSha, pagesQualification, outputs: [
    { name: 'traceability/index.html', bytes: Buffer.byteLength(html), sha256: digest(html) },
    { name: 'traceability/traceability.json', bytes: Buffer.byteLength(trace), sha256: digest(trace) },
  ] });
  const origin = 'https://yohn-jp.github.io/codexia';
  const script = await readFile(new URL('./traceability-ui.js', import.meta.url), 'utf8');
  const run = { id: 42, path: '.github/workflows/repository-audit.yml', head_sha: sourceSha, head_branch: 'main',
    event: 'push', status: 'completed', conclusion: 'success', run_attempt: 2, html_url: publisher.runUrl,
    repository: { full_name: publisher.repository }, head_repository: { full_name: publisher.repository } };
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CODEXIA_E2E_CHROMIUM });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const root = '/codexia/requirements/traceability/';
  const site = { sourceSha, routes: [{ route: '/requirements/traceability/', generationStatus: 'ready', sourceSha }] };
  await page.route(`${origin}/**`, route => {
    switch (new URL(route.request().url()).pathname) {
      case root:
      case root + 'index.html': return route.fulfill({ body: html, contentType: 'text/html' });
      case root + 'traceability-ui.js': return route.fulfill({ body: script, contentType: 'text/javascript' });
      case root + 'traceability.json': return route.fulfill({ body: trace, contentType: 'application/json' });
      case '/codexia/requirements/manifest.json': return route.fulfill({ body: manifest, contentType: 'application/json' });
      case '/codexia/site-manifest.json': return route.fulfill({ json: site });
      default: return route.abort();
    }
  });
  let step = { name: `Verify published Pages (${digest(manifest)})`, status: 'completed', conclusion: 'success' };
  let deployAttempt = 2;
  await page.route('https://api.github.com/repos/yohn-jp/codexia/actions/runs/42**', route => {
    const jobs = { total_count: 1, jobs: [{ name: 'deploy', run_id: run.id, run_attempt: deployAttempt,
      head_sha: sourceSha, status: 'completed', conclusion: 'success', steps: [step] }] };
    const response = new URL(route.request().url()).pathname.endsWith('/jobs') ? jobs : run;
    return route.fulfill({ json: response, headers: { 'access-control-allow-origin': '*' } });
  });
  const verifyStatus = async status => {
    await page.goto(`${origin}/requirements/traceability/`);
    await page.locator(`#pages-live-confirmation[data-status="${status}"]`).waitFor({ timeout: 4000 });
  };
  await verifyStatus('confirmed');
  deployAttempt = 1;
  await verifyStatus('pending');
  deployAttempt = 2;
  step = { ...step, name: `Verify published Pages (${digest('prior manifest')})` };
  await verifyStatus('pending');
});

test('integrated Pages shows requirements, trace matrix and LikeC4 provenance', async () => {
  const root = path.resolve(process.env.CODEXIA_PAGES_SITE ?? '');
  assert.ok(process.env.CODEXIA_PAGES_SITE, 'CODEXIA_PAGES_SITE is required');
  const registry = JSON.parse(await readFile(path.join(root, 'site-manifest.json'), 'utf8'));
  assert.deepEqual(registry.designSearch, { version: '1.6.0', sourceSha: registry.sourceSha });
  assert.equal(registry.likec4?.sourceSha, registry.sourceSha);
  assert.equal(registry.likec4?.publication, 'public');
  assert.equal(registry.routes.find(item => item.route === '/requirements/html/')?.generationStatus, 'ready');
  assert.equal(registry.routes.find(item => item.route === '/requirements/traceability/')?.generationStatus, 'ready');
  const types = {'.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json', '.svg':'image/svg+xml'};
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/codexia/')) { res.writeHead(404).end(); return; }
    const pathname = url.pathname.slice('/codexia'.length);
    const name = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
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
    await page.route('https://api.github.com/**', route => route.abort());
    const base = `http://127.0.0.1:${server.address().port}/codexia`;
    assert.equal((await page.goto(`${base}/`)).status(), 200);
    const search = page.getByPlaceholder('設計文書を検索');
    for (const [query, document] of [
      ['資格情報', 'REQUIREMENT-REGISTER.sdoc.html'],
      ['REQ-OPS-004', 'REQUIREMENT-REGISTER.sdoc.html'],
      ['codexiactl', 'CODEXIACTL.sdoc.html'],
    ]) {
      await search.fill(query);
      const result = page.locator(`#design-search .pagefind-ui__result-link[href$="/${document}"]`).first();
      await result.waitFor({ state: 'visible' });
      const target = await result.getAttribute('href');
      assert.equal((await page.request.get(new URL(target, base).toString())).status(), 200);
    }
    await search.fill('資格情報');
    await page.locator('#design-search .pagefind-ui__result-link[href$="/REQUIREMENT-REGISTER.sdoc.html"]').first().click();
    await page.locator('[data-uid="REQ-OPS-004"]').waitFor({state:'attached'});
    assert.equal((await page.goto(`${base}/requirements/html/requirements/REQUIREMENT-REGISTER.md-TRACE.html#REQ-CORE-001`)).status(), 200);
    await page.waitForURL(/REQUIREMENT-REGISTER\.sdoc-TRACE\.html#REQ-CORE-001/u);
    await page.goto(`${base}/`);
    const link = page.locator('a[href="requirements/html/"]').first();
    assert.equal(await link.count(), 1);
    await link.click();
    assert.match(page.url(), /\/requirements\/html\/$/u);
    await page.getByRole('link', { name: 'Development Portal', exact: true }).waitFor({ state: 'visible' });
    assert.equal((await page.goto(`${base}/requirements/html/docs/requirements/REQUIREMENT-REGISTER.sdoc-TRACE.html`)).status(), 200);
    assert.match(await page.locator('body').innerText(), /REQ-CORE-001/u);
    assert.equal((await page.goto(`${base}/`)).status(), 200);
    const traceLink = page.locator('a[href="requirements/traceability/"]').first();
    await traceLink.click();
    assert.match(page.url(), /\/requirements\/traceability\/$/u);
    assert.equal((await page.goto(`${base}/requirements/traceability/`)).status(), 200);
    assert.match(await page.getByRole('heading', { name: '実装トレーサビリティ' }).innerText(), /実装トレーサビリティ/u);
    await page.locator('#pages-live-confirmation[data-status="pending"]').waitFor();
    assert.match(await page.locator('#pages-live-confirmation').innerText(), /Not confirmed for the canonical public URL/u);
    assert.match(await page.locator('section:has(#qualification-gates) table').innerText(), /G7/u);
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
    assert.deepEqual(trace.referenceAudit.broken, [], 'all declared repository references should resolve');

    const traceSearch = page.getByRole('searchbox', { name: '追跡データを検索' });
    await traceSearch.fill('REQ-OPS-004');
    const requirementRows = page.locator('#obligation-table tbody tr[data-trace-row]');
    assert.equal(await requirementRows.filter({ visible: true }).count(), 1);
    assert.match(await requirementRows.filter({ visible: true }).first().innerText(), /REQ-OPS-004/u);
    assert.match(page.url(), /[?&]q=REQ-OPS-004/u, 'filters should be addressable in the URL');
    await traceSearch.fill('');
    await page.getByRole('combobox', { name: '状態', exact: true }).selectOption('EXPLICIT_NOT_IMPLEMENTED');
    const declaredUnimplemented = trace.requirements.filter(item => item.implementationDeclarationStatus === 'EXPLICIT_NOT_IMPLEMENTED');
    const unimplementedObligationIds = declaredUnimplemented.flatMap(item => item.obligationIds).sort();
    assert.ok(unimplementedObligationIds.length > 0, 'published trace must exercise explicit implementation declarations');
    const visibleUnimplementedIds = await requirementRows.filter({ visible: true }).evaluateAll(rows =>
      rows.map(row => row.id.replace(/^obligation-/u, '')).sort());
    assert.deepEqual(visibleUnimplementedIds, unimplementedObligationIds, 'explicit implementation declarations should filter the matching obligations');
    await page.getByRole('button', { name: '条件を解除' }).click();
    await page.getByRole('combobox', { name: '状態', exact: true }).selectOption('UNMAPPED');
    const unmappedRequirementIds = trace.requirements.filter(item => item.conformanceStatus === 'UNMAPPED').map(item => item.requirementId).sort();
    assert.ok(unmappedRequirementIds.length > 0, 'published trace must exercise unmapped conformance');
    const visibleUnmappedIds = await page.locator('#requirement-table tbody tr[data-trace-row] > td:first-child > a')
      .filter({ visible: true }).evaluateAll(links => links.map(link => link.textContent.trim()).sort());
    assert.deepEqual(visibleUnmappedIds, unmappedRequirementIds, 'conformance UNMAPPED should filter the matching requirements');
    await page.getByRole('button', { name: '条件を解除' }).click();
    await page.getByRole('combobox', { name: '領域', exact: true }).selectOption('API');
    assert.ok(await requirementRows.filter({ visible: true }).count() > 0);
    const visibleAreas = await requirementRows.filter({ visible: true }).evaluateAll(rows => rows.map(row => row.dataset.area));
    assert.ok(visibleAreas.every(area => area === 'API'));
    await page.getByRole('button', { name: '条件を解除' }).click();

    await page.getByRole('combobox', { name: 'surface種別', exact: true }).selectOption('mcpTool');
    const surfaceRows = page.locator('#surface-table tbody tr[data-trace-row]');
    const visibleSurfaceKinds = await surfaceRows.filter({ visible: true }).evaluateAll(rows => rows.map(row => row.dataset.kind));
    assert.ok(visibleSurfaceKinds.length > 0 && visibleSurfaceKinds.every(kind => kind === 'mcpTool'));
    await page.getByRole('combobox', { name: 'surface種別', exact: true }).selectOption('');
    await page.getByRole('combobox', { name: '状態', exact: true }).selectOption('MAPPED_UNVERIFIED');
    const visibleSurfaceStatuses = await surfaceRows.filter({ visible: true }).evaluateAll(rows => rows.map(row => row.dataset.status.split(/\s+/u)));
    assert.ok(visibleSurfaceStatuses.length > 0 && visibleSurfaceStatuses.every(statuses => statuses.includes('MAPPED_UNVERIFIED')));
    const unverifiedColor = await page.locator('#surface-table .state[data-state="MAPPED_UNVERIFIED"]').first().evaluate(element => getComputedStyle(element).color);
    assert.notEqual(unverifiedColor, 'rgb(120, 223, 180)', 'MAPPED_UNVERIFIED must not use the VERIFIED success color');
    await page.getByRole('button', { name: '条件を解除' }).click();

    await page.getByRole('combobox', { name: '状態', exact: true }).selectOption('CANDIDATE_ONLY');
    const candidateRows = await surfaceRows.filter({ visible: true }).evaluateAll(rows => rows.map(row => row.dataset.status.split(/\s+/u)));
    assert.ok(candidateRows.length > 0 && candidateRows.every(statuses => statuses.includes('CANDIDATE_ONLY')));
    await page.getByRole('combobox', { name: '状態', exact: true }).selectOption('LINKED');
    const reverseLink = surfaceRows.filter({ visible: true }).locator('a[href^="#obligation-"]').first();
    assert.ok(await reverseLink.count() > 0, 'reverse surface should link to its obligation');
    await reverseLink.click();
    assert.match(page.url(), /#obligation-OBL-REQ-/u);
    assert.equal(await page.getByRole('combobox', { name: '状態', exact: true }).inputValue(), '', 'following an obligation link should reveal its filtered destination');
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
