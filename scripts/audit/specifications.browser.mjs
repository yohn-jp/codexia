import assert from 'node:assert/strict';
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
  const types = {'.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.json':'application/json', '.svg':'image/svg+xml'};
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
    assert.equal((await page.goto(`${base}/architecture/#system-1`)).status(), 200);
    assert.ok(await page.locator('body').innerText());
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
