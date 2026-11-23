import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';

const [site, playwright, chromiumPath] = process.argv.slice(2);
assert.ok(site && playwright && chromiumPath, 'Usage: pages-smoke.mjs SITE PLAYWRIGHT_CORE CHROMIUM');

const root = resolve(site);
const prefix = '/codexia/';
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
const diagram = atlas.diagrams.find(item => item.id === 'admin-5');
assert.ok(diagram, 'Established Atlas #admin-5 deep link must be in the manifest');

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

    await page.keyboard.press('Tab');
    const skipTarget = await page.locator('.cx-pages-skip:focus').getAttribute('href');
    assert.match(skipTarget ?? '', /^#.+/u, 'First tab stop must be the skip link');
    await page.keyboard.press('Enter');
    assert.equal(new URL(page.url()).hash, skipTarget);
    assert.ok(await page.locator(skipTarget).isVisible());
    assert.ok(await page.locator(skipTarget).evaluate(target => document.activeElement === target));

    for (const destination of ['architecture/', 'graph/', 'ci/', 'audit/']) {
      await page.goto(base);
      const primary = page.locator('.cx-pages-navigation');
      if (!(await primary.isVisible())) {
        const menu = page.locator('.cx-pages-menu-button');
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
    await page.waitForFunction(() => document.querySelector('#svg-image').naturalWidth > 50);
    assert.equal(new URL(page.url()).hash, '#admin-5');

    assert.ok(source.files?.length, 'Graph source metadata must contain indexed paths');
    const graphLink = new URL('graph/', base);
    const firstFile = typeof source.files[0] === 'string' ? source.files[0] : source.files[0].path;
    graphLink.searchParams.set('file', firstFile);
    await page.goto(graphLink.href);
    await page.reload();
    const selection = page.locator('#file-list .file-button[aria-current="true"]');
    await selection.waitFor();
    assert.equal(await page.locator('#selected-path').textContent(), firstFile);
    assert.equal(new URL(page.url()).searchParams.get('file'), firstFile);
    assert.deepEqual(errors, [], 'Browser or generated asset errors at width ' + viewport.width);
    await page.close();
  }
  console.log('Chromium Pages smoke passed at 1440 and 320 pixels under ' + prefix);
} finally {
  await browser?.close();
  if (server.listening) await new Promise(done => server.close(done));
}
