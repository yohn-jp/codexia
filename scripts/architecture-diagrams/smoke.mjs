// Visual acceptance for the generated Atlas and its shared Pages assets.
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
  const atlasManifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const relatedPaths = [...new Set(atlasManifest.diagrams.flatMap(diagram => diagram.implementationPaths ?? []))];
  const sharedRoot = resolve(root, '../pages-ui');
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/graph/source.json') {
        const mode = process.env.ATLAS_GRAPH_MODE ?? 'match';
        if (mode === 'unavailable') {
          res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"unavailable"}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          sourceSha: mode === 'mismatch' ? '0'.repeat(40) : atlasManifest.sourceSha,
          generator: 'graphifyy', mode: 'code-only', stats: {}, coverage: {}, relations: [],
          files: relatedPaths.map(path => ({ path })),
        }));
        return;
      }
      const prefix = pathname.startsWith('/pages-ui/') ? '/pages-ui/' : '/architecture/';
      if (!pathname.startsWith(prefix)) {
        res.writeHead(404).end();
        return;
      }
      const directory = prefix === '/pages-ui/' ? sharedRoot : root;
      const path = resolve(directory, decodeURIComponent(pathname.slice(prefix.length)) || 'index.html');
      if (!path.startsWith(directory + sep)) {
        res.writeHead(404).end();
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
    const base = 'http://127.0.0.1:' + server.address().port + '/architecture';
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 400 && (path.startsWith('/pages-ui/') || path.startsWith('/architecture/'))) {
        errors.push(response.status() + ' ' + path);
      }
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base + '/#entry-does-not-exist', { waitUntil: 'networkidle' });
    await page.locator('#svg-image:not([hidden])').waitFor({ timeout: 20000 });
    const first = await page.locator('#svg-image').evaluate(img => ({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight }));
    assert.ok(first.naturalWidth > 50 && first.naturalHeight > 50, 'First SVG failed to render');
    const manifest = atlasManifest;
    assert.equal(await page.locator('#diagram-total').textContent(), manifest.diagrams.length + ' visual diagrams');
    assert.ok(manifest.diagrams.some(item => item.id === 'screen-23'));
    assert.ok(manifest.diagrams.some(item => item.id === 'admin-5'));
    assert.ok(manifest.diagrams.some(item => item.id === 'first-3'));
    await page.locator('#diagram-category').selectOption('admin');
    assert.ok(await page.locator('#diagram-list .group:visible').count() === 1, 'Category selector filters to one group');
    await page.locator('#diagram-category').selectOption('all');
    await page.getByRole('button', { name: '拡大' }).click();
    assert.equal(await page.locator('#zoom-reset').textContent(), '125%');
    await page.locator('#diagram-query').fill('AUTH-01');
    await page.locator('#diagram-query').press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.locator('#svg-image:not([hidden])').waitFor();
    assert.match(new URL(page.url()).hash, /^#screen-\d+$/u);
    await page.locator('#diagram-query').fill('');
    const adminButton = page.locator('#diagram-list .group').nth(3).locator('button').first();
    await adminButton.click();
    await page.locator('#svg-image:not([hidden])').waitFor();
    assert.match(new URL(page.url()).hash, /^#admin-1$/u);
    assert.match(await page.locator('#svg-image').getAttribute('src'), /^svg\/admin-1\.svg$/u);
    assert.ok((await page.locator('#svg-image').evaluate(img => img.naturalWidth)) > 50);
    await page.goto(base + '/#screen-23', { waitUntil: 'networkidle' });
    await page.locator('#svg-image:not([hidden])').waitFor();
    assert.equal(await page.locator('#svg-image').getAttribute('src'), 'svg/screen-23.svg');
    assert.ok(await page.locator('#svg-image').evaluate(img => img.naturalWidth > 50));
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#svg-image:not([hidden])').waitFor();
    assert.equal(await page.locator('#svg-image').getAttribute('src'), 'svg/screen-23.svg');
    await page.locator('#diagram-query').fill('ENTRY-01');
    await page.locator('#diagram-list button:visible').first().click();
    await page.locator('#implementation-evidence a').first().waitFor();
    assert.equal(await page.locator('#implementation-evidence a').first().getAttribute('href'),
      '../graph/?file=' + encodeURIComponent('app/src/launcher.tsx'));
    assert.match(await page.locator('#graph-state').textContent(), /SHAはAtlasと一致/u);
    await page.route('**/graph/source.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      sourceSha: '0'.repeat(40), generator: 'graphifyy', mode: 'code-only', stats: {}, coverage: {}, relations: [],
      files: relatedPaths.map(path => ({ path })),
    }) }));
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#graph-state').filter({ hasText: 'SHAがAtlasと異なります' }).waitFor();
    assert.match(await page.locator('#implementation-evidence').textContent(), /SHAが異なる/u);
    assert.equal(await page.locator('#implementation-evidence a').count(), 0, 'Mismatched Graph SHA must not produce links');
    await page.unroute('**/graph/source.json');
    await page.setViewportSize({ width: 320, height: 740 });
    assert.ok(await page.locator('#main-content').isVisible());
    const mobileWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(mobileWidth <= 320, '320px viewport must not overflow horizontally (document width ' + mobileWidth + 'px)');
    if (process.env.ATLAS_PREVIEW_PATH) {
      await page.screenshot({ path: resolve(process.env.ATLAS_PREVIEW_PATH), fullPage: true });
    }
    await page.route('**/graph/source.json', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }));
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#graph-state').filter({ hasText: 'Graph索引を利用できません' }).waitFor();
    assert.match(await page.locator('#implementation-evidence').textContent(), /Graph索引を利用できない/u);
    await page.unroute('**/graph/source.json');
    await page.route('**/manifest.json', route => route.abort('internetdisconnected'));
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.locator('#loading').filter({ hasText: '図の一覧を読み込めませんでした' }).waitFor();
    await page.unroute('**/manifest.json');
    assert.deepEqual(errors, [], 'Browser reported errors');
    console.log(JSON.stringify({ outcome: 'PASS', svgLoaded: true, search: true, category: true, keyboard: true,
      deeplinkReload: true, graphSameShaGate: true, graphUnavailable: true, offlineManifest: true, mobile320: true }));
  } finally {
    await browser?.close();
    await new Promise(ok => server.close(ok));
  }
}
