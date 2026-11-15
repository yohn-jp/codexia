import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHeads, exclusion, splitFiles, validatePack, renderIndex, buildPortal, PART_LIMIT } from './export.mjs';

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
});
test('only regular source blobs, not credentials, data or branch-controlled packer configuration', () => {
  for (const path of ['.env.production', 'nested/.npmrc', 'secret.pem', 'data/work.md', 'evidence/run/output.json', '.repomixignore', 'repomix.config.ts', '../escape', '.git/config']) assert.ok(exclusion(path, '100644', 1), path);
  assert.ok(exclusion('link', '120000', 10));
  assert.ok(exclusion('submodule', '160000', 0));
  for (const path of ['.env.example', 'app/src/index.ts', '.github/workflows/verify.yml', 'evidence/README.md', 'pnpm-lock.yaml']) assert.equal(exclusion(path, '100644', 1), null, path);
});
test('split parts are bounded and reassemble every UTF-16 code unit of the packed input', () => {
  const files = { 'a.ts': 'small\n', 'b.ts': '😀\n"\\'.repeat(100_000), 'c.ts': '' };
  const output = splitFiles(files, sha);
  const restored = Object.create(null);
  for (const part of output) {
    assert.ok(Buffer.byteLength(part) <= PART_LIMIT);
    const parsed = JSON.parse(part);
    assert.equal(parsed.sourceSha, sha);
    for (const entry of parsed.entries) {
      assert.equal(entry.offset, (restored[entry.path] ?? '').length);
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
    writeFileSync(join(repo, '.env'), 'PRIVATE_TEST_VALUE=must-not-be-packed\n');
    writeFileSync(join(repo, '.repomixignore'), 'source.ts\n');
    writeFileSync(join(repo, 'repomix.config.ts'), 'throw new Error("branch config executed");\n');
    symlinkSync('/etc/passwd', join(repo, 'link'));
    git('add', '-A'); git('commit', '-qm', 'fixture');
    const first = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'source.ts'), 'export const value = 2;\n');
    git('add', 'source.ts'); git('commit', '-qm', 'second');
    const second = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'source.ts'), 'uncommitted text');
    const cache = join(root, 'cache');
    const run = (site, heads, executable = process.env.CODEXIA_AUDIT_REPOMIX_BIN) => buildPortal({ root: repo, site: join(root, site), cache, executable, heads });
    const a = run('site1', [{branch:'main',sha:second},{branch:'old',sha:first},{branch:'same',sha:second}]);
    assert.equal(a.snapshots[first].status, 'ready');
    assert.equal(a.snapshots[second].status, 'ready');
    const read = (site, id, file) => JSON.parse(readFileSync(join(root, site, 'snapshots', id, file), 'utf8'));
    assert.match(read('site1',first,'repomix.json').files['source.ts'], /value = 1/);
    assert.match(read('site1',second,'repomix.json').files['source.ts'], /value = 2/);
    const files = read('site1',second,'repomix.json').files;
    assert.equal(Object.hasOwn(files, '.env'), false);
    assert.equal(Object.hasOwn(files, 'link'), false);
    assert.equal(Object.hasOwn(files, 'repomix.config.ts'), false);
    const c = run('site2', [{branch:'main',sha:second}], '/does-not-exist');
    assert.equal(c.snapshots[second].status, 'ready');
    assert.equal(existsSync(join(root, 'site2', 'snapshots', first)), false);
    assert.equal(existsSync(join(cache, first)), false);
    writeFileSync(join(cache, second, 'repomix.json'), 'tampered');
    const d = run('site3', [{branch:'main',sha:second}], '/does-not-exist');
    assert.equal(d.snapshots[second].status, 'blocked');
    assert.equal(existsSync(join(root, 'site3', 'snapshots', second)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
