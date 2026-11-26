import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';

const [site, playwright, chromiumPath, screenshots] = process.argv.slice(2);
assert.ok(site && playwright && chromiumPath, 'Usage: pages-smoke.mjs SITE PLAYWRIGHT_CORE CHROMIUM [SCREENSHOTS]');

const root = resolve(site);
const prefix = '/codexia/';
const destinations = ['architecture/', 'api/', 'graph/', 'ci/', 'security/', 'audit/'];
const viewports = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 800 },
];
const contentTypes = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.yaml': 'text/yaml',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (!pathname.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    const relative = decodeURIComponent(pathname.slice(prefix.length));
    const file = resolve(root, relative.endsWith('/') || !relative ? relative + 'index.html' : relative);
    assert.ok(file.startsWith(root + sep));
    const bytes = await readFile(file);
    response.writeHead(200, { 'content-type': contentTypes[extname(file)] ?? 'application/octet-stream' });
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});

const require = createRequire(import.meta.url);
const { chromium } = require(resolve(playwright));
const source = JSON.parse(await readFile(resolve(root, 'graph/source.json'), 'utf8'));
const atlas = JSON.parse(await readFile(resolve(root, 'architecture/manifest.json'), 'utf8'));
const audit = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const pagesManifest = JSON.parse(await readFile(resolve(root, 'site-manifest.json'), 'utf8'));
const apiManifest = pagesManifest.scalar;
assert.ok(apiManifest, 'Pages site manifest must include Scalar provenance');
assert.equal(apiManifest.sourceSha, pagesManifest.sourceSha, 'Scalar must match the Pages source SHA');
const diagram = atlas.diagrams.find(item => item.id === 'admin-5');
assert.ok(diagram, 'Established Atlas #admin-5 deep link must be in the manifest');
assert.equal(source.sourceSha, atlas.sourceSha);
const indexedFiles = new Set(source.files.map(file => file.path));
const relatedDiagram = atlas.diagrams.find(item => item.implementationPaths?.some(path => indexedFiles.has(path)));
assert.ok(relatedDiagram, 'Expected at least one Atlas diagram with same-SHA source evidence');
const relatedFile = relatedDiagram.implementationPaths.find(path => indexedFiles.has(path));

// Check the rendered heading against its effective ancestor background, including
// transparent layers, so a mixed Scalar/portal theme cannot pass the smoke test.
async function assertScalarTitleContrast(page) {
  const title = page.locator('#scalar-api-reference').getByRole('heading', { name: 'Codexia API', exact: true }).first();
  await title.waitFor();
  const ratio = await title.evaluate(element => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      layers.unshift(getComputedStyle(node).backgroundColor);
    }
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 1, 1);
    for (const color of layers) {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
    }
    const luminance = () => {
      const channels = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const background = luminance();
    context.fillStyle = getComputedStyle(element).color;
    context.fillRect(0, 0, 1, 1);
    const foreground = luminance();
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  assert.ok(ratio >= 4.5, 'Scalar API title contrast must be at least 4.5:1 (actual ' + ratio.toFixed(2) + ':1)');
}

async function assertReflow(page, label) {
  const { viewport, content } = await page.evaluate(() => ({
    viewport: innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  assert.ok(content <= viewport, `${label} overflows at ${viewport}px (content width ${content}px)`);
}

// A page can have no document-level overflow while clipping an individual SHA.
// Verify the actual text geometry and clipboard result, not a particular CSS rule.
async function assertVisibleCopyableSha(page, selector, expected, label) {
  const sentinel = 'codexia-clipboard-sentinel';
  assert.notEqual(sentinel, expected);
  await page.evaluate(value => navigator.clipboard.writeText(value), sentinel);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sentinel, `${label}: clipboard preflight failed`);
  const locator = page.locator(selector);
  assert.equal(await locator.count(), 1, `${label}: expected one SHA`);
  await locator.scrollIntoViewIfNeeded();
  assert.ok(await locator.isVisible(), `${label}: SHA is not visible`);
  assert.equal(await locator.innerText(), expected, `${label}: incorrect SHA text`);
  const result = await locator.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let text, index = 0;
    while ((text = walker.nextNode())) {
      const clips = [];
      let notRendered = getComputedStyle(text.parentElement).visibility !== 'visible';
      let transparent = false;
      for (let parent = text.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === 'none') notRendered = true;
        if (Number(style.opacity) === 0) transparent = true;
        const x = ['hidden', 'clip'].includes(style.overflowX);
        const y = ['hidden', 'clip'].includes(style.overflowY);
        if (x || y) clips.push({ rect: parent.getBoundingClientRect(), x, y });
      }
      if (notRendered) continue;
      if (transparent) return { error: `SHA character ${index} is hidden` };
      for (let offset = 0; offset < text.length; offset++, index++) {
        range.setStart(text, offset); range.setEnd(text, offset + 1);
        const rects = [...range.getClientRects()];
        if (rects.length === 0) return { error: `SHA character ${index} has no rendered geometry` };
        for (const rect of rects) {
          if (rect.width <= 0 || rect.left < -1 || rect.right > innerWidth + 1 ||
              clips.some(clip => (clip.x && (rect.left < clip.rect.left - 1 || rect.right > clip.rect.right + 1)) ||
                (clip.y && (rect.top < clip.rect.top - 1 || rect.bottom > clip.rect.bottom + 1)))) {
            return { error: `SHA character ${index} is clipped or outside the viewport` };
          }
        }
      }
    }
    if (index === 0) return { error: 'SHA has no selectable text' };
    range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return { selected: selection.toString(), copied: document.execCommand('copy') };
  });
  assert.equal(result.error, undefined, `${label}: ${result.error}`);
  assert.equal(result.selected, expected, `${label}: full SHA cannot be selected`);
  assert.equal(result.copied, true, `${label}: browser copy failed`);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected, `${label}: copied SHA differs`);
}

async function expandContainingDisclosure(locator) {
  const disclosure = locator.locator('xpath=ancestor::details[1]');
  if (await disclosure.count() && !(await disclosure.evaluate(details => details.open))) {
    await disclosure.locator(':scope > summary').press('Enter');
  }
}

async function assertDownload(page, link, { name, sha256 }) {
  const filename = (await link.getAttribute('download')) || name;
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  assert.equal(download.suggestedFilename(), filename);
  const bytes = await readFile(await download.path());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
}

async function selectScalarOperation(page, path, method) {
  if (!(await page.getByRole('button', { name: /Open Search/u }).count())) {
    await page.getByRole('button', { name: /Open Menu/u }).press('Enter');
    await page.getByRole('button', { name: /Open Search/u }).waitFor();
  }
  await page.getByRole('button', { name: /Open Search/u }).press('Enter');
  const search = page.locator('input[aria-label="Enter search query"]');
  await search.fill(path);
  const operation = page.locator(`[role="option"][id$="/${method}${path}"]`);
  await operation.waitFor();
  await operation.click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}

let browser;
try {
  if (screenshots) await mkdir(screenshots, { recursive: true });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = 'http://127.0.0.1:' + server.address().port + prefix;
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce', hasTouch: viewport.width <= 390 });
    page.setDefaultTimeout(8000);
    if (viewport.width === 320) {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });
    }
    const capture = async name => {
      if (!screenshots) return;
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: resolve(screenshots, `${name}-${viewport.width}x${viewport.height}.png`), fullPage: name === 'security-export' });
    };
    const errors = [];
    const externalRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const url = request.url();
      if (!url.startsWith(base) && !url.startsWith('data:') && !url.startsWith('blob:')) externalRequests.push(url);
    });
    page.on('response', response => {
      if (response.url().startsWith(base) && response.status() >= 400) {
        errors.push(response.status() + ' ' + response.url().slice(base.length));
      }
    });
    let apiStatus = 429;
    let apiRequests = 0;
    let scanningStatus = 401;
    let scanningRequests = 0;
    const findings = [{
      number: 12, state: 'open', tool: { name: 'CodeQL' },
      rule: { id: 'js/example', security_severity_level: 'high' },
      most_recent_instance: { location: { path: '-unsafe.ts', start_line: 5 }, message: { text: '=FORMULA(1)' } },
    }];
    await page.route('https://api.github.com/**', route => {
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'Authorization, X-GitHub-Api-Version, Accept',
      };
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: cors });
      }
      if (route.request().url().includes('/code-scanning/alerts')) {
        scanningRequests++;
        assert.equal(route.request().headers().authorization, 'Bearer test-read-only-token');
        return route.fulfill(scanningStatus === 200 ? { status: 200, headers: cors, json: findings } : { status: scanningStatus, headers: cors, json: { message: 'invalid' } });
      }
      apiRequests++;
      return route.fulfill({ status: apiStatus, headers: cors, json: { message: 'API fixture (' + apiStatus + ')' } });
    });
    const home = await page.goto(base);
    assert.equal(home.status(), 200);
    assert.ok(await page.getByRole('heading', { level: 1 }).isVisible());
    await assertReflow(page, 'Portal');
    await capture('portal');
    const siteMapLinks = await page.locator('main a[href]').evaluateAll(links => links.map(link => link.href));
    for (const destination of destinations) assert.ok(siteMapLinks.includes(base + destination), 'Portal site map omits ' + destination);

    await page.keyboard.press('Tab');
    const skipTarget = await page.locator('.cx-pages-skip:focus').getAttribute('href');
    assert.match(skipTarget ?? '', /^#.+/u, 'First tab stop must be the skip link');
    await page.keyboard.press('Enter');
    await page.waitForURL(base + skipTarget);
    assert.ok(await page.locator(skipTarget).isVisible());
    assert.ok(await page.locator(skipTarget).evaluate(target => document.activeElement === target));

    for (const destination of destinations) {
      await page.goto(base);
      const primary = page.locator('.cx-pages-navigation');
      if (!(await primary.isVisible())) {
        const menu = page.locator('.cx-pages-menu-button');
        assert.equal(await menu.getAttribute('aria-expanded'), 'false');
        assert.ok(await menu.evaluate(button => button.getBoundingClientRect().height >= 44), 'Mobile menu hit area');
        await menu.press('Enter');
        assert.equal(await menu.getAttribute('aria-expanded'), 'true');
        if (destination === destinations[0]) {
          await capture('navigation-expanded');
          await primary.getByRole('link').first().press('Escape');
          assert.equal(await menu.getAttribute('aria-expanded'), 'false');
          assert.ok(await menu.evaluate(button => document.activeElement === button), 'Escape must return focus to the menu button');
          await menu.press('Enter');
        }
      }
      const target = primary.getByRole('link').filter({ visible: true });
      const hrefs = await target.evaluateAll(links => links.map(link => link.href));
      const index = hrefs.indexOf(base + destination);
      assert.ok(index >= 0, 'Primary navigation must link to ' + destination);
      await target.nth(index).press('Enter');
      await page.waitForURL(base + destination);
      assert.ok(await page.getByRole('heading', { level: 1 }).first().isVisible());
      assert.equal(await primary.locator('a[aria-current="page"]').evaluate(link => link.href), base + destination);
      await assertReflow(page, destination);
      if (destination === 'ci/') {
        await page.locator('#status').filter({ hasText: /429/u }).waitFor();
        await capture('ci-rate-limited');
        const requestsBeforeRetry = apiRequests;
        apiStatus = 503;
        await page.getByRole('button', { name: '再試行' }).press('Enter');
        await page.locator('#status').filter({ hasText: /503/u }).waitFor();
        assert.ok(apiRequests > requestsBeforeRetry, 'CI retry must make another API request');
        assert.ok(await page.locator('#copy-diagnostics').isDisabled());
        apiStatus = 429;
      } else if (destination === 'api/') {
        await assertScalarTitleContrast(page);
        let body = await page.locator('body').innerText();
        assert.match(body, /OpenAPI 3.1 contract generated from TypeSpec/u);
        assert.match(body, /current admitted operations register in Fastify/u);
        assert.match(body, /this static reference is not a runtime inventory, CI result, or production API acceptance report/u);
        assert.match(body, /Authentication scheme definitions/u);
        assert.match(body, /BearerAuth[\s\S]*HTTP Bearer/u);
        assert.match(body, /ApiKeyAuth[\s\S]*__Secure-better-auth\.session_token/u);
        assert.equal(await page.getByRole('button', { name: /Ask AI/u }).count(), 0,
          'Scalar assistant controls must stay disabled for the public contract');
        assert.equal(await page.locator('input[type="password"], input[autocomplete*="password"], input[placeholder*="token" i], input[aria-label*="token" i]').count(), 0,
          'Scalar must not expose credential entry fields');
        assert.equal(await page.getByRole('button', { name: /Authorize/u }).count(), 0,
          'Scalar must not expose authorization controls');
        await selectScalarOperation(page, '/api/auth/oauth2/consent-context', 'POST');
        body = await page.locator('body').innerText();
        assert.match(body, /Declared principal:[\s\S]*OWNER-SESSION; same-origin request/u);
        assert.match(body, /Security deviation:[\s\S]*owner-session cookie/u);
        assert.match(body, /401[\s\S]*unauthorized|unauthorized[\s\S]*401/iu);
        assert.match(body, /403[\s\S]*forbidden|forbidden[\s\S]*403/iu);
        await selectScalarOperation(page, '/api/public/projects/{projectId}/modules/publishing/share/{token}/scenes/{sceneId}', 'GET');
        body = await page.locator('body').innerText();
        assert.match(body, /Runtime response deviation:[\s\S]*at 404/u);
        assert.match(body, /404[\s\S]*cannot find/iu);
        await selectScalarOperation(page, '/api/v1/persistence/projects/{projectId}/documents/{documentId}/anchors', 'POST');
        body = await page.locator('body').innerText();
        assert.match(body, /Current admitted route; Fastify registration uses the generated route and schema inventory/u);
        await assertReflow(page, 'API operation details');
        assert.equal(await page.getByRole('link', { name: 'Third-party notices' }).getAttribute('href'), './THIRD_PARTY_NOTICES.txt');
        assert.equal(await page.getByRole('button', { name: /Try it|Send API Request|Test Request/i }).count(), 0,
          'Static API reference must not expose request execution controls');
        assert.deepEqual(externalRequests, [], 'Static Scalar page must not request an external origin');
        await capture('api-reference');
      } else if (destination === 'security/') {
        assert.equal(scanningRequests, 0, 'Security page must not request protected alerts before authorization');
        const token = page.locator('#access-token');
        await token.fill('test-read-only-token');
        await page.getByRole('button', { name: 'アラートを取得' }).press('Enter');
        await page.locator('#status').filter({ hasText: /HTTP 401/u }).waitFor();
        assert.ok(await page.locator('#download-json').isDisabled(), 'Failed request must not enable download');
        assert.equal(await token.inputValue(), '', 'Credential must be cleared after request');
        scanningStatus = 200;
        await token.fill('test-read-only-token');
        await page.getByRole('button', { name: 'アラートを取得' }).press('Enter');
        await page.locator('#status').filter({ hasText: /取得に成功/u }).waitFor();
        assert.equal(await page.locator('#alerts tr').count(), 1);
        const [jsonDownload] = await Promise.all([
          page.waitForEvent('download'), page.locator('#download-json').click(),
        ]);
        const report = JSON.parse(await readFile(await jsonDownload.path(), 'utf8'));
        assert.equal(report.schemaVersion, 'codexia-code-scanning-alerts/v1');
        assert.equal(report.alertCount, 1);
        assert.equal(report.alerts[0].number, 12);
        const [csvDownload] = await Promise.all([
          page.waitForEvent('download'), page.locator('#download-csv').click(),
        ]);
        const csv = await readFile(await csvDownload.path(), 'utf8');
        assert.ok(csv.includes('"' + String.fromCharCode(39) + '=FORMULA(1)'));
        assert.ok(csv.includes('"' + String.fromCharCode(39) + '-unsafe.ts'));
        assert.ok(!csv.includes('test-read-only-token'));
        await capture('security-export');
        await page.reload();
        assert.equal(await page.locator('#access-token').inputValue(), '');
        assert.ok(await page.locator('#download-json').isDisabled(), 'Reload must discard in-memory findings');
        scanningStatus = 401;
      } else if (destination === 'audit/') {
        await capture('audit');
      }
      await page.locator('.cx-pages-brand').press('Enter');
      await page.waitForURL(base);
    }

    const previousRequestCount = externalRequests.length;
    await page.goto(base + 'architecture/#system-1');
    const nativeView = page.locator('likec4-view[view-id="architecture"]');
    await nativeView.locator('.react-flow__node').first().waitFor();
    await assertReflow(page, 'Atlas LikeC4');
    assert.deepEqual(externalRequests.slice(previousRequestCount), [], 'Atlas LikeC4 must stay on the Pages origin');
    await capture('atlas-likec4');

    await page.goto(base + 'architecture/#admin-5');
    await page.reload();
    await page.locator('#svg-image:not([hidden])').waitFor();
    await page.waitForFunction(() => {
      const { naturalWidth, naturalHeight } = document.querySelector('#svg-image');
      return naturalWidth > 0 && naturalHeight > 0;
    });
    assert.equal(new URL(page.url()).hash, '#admin-5');
    const svg = page.locator('#svg-image');
    const imageWidth = await svg.evaluate(image => image.getBoundingClientRect().width);
    await page.locator('#zoom-in').press('Enter');
    assert.ok(await svg.evaluate(image => image.getBoundingClientRect().width) > imageWidth, 'Atlas zoom must enlarge the diagram');
    await assertReflow(page, 'Atlas zoom');
    await capture('atlas-zoomed');

    await page.goto(base + 'architecture/#' + relatedDiagram.id);
    const evidence = page.locator('#implementation-evidence');
    await expandContainingDisclosure(evidence);
    const architectureLink = evidence.locator(`a[href="../graph/?file=${encodeURIComponent(relatedFile)}"]`);
    await architectureLink.press('Enter');
    await page.waitForURL(url => url.pathname === prefix + 'graph/' && url.searchParams.get('file') === relatedFile);
    await page.waitForFunction(path => document.querySelector('#selected-path')?.textContent === path, relatedFile);

    assert.ok(source.files?.length, 'Graph source metadata must contain indexed paths');
    const graphLink = new URL('graph/', base);
    const { path: firstFile } = source.files[0];
    graphLink.searchParams.set('file', firstFile);
    await page.goto(graphLink.href);
    await page.reload();
    await page.waitForFunction(path => document.querySelector('#selected-path')?.textContent === path, firstFile);
    const graphSearch = page.locator('#search');
    await expandContainingDisclosure(graphSearch);
    await graphSearch.fill(firstFile);
    const selection = page.locator('#file-list .file-button[aria-current="true"]');
    await selection.waitFor();
    assert.equal(new URL(page.url()).searchParams.get('file'), firstFile);
    await page.locator('#direction').selectOption('outgoing');
    await page.locator('#depth').selectOption('3');
    assert.ok(await page.locator('#neighbor-graph').isVisible());
    await assertReflow(page, 'Graphify multihop');
    await capture('graph-selected');
    const community = await page.request.get(new URL('graph/communities.html', base).href);
    assert.equal(community.status(), 200);
    assert.match(await community.text(), /<html\b/iu);
    if (viewport.width > 1000) {
      await page.goto(new URL('graph/communities.html', base).href);
      const communityData = await page.locator('#cx-community-data').textContent().then(JSON.parse);
      assert.equal(communityData.sourceSha, source.sourceSha);
      const named = communityData.groups.find(group => group.members.length && group.name !== 'Community ' + group.id);
      assert.ok(named, 'At least one indexed community must have a Graphify hub label');
      const target = await page.evaluate(id => {
        network.stopSimulation();
        const node = RAW_NODES.find(n => n.community === id);
        if (!node) throw Error('Native graph is missing the community');
        const position = network.getPositions([node.id])[node.id];
        network.moveTo({ position, scale: 1, animation: false });
        return network.canvasToDOM(position);
      }, named.id);
      const canvas = await page.locator('#graph canvas').boundingBox();
      assert.ok(canvas, 'Graphify native canvas must be visible');
      await page.mouse.click(canvas.x + target.x, canvas.y + target.y);
      const inspector = page.locator('#cx-community-dialog');
      await inspector.waitFor({ state: 'visible' });
      assert.equal(new URL(page.url()).searchParams.get('community'), String(named.id));
      assert.match(await page.locator('#cx-community-title').textContent(), /#\d+/);
      await page.reload();
      await inspector.waitFor({ state: 'visible' });
      await page.locator('#cx-edge-direction').selectOption('outgoing');
      assert.ok(await page.locator('#cx-community-edges').isVisible());
      const memberLink = page.locator('#cx-community-members a').first();
      const memberURL = new URL(await memberLink.getAttribute('href'), page.url());
      assert.ok(source.files.some(file => file.path === memberURL.searchParams.get('file')));
      await capture('graph-community');
      await memberLink.click();
      await page.waitForURL(url => url.pathname === prefix + 'graph/' && url.searchParams.get('file') === memberURL.searchParams.get('file'));
      await page.goBack();
      await inspector.waitFor({ state: 'visible' });
      await page.locator('#cx-community-close').click();
      assert.equal(new URL(page.url()).searchParams.has('community'), false);
      await page.locator('#cx-community-open').press('Enter');
      await inspector.waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await inspector.waitFor({ state: 'hidden' });
    }

    const main = audit.branches.find(branch => branch.branch === 'main');
    assert.ok(main && ['ready', 'partial'].includes(audit.snapshots[main.sha]?.status));
    const snapshotUrl = new URL('snapshots/' + main.sha + '/', base);
    await page.goto(base + 'audit/');
    const snapshotLink = page.locator(`main a[href$="snapshots/${main.sha}/"]`).first();
    await expandContainingDisclosure(snapshotLink);
    await snapshotLink.click();
    assert.equal(page.url(), snapshotUrl.href);
    const repomix = audit.snapshots[main.sha].outputs.find(output => output.name === 'repomix.json');
    assert.ok(repomix);
    await assertDownload(page, page.locator('a[download][href="repomix.json"]'), repomix);
    assert.equal(page.url(), snapshotUrl.href);
    await assertReflow(page, 'Source Snapshot');
    await capture('snapshot');

    const detailRoutes = [snapshotUrl.href];
    const review = Object.entries(audit.reviews ?? {}).find(([, item]) => ['ready', 'partial'].includes(item.status));
    if (review) {
      const [sha] = review;
      assert.match(sha, /^[a-f\d]{40}$/u);
      const reviewUrl = new URL('reviews/' + sha + '/', base);
      detailRoutes.push(reviewUrl.href);
      assert.equal((await page.goto(reviewUrl.href)).status(), 200);
      const manifest = JSON.parse(await readFile(resolve(root, 'reviews', sha, 'manifest.json'), 'utf8'));
      const packet = manifest.outputs.find(output => output.name === 'gemini-review.md');
      assert.ok(packet);
      await assertDownload(page, page.locator('a[download][href="gemini-review.md"]'), packet);
      assert.equal(page.url(), reviewUrl.href);
      await assertReflow(page, 'Review Materials');
      await capture('review');
      await page.locator(`main a[href$="audit/#sha-${sha}"]`).press('Enter');
      await page.waitForURL(base + 'audit/#sha-' + sha);
      await page.reload();
      assert.ok(await page.locator('#sha-' + sha).isVisible());
    }

    if (viewport.width <= 768) {
      for (const url of [base, ...destinations.map(destination => base + destination), ...detailRoutes]) {
        await page.goto(url);
        await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
        await assertReflow(page, `${url.slice(base.length) || 'Portal'} with 200% text`);
        assert.ok(await page.getByRole('heading', { level: 1 }).first().isVisible());
        if (viewport.width === 320 && url === base) {
          await assertVisibleCopyableSha(page, '.cx-pages-source-line code', source.sourceSha, 'Portal source SHA at 200%');
        } else if (viewport.width === 320 && url === base + 'graph/') {
          await assertVisibleCopyableSha(page, '.cx-pages-mode code', source.sourceSha, 'Code Map source SHA at 200%');
        } else if (viewport.width === 320 && url === snapshotUrl.href) {
          await assertVisibleCopyableSha(page, '.cx-pages-hero .cx-pages-meta code', main.sha, 'Snapshot source SHA at 200%');
        }
        const menu = page.locator('.cx-pages-menu-button');
        if (url === base && await menu.isVisible()) {
          await menu.press('Enter');
          await assertReflow(page, 'Expanded navigation with 200% text');
        }
      }
    }

    assert.deepEqual(errors, [], 'Browser or generated asset errors at width ' + viewport.width);
    await page.close();
  }
  console.log('Chromium Pages smoke passed under ' + prefix + ' at ' +
    viewports.map(({ width, height }) => `${width}×${height}`).join(', '));
} finally {
  await browser?.close();
  if (server.listening) await new Promise(done => server.close(done));
}
