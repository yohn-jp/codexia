import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { generate } from './generate.mjs';

const [playwright, executablePath] = process.argv.slice(2);
assert.ok(playwright && executablePath, 'Usage: reference.browser-test.mjs PLAYWRIGHT_CORE CHROMIUM');
const { chromium } = createRequire(import.meta.url)(resolve(playwright));
const output = await mkdtemp(join(tmpdir(), 'codexia-ux-'));
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const file = resolve(output, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    assert.ok(file.startsWith(output + sep));
    const bytes = await readFile(file);
    response.writeHead(200, { 'content-type': mime[extname(file)] }).end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});
let browser;
try {
  const sha = 'f'.repeat(40);
  const manifest = await generate({ output, sourceSha: sha });
  assert.equal(manifest.status, 'partial');
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  for (const width of [1440, 768, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      errors.push('Unexpected request: ' + route.request().url());
      return route.abort();
    });
    await page.goto(origin);
    const stage = page.locator('.ux-stage');
    await stage.getByRole('heading', { name: '作品ライブラリ' }).waitFor();
    const inspector = page.locator('.ux-inspector');
    if (await inspector.getAttribute('open') === null) await inspector.locator('summary').click();
    await page.getByLabel('次の合成応答').selectOption('forbidden');
    await page.getByRole('button', { name: '応答を予約' }).click();
    const open = stage.getByRole('button', { name: '作品を開く' });
    await open.focus();
    await page.keyboard.press('Enter');
    assert.match(await page.getByRole('status').innerText(), /forbidden/);
    assert.equal(await stage.getAttribute('data-screen'), 'LIB-01');
    assert.equal(await open.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Enter');
    assert.equal(await stage.getAttribute('data-screen'), 'OUT-01');
    assert.match(await inspector.innerText(), /synthetic-lighthouse/);
    await stage.getByRole('button', { name: '作品一覧に戻る' }).click();
    await stage.getByRole('button', { name: '作品を作成' }).click();
    await stage.getByLabel('作品名').fill('水平線の手紙');
    await stage.getByRole('button', { name: '確認' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await stage.getByLabel('作品名').inputValue(), '水平線の手紙');
    await stage.getByRole('button', { name: '確認' }).click();
    await dialog.getByRole('button', { name: '作成', exact: true }).click();
    await stage.getByRole('heading', { name: '水平線の手紙' }).waitFor();
    await page.getByRole('button', { name: '合成トレースを表示' }).click();
    const trace = await dialog.getByRole('textbox').inputValue();
    assert.ok(!trace.includes('水平線の手紙'));
    assert.ok(JSON.parse(trace).history.some(({ outcome, response }) => outcome === 'refused' && response === 'forbidden'));
    await dialog.getByRole('button', { name: '閉じる' }).click();
    await page.getByRole('button', { name: '再現リンクを表示' }).click();
    const link = await dialog.getByRole('textbox').inputValue();
    await page.goto(link);
    await stage.getByRole('heading', { name: '作品ライブラリ' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    assert.equal(await page.evaluate(() => fetch('https://example.invalid/').then(() => true).catch(() => false)), false);
    assert.deepEqual(errors, []);
    await page.goto(link.replace(sha, '0'.repeat(40)));
    await page.getByText('この再現リンクは現在の版と一致しません。').waitFor();
    assert.equal(await stage.getAttribute('data-screen'), null);
    await page.close();
    console.log('Reference UX proofs passed at ' + width + 'px');
  }
} finally {
  await browser?.close();
  server.close();
  await rm(output, { recursive: true, force: true });
}
