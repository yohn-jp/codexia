import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const template = await readFile(new URL('./explorer.html', import.meta.url), 'utf8');
const sha = 'a'.repeat(40);
const fixture = {
  schemaVersion: 1,
  sourceSha: sha,
  stats: { files: 4, nodes: 8, links: 7, crossFileLinks: 4, symbolEdges: 6 },
  coverage: {
    mode: 'code-only', trackedFiles: 8, eligibleFiles: 5, extractedFiles: 4,
    excludedFiles: ['docs/readme.md', 'tests/app.test.ts', 'evidence/log.txt'],
    excluded: { tests: 1, docs: 1, evidence: 1, agents: 0, testFiles: 1, specFiles: 0 },
    unavailableFiles: ['packages/lost.ts'], otherTrackedFiles: 0, scopeStatus: 'measured',
  },
  relations: ['calls', 'imports'],
  files: [
    {
      path: 'packages/a.ts',
      symbols: [{
        id: 'a-symbol', path: 'packages/a.ts', label: 'alpha', line: 4,
        incoming: [{ id: 'c-symbol', path: 'packages/c.ts', label: 'gamma', relation: 'calls', evidence: [{ path: 'packages/c.ts', line: 12, relation: 'calls' }] }],
        outgoing: [{ id: 'b-symbol', path: 'packages/b.ts', label: 'beta', relation: 'imports', evidence: [{ path: 'packages/a.ts', line: 7, relation: 'imports' }] }],
      }],
      incoming: [{ path: 'packages/c.ts', count: 1, relations: ['calls'], relationCounts: { calls: 1 }, evidence: [{ path: 'packages/c.ts', line: 12, relation: 'calls' }] }],
      outgoing: [{ path: 'packages/b.ts', count: 2, relations: ['calls', 'imports'], relationCounts: { calls: 1, imports: 1 }, evidence: [] }],
    },
    {
      path: 'packages/b.ts',
      symbols: [{
        id: 'b-symbol', path: 'packages/b.ts', label: 'beta', line: null,
        incoming: [{ id: 'a-symbol', path: 'packages/a.ts', label: 'alpha', relation: 'imports', evidence: [{ path: 'packages/a.ts', line: 7, relation: 'imports' }] }],
        outgoing: [
          { id: 'c-symbol', path: 'packages/c.ts', label: 'gamma', relation: 'calls', evidence: [] },
          { id: 'long-symbol', path: 'packages/very-long-folder-name-that-keeps-going-for-many-characters/another-deeply-nested-directory-name-that-continues/long-file-name.ts', label: 'long destination', relation: 'imports', evidence: [{ path: 'packages/b.ts', line: 52, relation: 'imports' }] },
        ],
      }],
      incoming: [{ path: 'packages/a.ts', count: 2, relations: ['calls', 'imports'], relationCounts: { calls: 1, imports: 1 }, evidence: [] }],
      outgoing: [
        { path: 'packages/c.ts', count: 1, relations: ['imports'], relationCounts: { imports: 1 }, evidence: [{ path: 'packages/b.ts', line: 24, relation: 'imports' }] },
        { path: 'packages/very-long-folder-name-that-keeps-going-for-many-characters/another-deeply-nested-directory-name-that-continues/long-file-name.ts', count: 1, relations: ['imports'], relationCounts: { imports: 1 }, evidence: [{ path: 'packages/b.ts', line: 52, relation: 'imports' }] },
      ],
    },
    {
      path: 'packages/c.ts',
      symbols: [{
        id: 'c-symbol', path: 'packages/c.ts', label: 'gamma', line: 9,
        incoming: [{ id: 'b-symbol', path: 'packages/b.ts', label: 'beta', relation: 'calls', evidence: [] }],
        outgoing: [{ id: 'a-symbol', path: 'packages/a.ts', label: 'alpha', relation: 'calls', evidence: [{ path: 'packages/c.ts', line: 12, relation: 'calls' }] }],
      }],
      incoming: [{ path: 'packages/b.ts', count: 1, relations: ['imports'], relationCounts: { imports: 1 }, evidence: [{ path: 'packages/b.ts', line: 24, relation: 'imports' }] }],
      outgoing: [{ path: 'packages/a.ts', count: 1, relations: ['calls'], relationCounts: { calls: 1 }, evidence: [{ path: 'packages/c.ts', line: 12, relation: 'calls' }] }],
    },
    {
      path: 'packages/very-long-folder-name-that-keeps-going-for-many-characters/another-deeply-nested-directory-name-that-continues/long-file-name.ts',
      symbols: [{
        id: 'long-symbol', path: 'packages/very-long-folder-name-that-keeps-going-for-many-characters/another-deeply-nested-directory-name-that-continues/long-file-name.ts', label: 'long destination', line: null,
        incoming: [{ id: 'b-symbol', path: 'packages/b.ts', label: 'beta', relation: 'imports', evidence: [{ path: 'packages/b.ts', line: 52, relation: 'imports' }] }], outgoing: [],
      }],
      incoming: [{ path: 'packages/b.ts', count: 1, relations: ['imports'], relationCounts: { imports: 1 }, evidence: [{ path: 'packages/b.ts', line: 52, relation: 'imports' }] }],
      outgoing: [],
    },
  ],
};
const emptyFixture = { schemaVersion: 1, sourceSha: sha, stats: { files: 0, nodes: 0, links: 0, crossFileLinks: 0 }, coverage: { mode: 'code-only', trackedFiles: 0, eligibleFiles: null, extractedFiles: 0, excludedFiles: [], excluded: {}, unavailableFiles: null, otherTrackedFiles: null, scopeStatus:'candidate-inventory-not-reported' }, relations: [], files: [] };
const sourceAnchors = data => data.files.map(file => `<a hidden target="_blank" rel="noopener noreferrer" href="https://github.com/yohn-jp/codexia/blob/${sha}/${file.path}">GitHubでソースを開く</a>`).join('');
function pageFor(data) {
  return template.replace('__GRAPHIFY_INDEX_JSON__', JSON.stringify(data).replaceAll('<', '\\u003c')).replace('__GRAPHIFY_SOURCE_LINKS__', sourceAnchors(data));
}
async function serveFixture(data, t) {
  const runtime=await readFile(new URL('./analysis.mjs', import.meta.url),'utf8');
  const server = createServer(async (request, response) => {
    if(new URL(request.url,'http://localhost').pathname==='/graph/analysis.mjs'){response.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});response.end(runtime);return;}
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(pageFor(data));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/graph/`;
}

test('Graphify explorer supports desktop, 320px, keyboard, deep links and coverage states', { skip: !process.env.CODEXIA_AUDIT_TOOL_DIR, timeout: 30_000 }, async t => {
  const require = createRequire(join(process.env.CODEXIA_AUDIT_TOOL_DIR, 'package.json'));
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch(process.env.CODEXIA_E2E_CHROMIUM
    ? { executablePath: process.env.CODEXIA_E2E_CHROMIUM, headless: true }
    : { channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto((await serveFixture(fixture, t))+'?file=packages/a.ts', { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('#selected-path').textContent(), 'packages/a.ts');
  assert.equal(await page.locator('#stat-symbol-links').textContent(), '6');
  assert.match(await page.locator('#coverage').innerText(), /解析範囲/);
  await page.locator('#coverage-panel > summary').click();
  assert.match(await page.locator('#coverage').innerText(), /未取得候補/);
  await page.locator('#coverage-details > summary').click();
  assert.match(await page.locator('#coverage').innerText(), /解析対象外のパス 3件/);
  assert.match(await page.locator('#coverage').innerText(), /packages\/lost.ts/);
  assert.match(await page.locator('#coverage').innerText(), /候補/);
  assert.match(await page.locator('#coverage').innerText(), /その他のtracked/);
  assert.equal(await page.locator('#stat-candidates').innerText(), '5');
  assert.equal(await page.locator('#stat-other-tracked').innerText(), '0');
  const alphaButton=page.locator('#symbols .symbol-button').filter({ hasText: 'alpha' });
  await alphaButton.focus();
  await page.keyboard.press('Enter');
  assert.equal(new URL(page.url()).searchParams.get('symbol'), 'a-symbol');
  assert.equal(await page.locator('#selected-symbol').textContent(), 'alpha');
  assert.equal(await page.locator('#outgoing-list .relation').count(), 1);
  assert.match(await page.locator('#graph-scope').innerText(), /シンボル間関係/);
  assert.equal(await page.locator('#neighbor-graph .edge-label').count(), 2);
  const symbolNodeLabels = await page.locator('#neighbor-graph .node.linked').evaluateAll(nodes => nodes.map(node => ({
    visible: [...node.querySelectorAll('.node-label, .node-subtitle')].map(label => label.textContent).join(' '),
    name: node.getAttribute('aria-label'),
  })));
  assert.ok(symbolNodeLabels.every(node => node.name.includes(node.visible)), 'symbol button names include their visible labels and path subtitles');
  assert.equal(await page.locator('#symbol-source').isVisible(), true);
  assert.ok(await page.locator('#symbol-source').evaluate(element => element.getBoundingClientRect().height >= 44));
  assert.equal(await page.locator('#symbol-source').getAttribute('href'), `https://github.com/yohn-jp/codexia/blob/${sha}/packages/a.ts#L4`);
  assert.equal(await page.locator('#outgoing-list .relation-evidence a').getAttribute('href'), `https://github.com/yohn-jp/codexia/blob/${sha}/packages/a.ts#L7`);
  await page.locator('#depth').selectOption('3');
  assert.match(await page.locator('#expansion-list').innerText(), /循環\/重複/);
  assert.ok(await page.locator('.relation-evidence a').count() > 0);
  await page.locator('#outgoing-list .relation').filter({ hasText:'beta' }).click();
  assert.equal(new URL(page.url()).searchParams.get('symbol'), 'b-symbol');
  assert.match(await page.locator('#symbol-location').innerText(), /行番号なし/);
  await page.goBack();
  assert.equal(new URL(page.url()).searchParams.get('symbol'), 'a-symbol');
  await page.locator('#relation').selectOption('imports');
  assert.equal(await page.locator('#outgoing-list .relation').count(), 1);
  await page.locator('#direction').selectOption('outgoing');
  assert.equal(await page.locator('#incoming-list .relation').count(), 0);
  await page.locator('#outgoing-list .relation').filter({ hasText:'beta' }).click();
  assert.equal(new URL(page.url()).searchParams.get('file'), 'packages/b.ts');
  assert.equal(new URL(page.url()).searchParams.get('symbol'), 'b-symbol');
  await page.goBack();
  assert.equal(new URL(page.url()).searchParams.get('symbol'), 'a-symbol');
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
  assert.equal(new URL(page.url()).searchParams.get('symbol'), 'a-symbol');
  assert.equal(await page.locator('#selected-symbol').textContent(), 'alpha');
  assert.match(await page.locator('#expansion-list').innerText(), /beta/);
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'long source evidence should wrap within 320px shell');
  assert.equal(await page.locator('#file-explorer').evaluate(element => element.open), false, 'mobile file explorer starts collapsed so the selected graph remains primary');
  await page.locator('.file-explorer-summary').click();
  assert.equal(await page.locator('#search').isVisible(), true);
  assert.equal(await page.locator('#neighbor-graph').isVisible(), true);
  for (const link of await page.locator('.relation-evidence a').all()) {
    assert.ok((await link.evaluate(element => element.getBoundingClientRect().height)) >= 44, 'source evidence links meet the minimum touch target');
  }
});

test('Graphify neighbor graph caps dense directions and preserves the chosen limit in the URL', { skip: !process.env.CODEXIA_AUDIT_TOOL_DIR, timeout: 30_000 }, async t => {
  const require = createRequire(join(process.env.CODEXIA_AUDIT_TOOL_DIR, 'package.json'));
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch(process.env.CODEXIA_E2E_CHROMIUM
    ? { executablePath: process.env.CODEXIA_E2E_CHROMIUM, headless: true }
    : { channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const rootPath = 'packages/root.ts';
  const longPath = (direction, index) => `packages/long-folder-${index}/another-deep-folder/very-long-${direction}-destination-${index}.ts`;
  const incoming = Array.from({ length: 12 }, (_, index) => ({ path: longPath('incoming', index), count: index + 1, relations: ['imports'], relationCounts: { imports: index + 1 }, evidence: [] }));
  const outgoing = Array.from({ length: 4 }, (_, index) => ({ path: longPath('outgoing', index), count: 1, relations: ['calls'], relationCounts: { calls: 1 }, evidence: [] }));
  const files = [
    { path: rootPath, symbols: [], incoming, outgoing },
    ...incoming.map(edge => ({ path: edge.path, symbols: [], incoming: [], outgoing: [{ path: rootPath, count: edge.count, relations: ['imports'], relationCounts: { imports: edge.count }, evidence: [] }] })),
    ...outgoing.map(edge => ({ path: edge.path, symbols: [], incoming: [{ path: rootPath, count: 1, relations: ['calls'], relationCounts: { calls: 1 }, evidence: [] }], outgoing: [] })),
  ];
  const graphFixture = { ...fixture, stats: { files: files.length, nodes: files.length, links: 16, crossFileLinks: 16 }, coverage: { ...fixture.coverage, eligibleFiles: files.length, extractedFiles: files.length }, files };
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto((await serveFixture(graphFixture, t)) + '?file=' + encodeURIComponent(rootPath), { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('#neighbor-graph .node.in').count(), 8);
  assert.equal(await page.locator('#neighbor-graph .node.out').count(), 4);
  assert.match(await page.locator('#graph-limit-summary').innerText(), /参照元 8\/12/);
  const fileNodeLabels = await page.locator('#neighbor-graph .node.linked').evaluateAll(nodes => nodes.map(node => ({
    visible: [...node.querySelectorAll('.node-label, .node-subtitle')].map(label => label.textContent).join(' '),
    name: node.getAttribute('aria-label'),
  })));
  assert.ok(fileNodeLabels.every(node => node.name.includes(node.visible)), 'truncated file button names include their exact visible labels');
  await page.locator('#display-limit').selectOption('16');
  assert.equal(await page.locator('#neighbor-graph .node.in').count(), 12);
  assert.equal(new URL(page.url()).searchParams.get('limit'), '16');
});

test('Graphify explorer explains an empty index', { skip: !process.env.CODEXIA_AUDIT_TOOL_DIR, timeout: 30_000 }, async t => {
  const require = createRequire(join(process.env.CODEXIA_AUDIT_TOOL_DIR, 'package.json'));
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch(process.env.CODEXIA_E2E_CHROMIUM
    ? { executablePath: process.env.CODEXIA_E2E_CHROMIUM, headless: true }
    : { channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
  await page.goto(await serveFixture(emptyFixture, t), { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('#selected-path').textContent(), '解析対象ファイルなし');
  assert.match(await page.locator('#page-status').innerText(), /ファイルはありません/);
  await page.locator('#coverage-panel > summary').click();
  assert.match(await page.locator('#coverage').innerText(), /未取得/);
  await page.locator('#coverage-details > summary').click();
  assert.match(await page.locator('#coverage').innerText(), /coverageの分母は未取得/);
  await page.locator('.file-explorer-summary').click();
  assert.match(await page.locator('#file-list').innerText(), /coverage/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
});

test('Graphify explorer pins selected files beyond the result cap and explains unavailable deep links', { skip: !process.env.CODEXIA_AUDIT_TOOL_DIR, timeout: 30_000 }, async t => {
  const require = createRequire(join(process.env.CODEXIA_AUDIT_TOOL_DIR, 'package.json'));
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch(process.env.CODEXIA_E2E_CHROMIUM
    ? { executablePath: process.env.CODEXIA_E2E_CHROMIUM, headless: true }
    : { channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const manyFiles = Array.from({ length: 205 }, (_, index) => ({
    path: `packages/file-${String(index).padStart(3, '0')}.ts`, symbols: [], incoming: [], outgoing: [],
  }));
  const requested = { path: 'packages/zz-selected.ts', symbols: [], incoming: [], outgoing: [] };
  const fullIndex = {
    ...fixture,
    stats: { files: manyFiles.length + 1, nodes: 0, links: 0, crossFileLinks: 0 },
    coverage: { mode: 'code-only', trackedFiles: 210, eligibleFiles: 206, extractedFiles: 206, unavailableFiles: [], excludedFiles: [], excluded: {}, otherTrackedFiles: 4, scopeStatus: 'measured' },
    files: [...manyFiles, requested],
  };
  await page.goto((await serveFixture(fullIndex, t)) + '?file=' + encodeURIComponent(requested.path));
  assert.equal(await page.locator('#selected-path').textContent(), requested.path);
  assert.equal(await page.locator('#file-list .file-button[aria-current="true"]').count(), 1);
  assert.equal(await page.locator('#file-list .file-button:not(.unavailable)').count(), 200);
  assert.match(await page.locator('#file-count').innerText(), /選択中の項目を含む/);

  await page.goto((await serveFixture(fixture, t)) + '?file=' + encodeURIComponent('.github/dependabot.yml'));
  assert.equal(await page.locator('#selected-path').textContent(), '.github/dependabot.yml');
  assert.equal(await page.locator('#file-list .file-button[aria-current="true"]').isDisabled(), false);
  assert.match(await page.locator('#file-list .file-button[aria-current="true"]').innerText(), /索引にありません/);
  assert.match(await page.locator('#page-status').innerText(), /Graphifyの索引にありません/);
  await page.reload();
  assert.equal(await page.locator('#selected-path').textContent(), '.github/dependabot.yml');
  await page.goto((await serveFixture(fixture,t))+'?file=packages%2Fa.ts&symbol=missing-symbol');
  assert.match(await page.locator('#page-status').innerText(), /指定シンボル ID/);
});
