#!/usr/bin/env node
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const SHA = /^[a-f0-9]{40}$/i;

const CORE_PAGES = new Map([
  ['index.html', { id: 'overview', title: 'Development Portal', section: '概要', mode: 'サイトマップ', source: 'Pages artifact' }],
  ['audit/index.html', { id: 'audit', title: 'Source Audit', section: 'Source Audit', mode: 'branch snapshots', source: 'Branch and snapshot materials' }],
  ['ci/index.html', { id: 'ci', title: 'CI Observatory', section: 'CI', mode: 'live public Actions metadata', source: 'GitHub Actions public API' }],
  ['graph/index.html', { id: 'graph', title: 'Code Map', section: 'Code Map', mode: 'build snapshot', source: 'Graphify static analysis' }],
  ['architecture/index.html', { id: 'architecture', title: 'Architecture Atlas', section: 'Architecture', mode: 'build snapshot', source: 'Canonical design documents' }],
]);

const NAV_ITEMS = [
  ['overview', '概要', ''],
  ['architecture', 'Architecture', 'architecture/'],
  ['graph', 'Code Map', 'graph/'],
  ['ci', 'CI', 'ci/'],
  ['audit', 'Source Audit', 'audit/'],
  ['docs', 'GitHub Docs', 'https://github.com/yohn-jp/codexia/tree/main/docs'],
];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function pathFromPage(pagePath, target) {
  const directory = dirname(pagePath);
  const depth = directory === '.' ? 0 : directory.split(sep).length;
  const prefix = depth === 0 ? './' : '../'.repeat(depth);
  return prefix + target;
}

function breadcrumbsFor(pagePath, page) {
  if (page.id === 'overview') return [];
  if (page.id === 'snapshot' || page.id === 'review') {
    const type = page.id === 'snapshot' ? 'Snapshots' : 'Reviews';
    return [
      { label: '概要', href: '' },
      { label: 'Source Audit', href: 'audit/' },
      { label: type, href: `audit/` },
      { label: page.id === 'snapshot' ? 'Snapshot detail' : 'Review detail', current: true },
    ];
  }
  return [
    { label: '概要', href: '' },
    { label: page.section, current: true },
  ];
}

function renderShell(pagePath, page, skipTarget) {
  const nav = NAV_ITEMS.map(([id, label, target]) => {
    const current = page.id === id || ((page.id === 'snapshot' || page.id === 'review') && id === 'audit');
    const href = target.startsWith('https://') ? target : pathFromPage(pagePath, target);
    return '<li><a href="' + escapeHtml(href) + '"' + (current ? ' aria-current="page"' : '') + '>' + escapeHtml(label) + '</a></li>';
  }).join('');
  const crumbs = breadcrumbsFor(pagePath, page).map(item => item.current
    ? '<li aria-current="page"><span>' + escapeHtml(item.label) + '</span></li>'
    : '<li><a href="' + escapeHtml(pathFromPage(pagePath, item.href)) + '">' + escapeHtml(item.label) + '</a></li>').join('');
  const provenanceSha = page.id === 'snapshot' || page.id === 'review' ? '' : page.sha;
  const context = '<div class="cx-pages-context" aria-label="ページ情報"><span class="cx-pages-page-title">' + escapeHtml(page.title) +
    '</span><span class="cx-pages-source">' + escapeHtml(page.source) + '</span><span class="cx-pages-mode">' + escapeHtml(page.mode) +
    (provenanceSha ? ' · <code class="cx-pages-code">' + escapeHtml(provenanceSha) + '</code>' : '') + '</span></div>';
  const breadcrumb = crumbs
    ? '<nav class="cx-pages-breadcrumbs" aria-label="パンくず"><ol>' + crumbs + '</ol></nav>'
    : '<span class="cx-pages-breadcrumbs" aria-hidden="true">概要</span>';
  return '<a class="cx-pages-skip" href="#' + escapeHtml(skipTarget) + '">本文へ移動</a>\n' +
    '<header class="cx-pages-header">\n' +
    '  <a class="cx-pages-brand" href="' + escapeHtml(pathFromPage(pagePath, '')) + '" aria-label="Codexia Development Portal">Codexia <span>/ Development</span></a>\n' +
    '  <button class="cx-pages-menu-button" type="button" aria-expanded="true" aria-controls="cx-pages-navigation">メニュー</button>\n' +
    '  <nav class="cx-pages-navigation" id="cx-pages-navigation" aria-label="サイト内"><ul>' + nav + '</ul></nav>\n' +
    '</header>\n' +
    '<div class="cx-pages-subheader">' + breadcrumb + context + '</div>';
}

function addPageClass(attributes) {
  const match = attributes.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
  const classes = match ? match[2].split(/\s+/u).filter(Boolean) : [];
  if (!classes.includes('cx-pages-page')) classes.push('cx-pages-page');
  if (match) return attributes.replace(match[0], 'class="' + escapeHtml(classes.join(' ')) + '"');
  return attributes + ' class="cx-pages-page"';
}

export function decoratePage(html, { pagePath, page }) {
  if (typeof html !== 'string' || !pagePath || !page) throw new TypeError('decoratePage requires HTML, pagePath, and page metadata');
  if (html.includes('class="cx-pages-header"')) return html;
  if (!/<html\b/i.test(html) || !/<head\b[^>]*>/i.test(html) || !/<\/head\s*>/i.test(html) || !/<body\b[^>]*>/i.test(html) || !/<\/body\s*>/i.test(html)) {
    throw new Error(`Expected a standalone HTML document with explicit head and body elements: ${pagePath}`);
  }
  const cssPath = escapeHtml(pathFromPage(pagePath, 'pages-ui/navigation.css'));
  const jsPath = escapeHtml(pathFromPage(pagePath, 'pages-ui/navigation.js'));
  const withStyles = html.replace(/<\/head\s*>/i, `<link rel="stylesheet" href="${cssPath}">\n</head>`);
  const mainOpening = withStyles.match(/<main\b[^>]*>/i)?.[0];
  let accessibleHtml = withStyles;
  let skipTarget = 'main';
  if (mainOpening) {
    const existingId = mainOpening.match(/\bid\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (existingId) skipTarget = existingId;
    const focusable = /\btabindex\s*=/i.test(mainOpening);
    if (!existingId || !focusable) {
      const replacement = mainOpening.replace(/>$/, `${existingId ? '' : ' id="main"'}${focusable ? '' : ' tabindex="-1"'}>`);
      accessibleHtml = accessibleHtml.replace(mainOpening, replacement);
    }
  } else {
    skipTarget = 'cx-pages-content';
  }
  const withHeader = accessibleHtml.replace(/<body([^>]*)>/i, (opening, attributes) => {
    const bodyId = attributes.match(/\bid\s*=\s*(["'])(.*?)\1/i)?.[2];
    const bodyFocusable = /\btabindex\s*=/i.test(attributes);
    const bodyAttributes = mainOpening ? attributes : `${attributes}${bodyId ? '' : ' id="cx-pages-content"'}${bodyFocusable ? '' : ' tabindex="-1"'}`;
    if (!mainOpening && bodyId) skipTarget = bodyId;
    return '<body' + addPageClass(bodyAttributes) + '>\n' + renderShell(pagePath, page, skipTarget);
  });
  if (withHeader === withStyles) throw new Error(`No <body> element found in ${pagePath}`);
  return withHeader.replace(/<\/body\s*>/i, `<script src="${jsPath}" defer></script>\n</body>`);
}

async function readSourceSha(siteRoot, pagePath, page) {
  if (page.sha) return page.sha;
  const candidates = page.id === 'graph'
    ? ['graph/source.json']
    : page.id === 'architecture'
      ? ['architecture/manifest.json']
      : [];
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(await readFile(join(siteRoot, candidate), 'utf8'));
      const value = data.sourceSha ?? data.sourceSHA ?? data.commitSha;
      if (typeof value === 'string' && SHA.test(value)) return value;
    } catch { /* A missing or malformed optional manifest remains unknown. */ }
  }
  return undefined;
}

async function findShaPages(siteRoot) {
  const pages = [];
  for (const [directory, id, title, label] of [
    ['snapshots', 'snapshot', 'Source Snapshot Artifacts', 'Snapshots'],
    ['reviews', 'review', 'Review Materials', 'Reviews'],
  ]) {
    let entries;
    try { entries = await readdir(join(siteRoot, directory), { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SHA.test(entry.name)) continue;
      const pagePath = `${directory}/${entry.name}/index.html`;
      try {
        const html = await readFile(join(siteRoot, pagePath), 'utf8');
        if (/<html\b/i.test(html) && /<body\b/i.test(html)) pages.push([pagePath, { id, title, section: label, mode: id === 'snapshot' ? 'snapshot artifact' : 'review materials', source: label, sha: entry.name }]);
      } catch { /* Only existing generated HTML is a target. */ }
    }
  }
  return pages;
}

export async function decoratePages(siteRoot) {
  const root = resolve(siteRoot);
  await mkdir(join(root, 'pages-ui'), { recursive: true });
  await Promise.all(['navigation.css', 'navigation.js'].map(file => copyFile(join(scriptDir, file), join(root, 'pages-ui', file))));
  const targets = [...CORE_PAGES.entries(), ...await findShaPages(root)];
  const changed = [];
  for (const [pagePath, initialPage] of targets) {
    const absolutePath = join(root, pagePath);
    let html;
    try { html = await readFile(absolutePath, 'utf8'); }
    catch { continue; }
    if (!/<html\b/i.test(html) || !/<body\b/i.test(html)) continue;
    const page = { ...initialPage, sha: await readSourceSha(root, pagePath, initialPage) };
    const decorated = decoratePage(html, { pagePath, page });
    if (decorated !== html) {
      await writeFile(absolutePath, decorated);
      changed.push(pagePath);
    }
  }
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const siteRoot = process.argv[2];
  if (!siteRoot) {
    process.stderr.write('Usage: node scripts/pages-ui/navigation.mjs SITE\n');
    process.exitCode = 2;
  } else {
    decoratePages(siteRoot).then(changed => {
      process.stdout.write(`Integrated shared Pages navigation into ${changed.length} page(s): ${changed.join(', ') || '(none found)'}\n`);
    }).catch(error => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
