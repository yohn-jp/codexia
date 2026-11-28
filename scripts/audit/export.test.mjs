import { test } from 'node:test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHeads, exclusion, splitFiles, validatePack, renderIndex, buildPortal } from './export.mjs';

const sha = 'a'.repeat(40);
test('all branch refs, including slash and HTML characters, are data only', () => {
  const heads = parseHeads(sha + '\trefs/heads/feature/<example>\n' + sha + '\trefs/heads/main\n');
  assert.deepEqual(heads.map(x => x.branch), ['feature/<example>', 'main']);
  assert.throws(() => parseHeads(sha + '\trefs/heads/main\n' + sha + '\trefs/heads/main\n'));
  assert.throws(() => parseHeads(sha + '\trefs/tags/main\n'));
  const html = renderIndex({ observedAt: 'now', branches: heads, snapshots: { [sha]: { status: 'blocked' } } });
  assert.ok(html.includes('feature/&lt;example&gt;'));
  assert.ok(!html.includes('<example>'));
  assert.ok(!html.includes('snapshots/' + sha));
  assert.equal([...html.matchAll(new RegExp('id="sha-' + sha + '"','gu'))].length, 1);
  assert.match(html, /<main>/u);
  const readyHtml=renderIndex({ observedAt:'now', branches:[{branch:'main',sha}], snapshots:{[sha]:{status:'ready',outputs:[{name:'repomix.json',bytes:10}]}} });
  assert.ok(readyHtml.includes('<a class="cx-pages-action" href="snapshots/' + sha + '/">Snapshot details</a>'));
  assert.doesNotMatch(readyHtml, /actions\/workflows\/visual-context-pack\.yml/u);
  assert.match(readyHtml, /<details class="cx-pages-branch" id="sha-[a-f0-9]{40}">/u);
  assert.doesNotMatch(readyHtml, /<table/u);
  const chunkedHtml=renderIndex({ observedAt:'now', branches:[{branch:'main',sha}], snapshots:{[sha]:{status:'ready',fileCount:3,outputs:[
    {name:'repomix.json',bytes:10},{name:'part-0001.json',bytes:5,scope:'02-frontend'},
  ]}} });
  assert.match(chunkedHtml, /<details class="cx-pages-disclosure"><summary>Download snapshot parts \(1\)<\/summary>/u);
  assert.match(chunkedHtml, /href="snapshots\/[a-f0-9]{40}\/part-0001\.json" download="codexia-[a-f0-9]{40}-part-0001\.json"/u);
});
test('only regular source blobs, not credentials, data or branch-controlled packer configuration', () => {
  for (const path of ['.env.production', 'nested/.npmrc', 'secret.pem', 'data/work.md', 'evidence/run/output.json', 'evidence/README.md', 'evidence/performance/run/seed/scene.md', '.repomixignore', 'repomix.config.ts', '../escape', '.git/config']) assert.ok(exclusion(path, '100644', 1), path);
  assert.ok(exclusion('link', '120000', 10));
  assert.ok(exclusion('submodule', '160000', 0));
  for (const path of ['.env.example', 'app/src/index.ts', '.github/workflows/verify.yml', 'docs/architecture/CORE.sdoc', 'packages/core/src/merge.test.ts', 'packages/persistence-postgres/migrations/0001.sql', 'pnpm-lock.yaml']) assert.equal(exclusion(path, '100644', 1), null, path);
});
test('vendored project agent skills are excluded without hiding governance or source', () => {
  for (const path of ['.agents/skills/modern-web-guidance/SKILL.md', '.agents/skills/modern-web-guidance/guides/css/css.md', '.agents/skills/chrome-extensions/SKILL.md']) {
    assert.equal(exclusion(path, '100644', 1), 'vendored-agent-skill', path);
  }
  for (const path of ['AGENTS.md', 'skills-lock.json', '.agents/LICENSE', '.agents/custom.md', '.agents/skills-extra/guide.md', 'packages/core/src/skills.ts']) {
    assert.equal(exclusion(path, '100644', 1), null, path);
  }
});
test('split parts preserve whole files and reconstruct packed input', () => {
  const files = { 'a.ts': 'small\n', 'b.ts': '😀\n"\\'.repeat(100_000), 'c.ts': '' };
  const output = splitFiles(files, sha);
  assert.equal(output.length, 1);
  const restored = Object.create(null);
  for (const part of output) {
    const parsed = JSON.parse(part.content);
    assert.equal(parsed.sourceSha, sha);
    for (const entry of parsed.entries) {
      assert.equal(entry.offset, 0);
      assert.equal(Object.hasOwn(restored, entry.path), false);
      restored[entry.path] = (restored[entry.path] ?? '') + entry.content;
    }
  }
  assert.deepEqual({ ...restored }, files);
});
test('security-filtered files are explicitly omitted, unknown packed paths fail closed', () => {
  const inventory = { included: [{ path: 'a.ts' }, { path: 'b.ts' }], excluded: [{ path: '.env', reason: 'sensitive-filename' }] };
  const result = validatePack({ files: { 'a.ts': 'ok' } }, inventory);
  assert.equal(result.partial, true);
  assert.deepEqual(result.excluded.map(x => x.path), ['.env', 'b.ts']);
  assert.throws(() => validatePack({ files: { '../leak': 'bad' } }, inventory));
});

test('real Repomix packs immutable Git blobs, skips unsafe input, reuses only verified snapshots', { skip: !process.env.CODEXIA_AUDIT_REPOMIX_BIN }, () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-test-'));
  try {
    const repo = join(root, 'repo'); mkdirSync(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Audit test'); git('config', 'user.email', 'audit@example.invalid');
    writeFileSync(join(repo, 'source.ts'), 'export const value = 1;\n');
    mkdirSync(join(repo, 'evidence', 'run'), { recursive: true });
    writeFileSync(join(repo, 'evidence', 'run', 'scene.md'), 'historical fixture');
    for (const skill of ['modern-web-guidance', 'chrome-extensions']) {
      const skillDir = join(repo, '.agents', 'skills', skill);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), 'vendored guidance\n');
    }
    writeFileSync(join(repo, 'AGENTS.md'), 'project instructions\n');
    writeFileSync(join(repo, 'skills-lock.json'), '{"skills":{}}\n');
    writeFileSync(join(repo, '.agents', 'LICENSE'), 'upstream license\n');
    mkdirSync(join(repo, 'app', 'src'), { recursive: true });
    writeFileSync(join(repo, 'app', 'src', 'view.ts'), 'export const view = true;\n');
    writeFileSync(join(repo, '.env'), 'PRIVATE_TEST_VALUE=must-not-be-packed\n');
    writeFileSync(join(repo, '.repomixignore'), 'source.ts\n');
    writeFileSync(join(repo, 'repomix.config.ts'), 'throw new Error("branch config executed");\n');
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'synthetic outside content');
    symlinkSync(outside, join(repo, 'link'));
    git('add', '-A'); git('commit', '-qm', 'fixture');
    const first = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'source.ts'), 'export const value = 2;\n');
    const fixtureBearer = ['Bearer', ['local', 'fixture', 'not', 'a', 'credential', '0123456789'].join('-')].join(' ');
    writeFileSync(join(repo, 'bearer-fixture.ts'), 'export const auth = ' + JSON.stringify(fixtureBearer) + ';\n');
    git('add', 'source.ts', 'bearer-fixture.ts'); git('commit', '-qm', 'second');
    const second = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'source.ts'), 'uncommitted text');
    const cache = join(root, 'cache');
    const run = (site, heads, executable = process.env.CODEXIA_AUDIT_REPOMIX_BIN) => buildPortal({ root: repo, site: join(root, site), cache, executable, heads });
    const a = run('site1', [{branch:'main',sha:second},{branch:'old',sha:first},{branch:'same',sha:second}]);
    assert.equal(existsSync(join(root,'site1','index.html')), false);
    assert.ok(existsSync(join(root,'site1','audit','index.html')));
    assert.ok(existsSync(join(root,'site1','manifest.json')));
    assert.equal(a.snapshots[first].status, 'ready');
    assert.equal(a.snapshots[second].status, 'partial');
    const read = (site, id, file) => JSON.parse(readFileSync(join(root, site, 'snapshots', id, file), 'utf8'));
    assert.ok(read('site1',second,'manifest.json').excluded.some(x => x.path === 'bearer-fixture.ts' && x.reason === 'credential-pattern'));
    assert.match(read('site1',first,'repomix.json').files['source.ts'], /value = 1/);
    assert.match(read('site1',second,'repomix.json').files['source.ts'], /value = 2/);
    const files = read('site1',second,'repomix.json').files;
    assert.equal(Object.hasOwn(files, 'bearer-fixture.ts'), false);
    assert.equal(Object.hasOwn(files, '.env'), false);
    assert.equal(Object.hasOwn(files, 'link'), false);
    assert.equal(Object.hasOwn(files, 'repomix.config.ts'), false);
    assert.equal(Object.hasOwn(files, 'evidence/run/scene.md'), false);
    const manifest = read('site1', second, 'manifest.json');
    assert.ok(manifest.excluded.some(x => x.path === 'evidence/run/scene.md' && x.reason === 'historical-evidence'));
    for (const skill of ['modern-web-guidance', 'chrome-extensions']) {
      const path = '.agents/skills/' + skill + '/SKILL.md';
      assert.equal(Object.hasOwn(files, path), false);
      assert.ok(manifest.excluded.some(x => x.path === path && x.reason === 'vendored-agent-skill'));
    }
    for (const path of ['AGENTS.md', 'skills-lock.json', '.agents/LICENSE']) {
      assert.equal(Object.hasOwn(files, path), true, path);
      assert.ok(manifest.files.some(x => x.path === path), path);
    }
    assert.equal(manifest.outputs.filter(x => x.name.startsWith('part-')).length, 3);
    const c = run('site2', [{branch:'main',sha:second}], '/does-not-exist');
    assert.equal(c.snapshots[second].status, 'partial');
    assert.equal(existsSync(join(root, 'site2', 'snapshots', first)), false);
    assert.equal(existsSync(join(cache, first)), false);
    writeFileSync(join(cache, second, 'repomix.json'), 'tampered');
    const d = run('site3', [{branch:'main',sha:second}], '/does-not-exist');
    assert.equal(d.snapshots[second].status, 'blocked');
    assert.equal(existsSync(join(root, 'site3', 'snapshots', second)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('nine responsibility groups preserve every whole file deterministically', () => {
  // One fixture layout per review audience from the repository audit contract in README.md.
  const scopes = {
    '01-architecture': ['docs/CORE.md'],
    '02-frontend': ['app/src/a.ts'],
    '03-core-contracts': ['packages/core/a.ts'],
    '04-api': ['packages/api/a.ts'],
    '05-persistence': ['packages/persistence-postgres/a.ts'],
    '06-authoring-modules': ['modules/story/a.ts'],
    '07-platform-modules': ['modules/mcp/a.ts'],
    '08-infrastructure-ci': ['deploy/a.yml'],
    '09-verification-tooling': ['pnpm-lock.yaml', 'scripts/a.mjs', 'tests/a.ts'],
  };
  const files = Object.fromEntries(Object.values(scopes).flat().map((p,i)=>[p,'x'.repeat(1000+i)]));
  const parts = splitFiles(files, sha);
  assert.deepEqual(parts.map(part => part.scope), Object.keys(scopes));
  assert.deepEqual(parts, splitFiles(Object.fromEntries(Object.entries(files).reverse()), sha));
  const restored = Object.create(null);
  for (const part of parts) {
    const packet = JSON.parse(part.content);
    assert.equal(packet.sourceSha, sha);
    assert.equal(packet.scope, part.scope);
    assert.deepEqual(packet.entries.map(entry => entry.path), scopes[part.scope]);
    for (const entry of packet.entries) {
      assert.equal(entry.offset, 0);
      assert.equal(Object.hasOwn(restored, entry.path), false);
      restored[entry.path] = entry.content;
    }
  }
  assert.deepEqual({...restored}, files);
});

test('browser downloads full, manifest and scoped part bytes without navigating away', { skip: !process.env.CODEXIA_AUDIT_TOOL_DIR }, async () => {
  const require = createRequire(join(process.env.CODEXIA_AUDIT_TOOL_DIR, 'package.json'));
  const { chromium } = require('playwright-core');
  const full = '{"files":{"app/src/a.ts":"source"}}';
  const part = '{"entries":[{"path":"app/src/a.ts","offset":0,"content":"source"}]}';
  const snapshotManifest = '{"files":[{"path":"app/src/a.ts"}]}';
  const geminiMarkdown = '# OCR review input\nPACKET_ID: 123\nEND_OF_PACKET 123\n';
  const html = renderIndex({ observedAt: 'now', branches: [{ branch: 'main', sha }], reviews: { [sha]: { status: 'ready', published: 2 } }, snapshots: {
    [sha]: { status: 'ready', fileCount: 1, outputs: [{ name: 'repomix.json', bytes: Buffer.byteLength(full) }, { name: 'part-0001.json', bytes: Buffer.byteLength(part), scope: '02-frontend' }] },
  } });
  const base = '/snapshots/' + sha + '/';
  const files = new Map([[base + 'repomix.json', full], [base + 'part-0001.json', part], [base + 'manifest.json', snapshotManifest], ['/manifest.json', '{"branches":[]}'], ['/reviews/' + sha + '/gemini-review.md', geminiMarkdown]]);
  const server = createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
    if (!files.has(req.url)) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(files.get(req.url));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch(process.env.CODEXIA_E2E_CHROMIUM
      ? { executablePath: process.env.CODEXIA_E2E_CHROMIUM, headless: true }
      : { channel: 'chrome', headless: true });
    const page = await browser.newPage({ acceptDownloads: true });
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    await page.goto(url);
    await page.locator('details.cx-pages-branch > summary').click();
    const verify = async (name, filename, content) => {
      const pending = page.waitForEvent('download');
      await page.getByRole('link', { name, exact: false }).click();
      const download = await pending;
      assert.equal(download.suggestedFilename(), filename);
      assert.equal(readFileSync(await download.path(), 'utf8'), content);
      assert.equal(page.url(), url);
    };
    await verify('Download full JSON', 'codexia-' + sha + '-repomix.json', full);
    await verify('Gemini review', 'codexia-' + sha + '-review.md', geminiMarkdown);
    await verify('Download manifest', 'codexia-' + sha + '-manifest.json', snapshotManifest);
    await page.getByText('Download snapshot parts (1)', { exact: true }).click();
    await verify('frontend ·', 'codexia-' + sha + '-part-0001.json', part);
    await verify('Download branch index', 'codexia-branches.json', '{"branches":[]}');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
