// Visual acceptance for the generated, self-contained diagram component.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? '');
  const browserPackage = process.argv[3];
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  assert.ok(browserPackage && executablePath, 'Playwright-core location and Chrome path required');
  const require = createRequire(import.meta.url);
  const { chromium } = require(resolve(browserPackage));
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const path = resolve(root, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
      if (!(path === root || path.startsWith(root + sep))) {
        res.writeHead(403).end();
        return;
      }
      const bytes = await readFile(path);
      res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  let browser;
  try {
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = 'http://127.0.0.1:' + server.address().port;
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.locator('#svg-image:not([hidden])').waitFor({ timeout: 20000 });
    const first = await page.locator('#svg-image').evaluate(img => ({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight }));
    assert.ok(first.naturalWidth > 50 && first.naturalHeight > 50, 'First SVG failed to render');
    assert.equal(await page.locator('#diagram-total').textContent(), '14 visual diagrams');
    await page.getByRole('button', { name: '拡大' }).click();
    assert.equal(await page.locator('#zoom-reset').textContent(), '125%');
    const adminButton = page.locator('#diagram-list .group').nth(3).locator('button').first();
    await adminButton.click();
    await page.locator('#svg-image:not([hidden])').waitFor();
    assert.match(new URL(page.url()).hash, /^#admin-1$/u);
    assert.match(await page.locator('#svg-image').getAttribute('src'), /^svg\/admin-1\.svg$/u);
    assert.ok((await page.locator('#svg-image').evaluate(img => img.naturalWidth)) > 50);
    await page.screenshot({ path: resolve(root, 'preview.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator('#diagram').isVisible());
    assert.deepEqual(errors, [], 'Browser reported errors');
    console.log(JSON.stringify({ outcome: 'PASS', svgLoaded: true, navigation: true, zoom: true, mobileViewport: true }));
  } finally {
    await browser?.close();
    await new Promise(ok => server.close(ok));
  }
}