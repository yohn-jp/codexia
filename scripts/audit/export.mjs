#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { containsCredentialPattern } from './publication-policy.mjs';

export const REPOMIX_VERSION = '1.19.0';
const config = fileURLToPath(new URL('./repomix.config.json', import.meta.url));
const publicationPolicy = new URL('./publication-policy.mjs', import.meta.url);
const self = fileURLToPath(import.meta.url);
const shaPattern = /^[a-f0-9]{40}$/u;
const maxBlob = 8 * 1024 * 1024;
const maxInput = 64 * 1024 * 1024;
const maxSite = 900 * 1024 * 1024;
export const PART_COUNT = 9;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = data => JSON.stringify(data, null, 2) + '\n';
const git = (root, args, options = {}) => execFileSync('git', args, { cwd: root, maxBuffer: maxInput + 4 * 1024 * 1024, ...options });
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const policy = () => hash(Buffer.concat([Buffer.from(REPOMIX_VERSION), readFileSync(self), readFileSync(config), readFileSync(publicationPolicy)]));

export function parseHeads(value) {
  const seen = new Set();
  const heads = value.trimEnd().split('\n').filter(Boolean).map(line => {
    const match = /^([a-f0-9]{40})\trefs\/heads\/(.+)$/u.exec(line);
    assert.ok(match && !/[\x00-\x1f\x7f]/u.test(match[2]), 'Invalid remote branch inventory');
    assert.ok(!seen.has(match[2]), 'Duplicate branch');
    seen.add(match[2]);
    return { branch: match[2], sha: match[1] };
  });
  assert.ok(heads.length, 'No remote branches found');
  return heads.sort((a, b) => order(a.branch, b.branch));
}

export function exclusion(path, mode, size) {
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git') || /[\x00-\x1f\x7f\\]/u.test(path)) return 'unsafe-path';
  if (!['100644', '100755'].includes(mode)) return 'non-regular-git-object';
  if (parts.some(p => ['node_modules', 'dist', 'build', 'coverage', '.turbo', '.pnpm-store', 'test-results', 'playwright-report', 'artifacts', 'results', 'data', 'host-history', '.arcadia'].includes(p))) return 'generated-or-private-data';
  if (parts[0] === 'evidence') return 'historical-evidence';
  // Exclude vendored agent guidance, but retain AGENTS.md, the lock and license.
  if (parts[0] === '.agents' && parts[1] === 'skills' && parts.length > 2) return 'vendored-agent-skill';
  const name = basename(path);
  if (/^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|id_rsa|id_ed25519|credentials(?:\..*)?|secrets?(?:\..*)?)$/iu.test(name) && name !== '.env.example') return 'sensitive-filename';
  if (/\.(?:pem|key|p12|pfx|sqlite(?:-wal|-shm)?|db|log|tsbuildinfo)$/iu.test(name)) return 'sensitive-or-generated-file';
  if (/^(?:\.repomixignore|\.repopackignore)$/iu.test(name) || (parts.length === 1 && /^(?:repomix|repopack)\.config(?:\..*)?$/iu.test(name))) return 'branch-controlled-packer-config';
  if (size > maxBlob) return 'oversized-blob';
  return null;
}

function inventory(root, sha, stage) {
  assert.match(sha, shaPattern);
  const records = decode(git(root, ['ls-tree', '-r', '-l', '-z', '--full-tree', sha])).split('\0').filter(Boolean);
  const included = [], excluded = [];
  let total = 0;
  for (const row of records) {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}) +(\d+|-)\t([\s\S]+)$/u.exec(row);
    assert.ok(match, 'Invalid Git tree entry');
    const [, mode, , oid, rawSize, path] = match;
    const size = rawSize === '-' ? 0 : Number(rawSize);
    const reason = exclusion(path, mode, size);
    if (reason) { excluded.push({ path, reason }); continue; }
    assert.ok(Number.isSafeInteger(size) && size >= 0, 'Invalid blob size');
    const bytes = git(root, ['cat-file', 'blob', oid], { maxBuffer: maxBlob + 1024 });
    assert.equal(bytes.length, size);
    let content;
    try { content = decode(bytes); } catch { excluded.push({ path, reason: 'non-utf8' }); continue; }
    if (content.includes('\0')) { excluded.push({ path, reason: 'binary' }); continue; }
    if (containsCredentialPattern(content)) { excluded.push({ path, reason: 'credential-pattern' }); continue; }
    total += size;
    assert.ok(total <= maxInput, 'Snapshot exceeds input budget');
    const target = join(stage, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx' });
    included.push({ path, bytes: size, sha256: hash(bytes) });
  }
  assert.ok(included.length, 'No source files selected');
  return { included, excluded };
}

export function reviewScope(path) {
  const [root, child] = path.split('/');
  if (root === 'docs' || ['AGENTS.md','README.md','CONTRIBUTING.md','SECURITY.md','LICENSE'].includes(root)) return '01-architecture';
  if (root === 'app') return '02-frontend';
  if (root === 'packages') {
    if (child === 'api') return '04-api';
    if (['persistence-postgres','persistence-contracts','migration'].includes(child)) return '05-persistence';
    return '03-core-contracts';
  }
  if (root === 'modules') return ['story','assistant','speaker'].includes(child) ? '06-authoring-modules' : '07-platform-modules';
  if (['buildkit','deploy','edge','profiles','.github','Dockerfile','Dockerfile.backend'].includes(root)) return '08-infrastructure-ci';
  return '09-verification-tooling';
}

/** Each responsibility group is one complete, independently readable JSON file. */
export function splitFiles(files, sha) {
  const groups = new Map();
  for (const path of Object.keys(files).sort(order)) {
    assert.equal(typeof files[path], 'string');
    const scope = reviewScope(path);
    if (!groups.has(scope)) groups.set(scope, []);
    groups.get(scope).push({ path, offset: 0, content: files[path] });
  }
  return [...groups].sort(([a],[b]) => order(a,b)).map(([scope, entries]) => ({scope, content: json({schemaVersion: 1, sourceSha: sha, scope, entries})}));
}

export function validatePack(pack, inventory) {
  assert.ok(pack && typeof pack.files === 'object' && pack.files && !Array.isArray(pack.files), 'Unexpected Repomix JSON format');
  const expected = new Map(inventory.included.map(file => [file.path, file]));
  const included = [];
  for (const path of Object.keys(pack.files).sort(order)) {
    const file = expected.get(path);
    assert.ok(file && typeof pack.files[path] === 'string', 'Unexpected packed path');
    included.push(file);
    expected.delete(path);
  }
  // Repomix may exclude a secret or another unsupported file. Never reconstruct
  // omitted content from Git or silently describe the export as complete.
  const excluded = [...inventory.excluded, ...[...expected.keys()].map(path => ({ path, reason: 'repomix-omitted (security or packer filtering)' }))].sort((a,b) => order(a.path,b.path));
  assert.ok(included.length, 'Repomix returned no source files');
  return { included, excluded, partial: expected.size > 0 || excluded.some(file => file.reason === 'credential-pattern') };
}

function snapshot(root, sha, dest, executable, policyHash) {
  const temp = mkdtempSync(join(tmpdir(), 'codexia-audit-'));
  try {
    const stage = join(temp, 'source');
    mkdirSync(stage);
    const selected = inventory(root, sha, stage);
    const output = join(temp, 'packed.json');
    const result = spawnSync(executable, [stage, '--config', config, '--style', 'json', '--output', output, '--no-gitignore', '--no-dot-ignore', '--no-default-patterns', '--quiet'], {
      cwd: temp, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 5 * 60_000,
      // Do not print packer diagnostics: they could contain source/secret values.
    });
    if (result.error || result.status !== 0 || !existsSync(output)) throw new Error('Repomix failed');
    const pack = JSON.parse(readFileSync(output, 'utf8'));
    const selection = validatePack(pack, selected);
    const full = json({ ...pack, audit: { sourceSha: sha, policySha256: policyHash, repomixVersion: REPOMIX_VERSION, status: selection.partial ? 'partial' : 'ready' } });
    mkdirSync(dest, { recursive: true });
    const outputs = [];
    function emit(name, text, scope) {
      const bytes = Buffer.from(text);
      writeFileSync(join(dest, name), bytes, { flag: 'wx' });
      outputs.push({ name, bytes: bytes.length, sha256: hash(bytes), ...(scope ? { scope } : {}) });
    }
    emit('repomix.json', full);
    const parts = splitFiles(pack.files, sha);
    parts.forEach((part, index) => emit('part-' + String(index + 1).padStart(4, '0') + '.json', part.content, part.scope));
    const manifest = { schemaVersion: 1, sourceSha: sha, policySha256: policyHash, repomixVersion: REPOMIX_VERSION,
      status: selection.partial ? 'partial' : 'ready', files: selection.included, excluded: selection.excluded, outputs };
    writeFileSync(join(dest, 'manifest.json'), json(manifest), { flag: 'wx' });
    return manifest;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

function cachedSnapshot(dir, sha, policyHash) {
  if (!existsSync(dir)) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.sourceSha, sha);
    assert.equal(manifest.policySha256, policyHash);
    assert.equal(manifest.repomixVersion, REPOMIX_VERSION);
    assert.ok(['ready', 'partial'].includes(manifest.status));
    assert.ok(Array.isArray(manifest.files) && manifest.files.length && Array.isArray(manifest.excluded) && Array.isArray(manifest.outputs));
    const names = new Set(['manifest.json']);
    for (const item of manifest.outputs) {
      assert.match(item.name, /^(?:repomix\.json|part-\d{4,}\.json)$/u);
      assert.ok(!names.has(item.name));
      names.add(item.name);
      const bytes = readFileSync(join(dir, item.name));
      assert.equal(bytes.length, item.bytes);
      assert.equal(hash(bytes), item.sha256);
    }
    assert.ok(names.has('repomix.json') && names.size >= 3);
    assert.deepEqual(readdirSync(dir).sort(order), [...names].sort(order));
    const full = JSON.parse(readFileSync(join(dir, 'repomix.json'), 'utf8'));
    assert.equal(full.audit.sourceSha, sha);
    assert.equal(full.audit.policySha256, policyHash);
    assert.deepEqual(Object.keys(full.files).sort(order), manifest.files.map(file => file.path).sort(order));
    return manifest;
  } catch { return null; }
}

const escapeHtml = value => String(value).replace(/[&<>"']/gu, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
function sizeLabel(bytes) {
  return bytes >= 1_000_000 ? (bytes / 1_000_000).toFixed(2) + ' MB' : Math.ceil(bytes / 1000) + ' KB';
}
function downloadLink(base, name, filename, label, className = '') {
  return '<a class="' + escapeHtml(className) + '" href="' + escapeHtml(base + name) + '" download="' + escapeHtml(filename) + '">' + escapeHtml(label) + '</a>';
}
export function renderIndex(manifest, { base = '' } = {}) {
  const anchored = new Set();
  const rows = manifest.branches.map(branch => {
    const snap = manifest.snapshots[branch.sha];
    const snapshotBase = base + 'snapshots/' + branch.sha + '/';
    const prefix = 'codexia-' + branch.sha + '-';
    const rowId = anchored.has(branch.sha) ? '' : ' id="sha-' + escapeHtml(branch.sha) + '"';
    anchored.add(branch.sha);
    let links = 'Not published';
    if (snap.status !== 'blocked') {
      const full = snap.outputs.find(x => x.name === 'repomix.json');
      assert.ok(full, 'Missing full export');
      const parts = snap.outputs.filter(x => x.name.startsWith('part-'));
      links = '<div class="actions"><a href="' + snapshotBase + '">Snapshot details</a>' +
        downloadLink(snapshotBase, full.name, prefix + full.name, 'Download full JSON · ' + sizeLabel(full.bytes), 'primary') +
        downloadLink(snapshotBase, 'manifest.json', prefix + 'manifest.json', 'Download manifest') +
        '<a href="' + snapshotBase + 'repomix.json">View JSON</a></div>' +
        '<div class="actions review-parts">' +
        parts.map((item, i) => downloadLink(snapshotBase, item.name, prefix + item.name, item.scope.slice(3).replaceAll('-', ' ') + ' · ' + sizeLabel(item.bytes))).join('') +
        '</div>';
    }
    const review = manifest.reviews?.[branch.sha];
    if (review && (review.status === 'ready' || review.status === 'partial')) {
      links += '<div class="actions review-parts">' +
      downloadLink(base + 'reviews/' + branch.sha + '/', 'gemini-review.md', 'codexia-' + branch.sha + '-review.md',
          'Gemini review · 1 Markdown (' + review.published + ' source files)' + (review.status === 'partial' ? ' · partial' : ''), 'primary') +
        '<a href="' + base + 'reviews/' + branch.sha + '/index.html">Review coverage</a></div>';
    } else if (review?.status === 'blocked') {
      links += '<div>OCR review inputs unavailable</div>';
    }
    return '<tr' + rowId + '><th scope="row">' + escapeHtml(branch.branch) + '</th><td><code>' + escapeHtml(branch.sha) + '</code></td><td>' + escapeHtml(snap.status) + '</td><td>' + (snap.fileCount ?? '—') + '</td><td>' + links + '</td></tr>';
  }).join('\n');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codexia source audit</title><style>body{font:16px system-ui,sans-serif;max-width:1200px;margin:40px auto;padding:0 20px;color:#24292f}table{border-collapse:collapse;width:100%}th,td{padding:12px;text-align:left;vertical-align:top;border-bottom:1px solid #d0d7de;overflow-wrap:anywhere}code{font-size:12px}a{color:#0969da}.scroll{overflow:auto}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.actions a{display:inline-block;padding:6px 10px;border:1px solid #d0d7de;border-radius:6px;text-decoration:none}.actions .primary{background:#0969da;color:white;border-color:#0969da}.review-parts{margin-top:8px}td:nth-child(3),td:nth-child(4){white-space:nowrap}</style></head><body><main><h1>Codexia source audit</h1><p>Observed remote HEADs: ' + escapeHtml(manifest.observedAt) + '. Repomix ' + REPOMIX_VERSION + '. This is source review material, not release certification. Historical evidence and vendored agent skills are excluded; see each manifest for all excluded files. Partial exports omit additional files. A blocked snapshot has no downloadable source. Branches may advance between refreshes.</p><p>' + downloadLink(base, 'manifest.json', 'codexia-branches.json', 'Download branch index') + '</p><div class="scroll"><table><thead><tr><th>Branch</th><th>Commit</th><th>Status</th><th>Files</th><th>Downloads</th></tr></thead><tbody>' + rows + '</tbody></table></div></main></body></html>';
}

export function buildPortal({ root, site, cache, executable, heads, observedAt = new Date().toISOString() }) {
  assert.ok(!existsSync(site), 'Site output must not exist');
  const policyHash = policy();
  const manifest = { schemaVersion: 1, observedAt, repomixVersion: REPOMIX_VERSION, policySha256: policyHash, branches: heads, snapshots: {} };
  mkdirSync(site, { recursive: true });
  mkdirSync(cache, { recursive: true });
  let bytes = 0;
  for (const sha of [...new Set(heads.map(head => head.sha))].sort(order)) {
    assert.match(sha, shaPattern);
    const cached = join(cache, sha);
    const dest = join(site, 'snapshots', sha);
    let result = cachedSnapshot(cached, sha, policyHash);
    try {
      if (!result) {
        rmSync(cached, { recursive: true, force: true });
        result = snapshot(root, sha, cached, executable, policyHash);
      }
      bytes += result.outputs.reduce((total, item) => total + item.bytes, 0) + statSync(join(cached, 'manifest.json')).size;
      assert.ok(bytes <= maxSite, 'Pages size budget exceeded');
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(cached, dest, { recursive: true, errorOnExist: true, force: false });
      manifest.snapshots[sha] = { status: result.status, fileCount: result.files.length, excludedCount: result.excluded.length, outputs: result.outputs };
    } catch (error) {
      rmSync(dest, { recursive: true, force: true });
      rmSync(cached, { recursive: true, force: true });
      if (error.message === 'Pages size budget exceeded') throw error;
      manifest.snapshots[sha] = { status: 'blocked', reason: 'snapshot export or security verification failed' };
    }
  }
  // Cache is an optimization only; deleted HEADs are never copied into the site.
  for (const name of readdirSync(cache)) if (shaPattern.test(name) && !manifest.snapshots[name]) rmSync(join(cache, name), { recursive: true, force: true });
  writeFileSync(join(site, 'manifest.json'), json(manifest));
  mkdirSync(join(site, 'audit'), { recursive: true });
  writeFileSync(join(site, 'audit', 'index.html'), renderIndex(manifest, { base: '../' }));
  writeFileSync(join(site, '.nojekyll'), '');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  const [site, cache, executable] = process.argv.slice(2);
  assert.ok(site && cache && executable && process.argv.length === 5, 'Usage: node scripts/audit/export.mjs SITE CACHE REPOMIX_BIN');
  assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), REPOMIX_VERSION);
  const root = resolve('.');
  const heads = parseHeads(decode(git(root, ['ls-remote', '--heads', 'origin'])));
  const observedAt = new Date().toISOString();
  for (const sha of new Set(heads.map(head => head.sha))) {
    try { git(root, ['cat-file', '-e', sha + '^{commit}']); }
    catch { git(root, ['fetch', '--no-tags', 'origin', sha], { stdio: 'ignore' }); }
  }
  const result = buildPortal({ root, site: resolve(site), cache: resolve(cache), executable: resolve(executable), heads, observedAt });
  console.log('Audited ' + heads.length + ' branches; ' + Object.keys(result.snapshots).length + ' distinct HEADs; ' + Object.values(result.snapshots).filter(x => x.status === 'blocked').length + ' blocked.');
}
