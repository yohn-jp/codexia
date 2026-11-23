import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decoratePage, decoratePages } from './navigation.mjs';

const page = { id: 'graph', title: 'Code Map', section: 'Code Map', mode: 'build snapshot', source: 'Graphify static analysis' };

test('decoratePage uses project-subpath-safe relative assets and destination links', () => {
  const html = '<!doctype html><html><head></head><body><main id="main-content"><h1>Graph</h1></main></body></html>';
  const decorated = decoratePage(html, { pagePath: 'graph/index.html', page });
  assert.match(decorated, /href="\.\.\/pages-ui\/navigation\.css"/);
  assert.match(decorated, /src="\.\.\/pages-ui\/navigation\.js"/);
  assert.match(decorated, /href="\.\.\/architecture\/"/);
  assert.match(decorated, /href="\.\.\/"/);
  assert.match(decorated, /class="cx-pages-skip" href="#main-content"/);
  assert.match(decorated, /class="cx-pages-page"/);
  assert.match(decorated, /<main id="main-content" tabindex="-1">/);
  assert.match(decorated, /aria-current="page"/);
  assert.match(decorated, /href="https:\/\/github\.com\/yohn-jp\/codexia\/tree\/main\/docs">GitHub Docs<\/a>/);
});

test('decoratePage adds a focusable main target without duplicating landmarks', () => {
  const decorated = decoratePage('<html><head></head><body><main>Content</main></body></html>', { pagePath: 'index.html', page: { ...page, id: 'overview' } });
  assert.match(decorated, /href="#main"/);
  assert.match(decorated, /<main id="main" tabindex="-1">/);
  assert.equal((decorated.match(/<main\b/g) ?? []).length, 1);
});

test('brand and overview links point to the site root at every page depth', () => {
  const examples = [
    ['index.html', './'],
    ['audit/index.html', '../'],
    ['ci/index.html', '../'],
    ['security/index.html', '../'],
    ['graph/index.html', '../'],
    ['architecture/index.html', '../'],
    [`reviews/${'a'.repeat(40)}/index.html`, '../../'],
    [`snapshots/${'b'.repeat(40)}/index.html`, '../../'],
  ];
  for (const [pagePath, expectedRoot] of examples) {
    const decorated = decoratePage('<html><head></head><body><main>Content</main></body></html>', { pagePath, page });
    assert.match(decorated, new RegExp(`class="cx-pages-brand" href="${expectedRoot.replaceAll('.', '\\.')}"`), pagePath);
    assert.match(decorated, new RegExp(`<a href="${expectedRoot.replaceAll('.', '\\.')}"[^>]*>概要</a>`), pagePath);
  }
});

test('decoratePage requires complete standalone HTML documents', () => {
  assert.throws(
    () => decoratePage('<html><body>Missing head</body></html>', { pagePath: 'audit/index.html', page }),
    /explicit head and body elements/,
  );
});

test('shared metadata allows unbroken SHA text to wrap on narrow screens', async () => {
  const css = await readFile(new URL('./navigation.css', import.meta.url), 'utf8');
  assert.match(css, /\.cx-pages-source,\s*\.cx-pages-mode\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.cx-pages-hero\s*>\s*\*\s*\{[^}]*min-inline-size:\s*0[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.cx-pages-branch-main\s*>\s*strong\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.doesNotMatch(css, /!important/u);
});

test('CLI decorates only selected entry points and preserves community HTML bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codexia-pages-ui-'));
  try {
    await mkdir(join(root, 'graph'), { recursive: true });
    await mkdir(join(root, 'reviews', 'a'.repeat(40)), { recursive: true });
    await writeFile(join(root, 'index.html'), '<html><head></head><body><main>Portal</main></body></html>');
    await writeFile(join(root, 'graph', 'index.html'), '<html><head></head><body><main>Graph</main></body></html>');
    const native = '<html><body>upstream bytes <script>keep()</script></body></html>\n';
    await writeFile(join(root, 'graph', 'communities.html'), native);
    await writeFile(join(root, 'reviews', 'a'.repeat(40), 'index.html'), '<html><head></head><body>Review</body></html>');
    const changed = await decoratePages(root);
    assert.deepEqual(changed, ['index.html', 'graph/index.html', `reviews/${'a'.repeat(40)}/index.html`]);
    assert.equal(await readFile(join(root, 'graph', 'communities.html'), 'utf8'), native);
    assert.match(await readFile(join(root, 'reviews', 'a'.repeat(40), 'index.html'), 'utf8'), /Review Materials/);
    assert.match(await readFile(join(root, 'pages-ui', 'navigation.js'), 'utf8'), /aria-expanded/);
    assert.deepEqual(await decoratePages(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
