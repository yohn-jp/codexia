import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { generate } from './generate.mjs';

const [playwright, executablePath, site, screenshots] = process.argv.slice(2);
assert.ok(playwright && executablePath, 'Usage: projection.browser-test.mjs PLAYWRIGHT_CORE CHROMIUM [SITE] [SCREENSHOTS]');
const { chromium } = createRequire(import.meta.url)(resolve(playwright));
const scratch = site ? null : await mkdtemp(join(tmpdir(), 'codexia-ux-projection-'));
const output = site ? resolve(site, 'ux') : scratch;
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  try {
    const { pathname } = new URL(request.url, 'http://localhost');
    const prefix = site ? '/codexia/' : '/';
    const root = site ? resolve(site) : scratch;
    if (!pathname.startsWith(prefix)) throw new Error('Outside publication prefix');
    const file = resolve(root, pathname.slice(prefix.length) + (pathname.endsWith('/') ? 'index.html' : ''));
    assert.ok(file.startsWith(root + sep));
    response.writeHead(200, { 'content-type': mime[extname(file)] }).end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
let browser;
try {
  const syntheticSha = 'f'.repeat(40);
  if (scratch) await generate({ output, sourceSha: syntheticSha });
  const snapshot = JSON.parse(await readFile(join(output, 'snapshot.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sourceSha, snapshot.sourceSha);
  assert.equal(manifest.evidence.productVerified, 'not-evaluated');
  assert.ok(!Object.keys(manifest.outputs).some((path) => /^adapters\/|^features\//.test(path)));
  if (screenshots) await mkdir(screenshots, { recursive: true });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const pageUrl = origin + (site ? '/codexia/ux/' : '/');
  const link = (platform, scenario, checkpoint = 'start', projection = 'expected') => pageUrl + '?' + new URLSearchParams({
    sha: snapshot.sourceSha, projection, platform, scenario, checkpoint,
  });
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  for (const width of [1440, 768, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      errors.push('External request: ' + route.request().url());
      return route.abort();
    });
    const stage = page.locator('.ux-stage');
    const assertHeading = (name) => stage.getByRole('heading', { name, exact: true, level: 2 }).waitFor();
    const button = (name) => stage.getByRole('button', { name, exact: true });
    const fits = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.goto(link('desktop', 'atlas-entry-01'));
    await assertHeading('Web /desktop/');
    await button('APIと認証を照合').focus();
    await page.keyboard.press('Enter');
    await assertHeading('APIと認証を照合');
    await button('DB/認証不明').click();
    await assertHeading('接続と認可を再確認');
    await button('一つ戻る').click();
    await assertHeading('APIと認証を照合');
    await button('未認証').click();
    await assertHeading('AUTH-01');
    await button('参照先 AUTH-01 の図').click();
    await assertHeading('/oauth/login');
    assert.equal(await stage.getAttribute('data-platform'), 'auth');
    assert.equal(await stage.getAttribute('data-projection'), 'expected');
    await button('一つ戻る').click();
    await assertHeading('AUTH-01');
    await button('一つ戻る').click();
    await assertHeading('APIと認証を照合');

    const ios = link('ios', 'atlas-entry-01');
    await page.goto(ios);
    await assertHeading('iOS Native SwiftUI App');
    await button('System OAuth + PKCE').click();
    await assertHeading('System OAuth + PKCE');
    const inspector = page.locator('.ux-inspector');
    if (await inspector.getAttribute('open') === null) await inspector.locator('summary').click();
    await page.getByRole('button', { name: '探索トレース', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const trace = JSON.parse(await dialog.getByRole('textbox').inputValue());
    assert.equal(trace.projection, 'expected');
    assert.ok(trace.history.some(({ kind }) => kind === 'design'));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'リセット' }).click();
    await assertHeading('iOS Native SwiftUI App');
    await fits();
    if (screenshots) await page.screenshot({ path: join(screenshots, 'ux-ios-' + width + '.png') });

    await page.goto(link('console', 'atlas-con-31-con-32'));
    await button('LoadDraft').click();
    await button('existing draft / new').click();
    await button('BKC-003 + If-Match').click();
    await button('412 stale / 422 invalid').click();
    await assertHeading('Editing');
    await fits();
    await page.goto(link('reader', 'atlas-pub-01'));
    await button('共有capability・公開版を検証').click();
    await button('無効/失効/不在').click();
    await assertHeading('共有できない旨を表示');
    await fits();

    const existing = snapshot.observed.scenarios.find(({ platforms }) => platforms.includes('desktop'));
    if (existing) {
      await page.goto(link('desktop', existing.id, 'start', 'observed'));
      await stage.getByText(/実装投影/).first().waitFor();
      assert.equal(await stage.getAttribute('data-projection'), 'observed');
      if (screenshots) await page.screenshot({ path: join(screenshots, 'ux-observed-' + width + '.png') });
    }
    await page.goto(link('desktop', 'atlas-entry-01', 'atlas-entry-01/SESSION'));
    await assertHeading('APIと認証を照合');
    const directInspector = page.locator('.ux-inspector');
    if (await directInspector.getAttribute('open') === null) await directInspector.locator('summary').click();
    assert.equal((await page.locator('.ux-state').innerText()).includes('直接表示'), true);
    await page.goto(ios.replace(snapshot.sourceSha, '0'.repeat(40)));
    await page.getByText('この再現リンクは現在の版と一致しません。').waitFor();
    assert.equal(await stage.getAttribute('data-platform'), null);
    assert.equal(await page.evaluate(() => fetch('https://example.invalid/').then(() => true).catch(() => false)), false);
    assert.deepEqual(errors, []);
    await page.close();
    console.log('Projection UX Chromium proof passed at ' + width + 'px');
  }
} finally {
  await browser?.close();
  server.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
}
