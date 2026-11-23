import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';

const [site, playwright, chromiumPath] = process.argv.slice(2);
assert.ok(site && playwright && chromiumPath, 'Usage: pages-smoke.mjs SITE PLAYWRIGHT_CORE CHROMIUM');

const root = resolve(site);
const prefix = '/codexia/';
const destinations = ['architecture/', 'graph/', 'ci/', 'audit/'];
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

let browser;
try {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = 'http://127.0.0.1:' + server.address().port + prefix;
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 320, height: 800 }]) {
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.url().startsWith(base) && response.status() >= 400) {
        errors.push(response.status() + ' ' + response.url().slice(base.length));
      }
    });
    await page.route('https://api.github.com/**', route => route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'API rate limit fixture' }),
    }));
    const home = await page.goto(base);
    assert.equal(home.status(), 200);
    assert.ok(await page.getByRole('heading', { level: 1 }).isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal overflow at Portal');
    const siteMapLinks = await page.locator('main a[href]').evaluateAll(links => links.map(link => link.href));
    for (const destination of destinations) assert.ok(siteMapLinks.includes(base + destination), 'Portal site map omits ' + destination);

    await page.keyboard.press('Tab');
    const skipTarget = await page.locator('.cx-pages-skip:focus').getAttribute('href');
    assert.match(skipTarget ?? '', /^#.+/u, 'First tab stop must be the skip link');
    await page.keyboard.press('Enter');
    assert.equal(new URL(page.url()).hash, skipTarget);
    assert.ok(await page.locator(skipTarget).isVisible());
    assert.ok(await page.locator(skipTarget).evaluate(target => document.activeElement === target));

    for (const destination of destinations) {
      await page.goto(base);
      const primary = page.locator('.cx-pages-navigation');
      if (viewport.width === 320) {
        assert.equal(await primary.isVisible(), false, 'The mobile navigation opens on demand');
        const menu = page.locator('.cx-pages-menu-button');
        assert.equal(await menu.getAttribute('aria-expanded'), 'false');
        await menu.focus();
        await page.keyboard.press('Enter');
        assert.equal(await menu.getAttribute('aria-expanded'), 'true');
      }
      const target = primary.getByRole('link').filter({ visible: true });
      const hrefs = await target.evaluateAll(links => links.map(link => link.href));
      const index = hrefs.indexOf(base + destination);
      assert.ok(index >= 0, 'Primary navigation must link to ' + destination);
      await target.nth(index).click();
      assert.equal(page.url(), base + destination);
      assert.ok(await page.getByRole('heading', { level: 1 }).first().isVisible());
      assert.equal(await primary.locator('a[aria-current="page"]').evaluate(link => link.href), base + destination);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal overflow at ' + destination);
      if (destination === 'ci/') await page.locator('#status').filter({ hasText: /429/u }).waitFor();
      await page.locator('.cx-pages-brand').click();
      assert.equal(page.url(), base);
    }

    await page.goto(base + 'architecture/#admin-5');
    await page.reload();
    await page.locator('#svg-image:not([hidden])').waitFor();
    await page.waitForFunction(() => {
      const { naturalWidth, naturalHeight } = document.querySelector('#svg-image');
      return naturalWidth > 0 && naturalHeight > 0;
    });
    assert.equal(new URL(page.url()).hash, '#admin-5');

    await page.goto(base + 'architecture/#' + relatedDiagram.id);
    await page.locator('#implementation-evidence').getByRole('link', { name: relatedFile, exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get('file'), relatedFile);
    await page.waitForFunction(path => document.querySelector('#selected-path')?.textContent === path, relatedFile);

    assert.ok(source.files?.length, 'Graph source metadata must contain indexed paths');
    const graphLink = new URL('graph/', base);
    const { path: firstFile } = source.files[0];
    graphLink.searchParams.set('file', firstFile);
    await page.goto(graphLink.href);
    await page.reload();
    await page.waitForFunction(path => document.querySelector('#selected-path')?.textContent === path, firstFile);
    await page.locator('#search').fill(firstFile);
    const selection = page.locator('#file-list .file-button[aria-current="true"]');
    await selection.waitFor();
    assert.equal(new URL(page.url()).searchParams.get('file'), firstFile);

    const main = audit.branches.find(branch => branch.branch === 'main');
    assert.ok(main && ['ready', 'partial'].includes(audit.snapshots[main.sha]?.status));
    const snapshotUrl = new URL('snapshots/' + main.sha + '/', base);
    await page.goto(base + 'audit/');
    const snapshotAnchor = page.locator('main a').filter({ hasText: /snapshot/i });
    assert.ok(await snapshotAnchor.evaluateAll((links, href) => links.some(link => link.href === href), snapshotUrl.href));
    assert.equal((await page.goto(snapshotUrl.href)).status(), 200);
    assert.ok(await page.locator('a[download][href$="repomix.json"]').first().isVisible());

    const review = Object.entries(audit.reviews).find(([, item]) => ['ready', 'partial'].includes(item.status));
    if (review) {
      const [sha] = review;
      const reviewUrl = new URL('reviews/' + sha + '/', base);
      assert.equal((await page.goto(reviewUrl.href)).status(), 200);
      assert.ok(await page.locator('a[download][href$="gemini-review.md"]').first().isVisible());
    }
    assert.deepEqual(errors, [], 'Browser or generated asset errors at width ' + viewport.width);
    await page.close();
  }
  console.log('Chromium Pages smoke passed at 1440 and 320 pixels under ' + prefix);
} finally {
  await browser?.close();
  if (server.listening) await new Promise(done => server.close(done));
}
