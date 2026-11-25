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
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } });
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
    assert.equal(await stage.locator('.ux-route-map').isVisible(), true, 'The transition overview is visible without opening a disclosure');
    assert.equal(await stage.locator('.ux-route-states > [aria-current="step"]').count(), 1);
    assert.match(await stage.locator('.ux-route-edges').first().innerText(), /APIと認証を照合/u);
    assert.ok(await stage.locator('.ux-route-action').count() > 0, 'The transition graph exposes current evidenced edges as operation buttons');
    if (width === 390) {
      const firstTransition = await stage.locator('.ux-route-action').first().boundingBox();
      assert.ok(firstTransition && firstTransition.y + firstTransition.height <= 844,
        'The first graph transition is visible in the initial 390×844 viewport');
    }
    const projectedEdge = stage.getByRole('button', { name: 'APIと認証を照合', exact: true });
    const edgeDescription = await projectedEdge.getAttribute('aria-describedby');
    assert.ok(edgeDescription.split(' ').length >= 2, 'The graph action describes its target and evidence');
    for (const id of edgeDescription.split(' ')) assert.equal(await page.locator('[id="' + id + '"]').count(), 1);
    assert.match(await Promise.all(edgeDescription.split(' ').map((id) => page.locator('[id="' + id + '"]').innerText())).then((values) => values.join(' ')), /遷移先: APIと認証を照合/u);
    const readability = await stage.evaluate((stage) => {
      const luminance = (color) => {
        const rgb = color.match(/[^(), ]+/g).slice(1, 4).map(Number).map((value) => value / 255);
        const linear = rgb.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const heading = stage.querySelector('[data-current-state]');
      const foreground = luminance(getComputedStyle(heading).color);
      const background = luminance(getComputedStyle(heading.parentElement).backgroundColor);
      const nodes = document.createTreeWalker(document.querySelector('.ux-layout'), NodeFilter.SHOW_TEXT);
      let stray = false;
      while (nodes.nextNode()) stray ||= /^(?:undefined|null)$/.test(nodes.currentNode.textContent.trim());
      return { ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05), stray };
    });
    assert.ok(readability.ratio >= 4.5, 'UX wireframe heading must retain contrast under the Pages shell');
    assert.equal(readability.stray, false, 'Absent projection data must not render as text');
    await projectedEdge.focus();
    await page.keyboard.press('Enter');
    await assertHeading('APIと認証を照合');
    assert.match(await stage.locator('.ux-route-states > [aria-current="step"]').innerText(), /APIと認証を照合/u);
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
    const saveObservation = snapshot.observed.scenarios.find(({ id }) => id === 'observed-save-receipt');
    if (site && snapshot.observed.screens.some(({ id, platform }) => id === 'WRT-01' && platform === 'desktop')) {
      assert.ok(saveObservation, 'Assembled Pages must contain canonical Desktop execution evidence');
    }
    if (saveObservation) {
      await page.goto(link('desktop', saveObservation.id, 'start', 'observed'));
      await assertHeading('idle');
      await button('RECOVERY.READY').click();
      await assertHeading('saving');
      await stage.getByRole('button', { name: /^xstate\.done\.actor/ }).click();
      await assertHeading('unknown');
      await button('SAVE.RETRY').click();
      await stage.getByRole('button', { name: /^xstate\.done\.actor/ }).click();
      await assertHeading('confirmed');
      const proof = page.locator('.ux-inspector');
      if (await proof.getAttribute('open') === null) await proof.locator('summary').click();
      assert.match(await proof.innerText(), /synthetic-receipt/);
    }
    if (Object.hasOwn(manifest.outputs, 'compare/browser.mjs')) {
      const panel = page.getByRole('region', { name: '版比較' });
      await page.getByRole('button', { name: '比較', exact: true }).click();
      await panel.getByRole('button', { name: '設計と実装' }).waitFor();
      await panel.getByRole('searchbox').fill('CON-32.B');
      await panel.getByRole('heading', { name: 'CON-32.B', exact: true }).waitFor();
      await fits();
      await panel.getByRole('button', { name: '2 版の差分' }).click();
      if (Object.hasOwn(manifest.outputs, 'compare/base.mjs')) {
        await panel.getByText(/ビルドで確認済み/).waitFor();
        await panel.getByText(/このビルドの検証済み投影/).waitFor();
      } else {
        await panel.getByText('版差分は利用できません。比較する 2 版の生成物を選択してください。').waitFor();
      }
      if (width === 1440) {
        for (const side of ['比較元', '比較先']) {
          await panel.getByLabel(side + ' の manifest.json').setInputFiles(join(output, 'manifest.json'));
          await panel.getByLabel(side + ' の snapshot.json').setInputFiles(join(output, 'snapshot.json'));
        }
        await panel.getByText('表示条件に該当する差分はありません。').waitFor();
        await panel.getByLabel('比較先 の snapshot.json').setInputFiles({
          name: 'snapshot.json', mimeType: 'application/json', buffer: Buffer.from('{}'),
        });
        await panel.getByText('比較元を利用できません。版、形式、ダイジェストを確認してください。').waitFor();
      }
      await page.getByRole('button', { name: '探索', exact: true }).click();
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
