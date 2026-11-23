import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright-core');

const template = await readFile(new URL('./explorer.html', import.meta.url), 'utf8');
const sha = 'a'.repeat(40);
const fixture = {
  schemaVersion: 1,
  sourceSha: sha,
  stats: { files: 3, nodes: 6, links: 6, crossFileLinks: 3 },
  coverage: {
    mode: 'code-only', trackedFiles: 8, eligibleFiles: null, extractedFiles: 3,
    excludedFiles: ['docs/readme.md', 'tests/app.test.ts', 'evidence/log.txt'],
    excluded: { tests: 1, docs: 1, evidence: 1, agents: 0, testFiles: 1, specFiles: 0 },
    unavailableFiles: null,
  },
  relations: ['calls', 'imports'],
  files: [
    { path: 'packages/a.ts', symbols: ['start'], incoming: [{ path: 'packages/c.ts', count: 1, relations: ['calls'], relationCounts: { calls: 1 }, evidence: [{ path: 'packages/c.ts', line: 12 }] }], outgoing: [{ path: 'packages/b.ts', count: 2, relations: ['calls', 'imports'], relationCounts: { calls: 1, imports: 1 }, evidence: [] }] },
    { path: 'packages/b.ts', symbols: ['load'], incoming: [{ path: 'packages/a.ts', count: 2, relations: ['calls', 'imports'], relationCounts: { calls: 1, imports: 1 }, evidence: [] }], outgoing: [{ path: 'packages/c.ts', count: 1, relations: ['imports'], relationCounts: { imports: 1 }, evidence: [{ path: 'packages/b.ts', line: 24 }] }] },
    { path: 'packages/c.ts', symbols: ['finish'], incoming: [{ path: 'packages/b.ts', count: 1, relations: ['imports'], relationCounts: { imports: 1 }, evidence: [{ path: 'packages/b.ts', line: 24 }] }], outgoing: [{ path: 'packages/a.ts', count: 1, relations: ['calls'], relationCounts: { calls: 1 }, evidence: [{ path: 'packages/c.ts', line: 12 }] }] },
  ],
};
const emptyFixture = { schemaVersion: 1, sourceSha: sha, stats: { files: 0, nodes: 0, links: 0, crossFileLinks: 0 }, coverage: { mode: 'code-only', trackedFiles: 0, eligibleFiles: 0, extractedFiles: 0, excludedFiles: [], excluded: {}, unavailableFiles: [] }, relations: [], files: [] };
const sourceAnchors = data => data.files.map(file => `<a hidden target="_blank" rel="noopener noreferrer" href="https://github.com/yohn-jp/codexia/blob/${sha}/${file.path}">GitHubでソースを開く</a>`).join('');
function pageFor(data) {
  return template.replace('__GRAPHIFY_INDEX_JSON__', JSON.stringify(data).replaceAll('<', '\\u003c')).replace('__GRAPHIFY_SOURCE_LINKS__', sourceAnchors(data));
}
async function serveFixture(data, t) {
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(pageFor(data)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/graph/`;
}

test('Graphify explorer supports desktop, 320px, keyboard, deep links and coverage states', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CODEXIA_E2E_CHROMIUM || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(await serveFixture(fixture, t), { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('#selected-path').textContent(), 'packages/a.ts');
  assert.match(await page.locator('#coverage').innerText(), /未取得/);
  await page.locator('#coverage summary').click();
  assert.match(await page.locator('#coverage').innerText(), /除外されたパス: 3件/);
  assert.match(await page.locator('#coverage').innerText(), /候補ファイル総数または未抽出ファイル一覧.*未取得/);
  await page.locator('#depth').selectOption('3');
  assert.match(await page.locator('#expansion-list').innerText(), /循環\/重複/);
  assert.ok(await page.locator('.evidence a').count() > 0);
  await page.locator('#relation').selectOption('imports');
  assert.equal(await page.locator('#outgoing-list .relation').count(), 1);
  await page.locator('#direction').selectOption('outgoing');
  assert.equal(await page.locator('#incoming-list .relation').count(), 0);
  await page.locator('#search').fill('packages/b.ts');
  const fileButton = page.locator('.file-button').first();
  await fileButton.focus();
  await page.keyboard.press('Enter');
  assert.equal(new URL(page.url()).searchParams.get('file'), 'packages/b.ts');
  await page.goBack();
  assert.equal(new URL(page.url()).searchParams.get('file'), 'packages/a.ts');
  await page.reload();
  assert.equal(await page.locator('#selected-path').textContent(), 'packages/a.ts');
  assert.equal(await page.locator('#source-links a:not([hidden])').count(), 1);
  assert.match(await page.locator('#expansion-list').innerText(), /packages\/b.ts/);
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile page shell should not overflow horizontally');
  assert.equal(await page.locator('#search').isVisible(), true);
  assert.equal(await page.locator('#neighbor-graph').isVisible(), true);
});

test('Graphify explorer explains an empty index', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CODEXIA_E2E_CHROMIUM || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
  await page.goto(await serveFixture(emptyFixture, t), { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('#selected-path').textContent(), '解析対象ファイルなし');
  assert.match(await page.locator('#page-status').innerText(), /ファイルがありません/);
  assert.match(await page.locator('#file-list').innerText(), /coverage/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
});
