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
const destinations = ['architecture/', 'graph/', 'ci/', 'audit/'];
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
const diagram = atlas.diagrams.find(item => item.id === 'admin-5');
assert.ok(diagram, 'Established Atlas #admin-5 deep link must be in the manifest');
assert.equal(source.sourceSha, atlas.sourceSha);
const indexedFiles = new Set(source.files.map(file => file.path));
const relatedDiagram = atlas.diagrams.find(item => item.implementationPaths?.some(path => indexedFiles.has(path)));
assert.ok(relatedDiagram, 'Expected at least one Atlas diagram with same-SHA source evidence');
const relatedFile = relatedDiagram.implementationPaths.find(path => indexedFiles.has(path));

async function assertReflow(page, label) {
  const { viewport, content } = await page.evaluate(() => ({
    viewport: innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  assert.ok(content <= viewport, `${label} overflows at ${viewport}px (content width ${content}px)`);
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

let browser;
try {
  if (screenshots) await mkdir(screenshots, { recursive: true });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = 'http://127.0.0.1:' + server.address().port + prefix;
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce', hasTouch: viewport.width <= 390 });
    page.setDefaultTimeout(8000);
    const capture = async name => {
      if (!screenshots) return;
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: resolve(screenshots, `${name}-${viewport.width}x${viewport.height}.png`) });
    };
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.url().startsWith(base) && response.status() >= 400) {
        errors.push(response.status() + ' ' + response.url().slice(base.length));
      }
    });
    let apiStatus = 429;
    let apiRequests = 0;
    await page.route('https://api.github.com/**', route => {
      apiRequests++;
      return route.fulfill({ status: apiStatus, json: { message: `API fixture (${apiStatus})` } });
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
        if (destination === destinations[0]) await capture('navigation-expanded');
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
      } else if (destination === 'audit/') {
        await capture('audit');
      }
      await page.locator('.cx-pages-brand').press('Enter');
      await page.waitForURL(base);
    }

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

    const review = Object.entries(audit.reviews ?? {}).find(([, item]) => ['ready', 'partial'].includes(item.status));
    if (review) {
      const [sha] = review;
      assert.match(sha, /^[a-f\d]{40}$/u);
      const reviewUrl = new URL('reviews/' + sha + '/', base);
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
      for (const destination of ['', ...destinations]) {
        await page.goto(base + destination);
        await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
        await assertReflow(page, `${destination || 'Portal'} with 200% text`);
        assert.ok(await page.getByRole('heading', { level: 1 }).first().isVisible());
        const menu = page.locator('.cx-pages-menu-button');
        if (!destination && await menu.isVisible()) {
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
