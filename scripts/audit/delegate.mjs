#!/usr/bin/env node
// Deterministic, LLM-free OCR delegation inputs for the existing Repomix audit portal.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exclusion, renderIndex } from './export.mjs';

export const OCR_VERSION = '1.13.13';
const self = fileURLToPath(import.meta.url);
const shaPattern = /^[a-f0-9]{40}$/u;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 72 * 1024 * 1024 });
const cleanPath = path => typeof path === 'string' && exclusion(path, '100644', 0) === null;

function loadPack(site, sha) {
  assert.match(sha, shaPattern);
  const dir = join(site, 'snapshots', sha);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const pack = JSON.parse(readFileSync(join(dir, 'repomix.json'), 'utf8'));
  assert.equal(manifest.sourceSha, sha);
  assert.equal(pack.audit.sourceSha, sha);
  assert.deepEqual(Object.keys(pack.files).sort(), manifest.files.map(f => f.path).sort());
  return pack.files;
}

function invokeOCR(root, bin, action, base, head, paths = []) {
  const args = ['delegate', action, '--format', 'json', '--repo', root,
    '--rule', join(root, 'scripts/audit/delegate.rules.json'), '--from', base, '--to', head];
  if (paths.length) args.push('--', ...paths);
  const raw = execFileSync(bin, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  const data = JSON.parse(raw);
  assert.equal(data.schema_version, '1');
  return data;
}

function renameSources(root, base, head) {
  const data = execFileSync('git', ['--no-pager', 'diff', '--name-status', '-z', '--find-renames', base, head], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }).split('\0');
  const result = new Map();
  for (let i = 0; i < data.length && data[i];) {
    const status = data[i++];
    const old = data[i++];
    if (/^[RC]\d+$/u.test(status)) result.set(data[i++], old);
  }
  return result;
}

function checkedPreview(preview, base, head, mergeBase) {
  assert.equal(preview.mode, 'range');
  assert.equal(preview.from, base);
  assert.equal(preview.to, head);
  assert.equal(preview.merge_base, mergeBase);
  assert.ok(Array.isArray(preview.reviewable_files) && Array.isArray(preview.excluded_files));
  assert.equal(preview.reviewable_count, preview.reviewable_files.length);
  assert.equal(preview.excluded_count, preview.excluded_files.length);
  assert.equal(preview.total_files, preview.reviewable_count + preview.excluded_count);
  const seen = new Set();
  for (const entry of [...preview.reviewable_files, ...preview.excluded_files]) {
    assert.equal(typeof entry.path, 'string');
    assert.equal(typeof entry.status, 'string');
    assert.ok(Number.isSafeInteger(entry.insertions) && entry.insertions >= 0);
    assert.ok(Number.isSafeInteger(entry.deletions) && entry.deletions >= 0);
    assert.ok(!seen.has(entry.path), 'Duplicate OCR preview path');
    seen.add(entry.path);
  }
  return {
    schema_version: '1', mode: 'range', from: base, to: head, merge_base: mergeBase,
    total_files: preview.total_files, reviewable_count: preview.reviewable_count,
    excluded_count: preview.excluded_count, total_insertions: preview.total_insertions,
    total_deletions: preview.total_deletions, reviewable_files: preview.reviewable_files,
    excluded_files: preview.excluded_files,
  };
}

function trustedPreimage(root, mergeBase, oldPath, mainFiles) {
  if (!oldPath || !cleanPath(oldPath) || !Object.hasOwn(mainFiles, oldPath)) return false;
  try { return git(root, ['show', `${mergeBase}:${oldPath}`]) === mainFiles[oldPath]; }
  catch { return false; }
}

function fenced(content) {
  const backtickRuns = content.match(/`+/gu) ?? [];
  const fence = '`'.repeat(Math.max(3, ...backtickRuns.map(s => s.length + 1)));
  return fence + '\n' + content.replace(/\n?$/u, '\n') + fence;
}

function recordFile(root, entry, head, mergeBase, headFiles, mainFiles, rule, oldPath) {
  const path = entry.path;
  if (!cleanPath(path) || !Object.hasOwn(headFiles, path)) return { reason: 'not-in-verified-head-export' };
  if (oldPath && !cleanPath(oldPath)) return { reason: 'unsafe-rename-source' };
  // The exact source must be the same immutable Git blob accepted by Repomix.
  if (git(root, ['show', `${head}:${path}`]) !== headFiles[path]) return { reason: 'packed-source-mismatch' };
  const verifiedOld = trustedPreimage(root, mergeBase, oldPath, mainFiles);
  let patch = git(root, ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--no-color',
    '--no-renames', mergeBase, head, '--', ...[...new Set([oldPath, path].filter(Boolean))].map(x => ':(literal)' + x)]);
  if (oldPath && !verifiedOld) {
    patch = patch.split('\n').map(line => line.startsWith('-') && !line.startsWith('--- ')
      ? '-[removed line withheld: preimage not present in verified main export]' : line).join('\n');
  }
  const body = [
    '# OCR Delegate review input',
    '',
    `- Path: ${JSON.stringify(path)}`,
    `- Status: ${entry.status}`,
    `- Base: ${mergeBase}`,
    `- Head: ${head}`,
    `- Old path: ${oldPath ? JSON.stringify(oldPath) : '(new file)'}`,
    `- Preimage: ${oldPath ? (verifiedOld ? 'verified against main Repomix' : 'unverified; removed lines redacted') : 'not applicable'}`,
    `- Insertions/deletions (OCR): +${entry.insertions}/-${entry.deletions}`,
    '', '# OCR rules', '', fenced(rule), '', '# Unified diff', '', fenced(patch),
    '', '# Full file at head', '', fenced(headFiles[path]), '',
    'Review this file and relevant cross-file behavior. Report reachable defects with evidence; do not claim that this input is a completed review.',
    '',
  ].join('\n');
  return { content: body, preimage: oldPath ? (verifiedOld ? 'verified' : 'redacted') : 'none' };
}

function emit(dir, name, content, outputs) {
  const target = join(dir, name);
  mkdirSync(dirname(target), { recursive: true });
  const bytes = Buffer.from(content, 'utf8');
  writeFileSync(target, bytes, { flag: 'wx' });
  outputs.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
}

function indexHtml(sha, rows) {
  const escape = value => String(value).replace(/[&<>"']/gu, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  return '<!doctype html><html lang="en"><meta charset="utf-8"><title>OCR Delegate ' + sha + '</title>' +
    '<h1>OCR Delegate inputs</h1><p>Source SHA: <code>' + sha + '</code>. This is a review input, not a completed review.</p>' +
    '<p><a href="index.md">Markdown index</a> · <a href="manifest.json">Manifest</a> · <a href="preview.json">OCR preview</a> · <a href="rules.json">Rules</a></p><ol>' +
    rows.map(row => '<li><a href="' + row.document + '">' + escape(row.path) + '</a> (' + escape(row.status) + ')</li>').join('') + '</ol></html>\n';
}

function oneBranch({ root, site, bin, base, head, mainFiles, headFiles }) {
  const mergeBase = git(root, ['merge-base', base, head]).trim();
  assert.match(mergeBase, shaPattern);
  const preview = checkedPreview(invokeOCR(root, bin, 'preview', base, head), base, head, mergeBase);
  const candidates = preview.reviewable_files.filter(item => cleanPath(item.path) && Object.hasOwn(headFiles, item.path));
  const rules = { schema_version: '1', groups: [] };
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const batch = invokeOCR(root, bin, 'rule', base, head, candidates.slice(offset, offset + 100).map(e => e.path));
    assert.ok(Array.isArray(batch.groups), 'Invalid OCR rule groups');
    rules.groups.push(...batch.groups);
  }
  assert.ok(Array.isArray(rules.groups));
  const perFileRules = new Map();
  const allowed = new Set(candidates.map(item => item.path));
  for (const group of rules.groups) {
    assert.ok(typeof group.rule === 'string' && group.rule.length > 0 && Array.isArray(group.files));
    for (const path of group.files) {
      assert.ok(allowed.has(path) && !perFileRules.has(path), 'Unexpected/duplicate OCR rule target');
      perFileRules.set(path, group.rule);
    }
  }
  assert.equal(perFileRules.size, candidates.length, 'OCR rules do not cover every eligible file');
  const renames = renameSources(root, mergeBase, head);
  const dest = join(site, 'reviews', head);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const outputs = [], files = [], skipped = [];
  for (const entry of preview.reviewable_files) {
    if (!allowed.has(entry.path)) { skipped.push({ path: entry.path, status: entry.status, reason: 'not-in-verified-head-export' }); continue; }
    const oldPath = entry.status === 'added' ? null : (renames.get(entry.path) ?? entry.path);
    const result = recordFile(root, entry, head, mergeBase, headFiles, mainFiles, perFileRules.get(entry.path), oldPath);
    if (!result.content) { skipped.push({ path: entry.path, status: entry.status, reason: result.reason }); continue; }
    const document = 'files/' + String(files.length + 1).padStart(4, '0') + '.md';
    emit(dest, document, result.content, outputs);
    files.push({ path: entry.path, status: entry.status, insertions: entry.insertions, deletions: entry.deletions,
      document, preimage: result.preimage });
  }
  emit(dest, 'preview.json', json(preview), outputs);
  emit(dest, 'rules.json', json(rules), outputs);
  emit(dest, 'index.md', '# OCR Delegate — ' + head + '\n\n' +
    'Source: `' + head + '`; comparison from main `' + base + '` (merge-base `' + mergeBase + '`).\n\n' +
    'OCR preview and rules select review inputs; no AI review is executed here.\n\n' +
    files.map(file => '- [' + JSON.stringify(file.path) + '](' + file.document + ') (' + file.status + ')').join('\n') + '\n\n' +
    (skipped.length ? '## Not published\n\n' + skipped.map(x => '- ' + JSON.stringify(x.path) + ': ' + x.reason).join('\n') + '\n' : '') +
    '\nRefer to `preview.json` for OCR-excluded files and `manifest.json` for publication coverage.\n', outputs);
  emit(dest, 'index.html', indexHtml(head, files), outputs);
  const summary = { status: skipped.length ? 'partial' : 'ready', sourceSha: head, baseSha: base, mergeBase,
    ocrVersion: OCR_VERSION, selected: preview.reviewable_count, published: files.length,
    omitted: skipped.length, excludedByOcr: preview.excluded_count, files, skipped, outputs };
  writeFileSync(join(dest, 'manifest.json'), json(summary), { flag: 'wx' });
  return { status: summary.status, selected: summary.selected, published: summary.published, omitted: summary.omitted };
}

export function buildDelegation({ root, site, bin }) {
  const manifestPath = join(site, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const main = manifest.branches.find(b => b.branch === 'main');
  assert.ok(main && shaPattern.test(main.sha), 'Main branch not found');
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim();
  assert.ok(version.includes(OCR_VERSION), 'Unexpected OCR version: ' + version);
  manifest.ocrVersion = OCR_VERSION;
  manifest.reviews = {};
  const base = main.sha;
  const mainFiles = manifest.snapshots[base]?.status === 'blocked' ? null : loadPack(site, base);
  for (const head of [...new Set(manifest.branches.map(b => b.sha))].sort()) {
    if (head === base) { manifest.reviews[head] = { status: 'no-diff' }; continue; }
    if (!mainFiles || manifest.snapshots[head]?.status === 'blocked') {
      manifest.reviews[head] = { status: 'blocked', reason: 'base-or-head-source-unavailable' }; continue;
    }
    try {
      const headFiles = loadPack(site, head);
      manifest.reviews[head] = oneBranch({ root, site, bin, base, head, mainFiles, headFiles });
    } catch (error) {
      rmSync(join(site, 'reviews', head), { recursive: true, force: true });
      manifest.reviews[head] = { status: 'blocked', reason: 'delegate-export-failed' };
      console.error('OCR delegation blocked for SHA ' + head + ': ' + error.message.split('\n')[0]);
    }
  }
  // Preserve the existing 900 MB Pages budget; there is no per-file splitting or size limit.
  const baseBytes = Object.values(manifest.snapshots).flatMap(s => s.outputs ?? []).reduce((n, o) => n + o.bytes, 0);
  let remaining = 900 * 1024 * 1024 - baseBytes;
  for (const sha of Object.keys(manifest.reviews).sort()) {
    const review = manifest.reviews[sha];
    if (!['ready', 'partial'].includes(review.status)) continue;
    const folder = join(site, 'reviews', sha);
    const detail = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
    const bytes = detail.outputs.reduce((n, o) => n + o.bytes, 0) + Buffer.byteLength(json(detail));
    if (bytes > remaining) {
      rmSync(folder, { recursive: true, force: true });
      manifest.reviews[sha] = { status: 'blocked', reason: 'pages-site-budget-exceeded' };
    } else remaining -= bytes;
  }
  writeFileSync(manifestPath, json(manifest));
  writeFileSync(join(site, 'index.html'), renderIndex(manifest));
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  const [site, bin] = process.argv.slice(2);
  assert.ok(site && bin && process.argv.length === 4, 'Usage: node scripts/audit/delegate.mjs SITE OCR_BIN');
  const result = buildDelegation({ root: resolve('.'), site: resolve(site), bin: resolve(bin) });
  console.log('OCR delegation: ' + Object.values(result.reviews).filter(x => x.status === 'ready' || x.status === 'partial').length +
    ' review bundles; ' + Object.values(result.reviews).filter(x => x.status === 'blocked').length + ' blocked.');
}
