import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildDelegation } from './delegate.mjs';

const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
function fixture(featureContent = 'export const value = 2;\n') {
  const base = mkdtempSync(join(tmpdir(), 'delegate-test-'));
  const root = join(base, 'repo');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  const write = (path, value) => { const dest = join(root, path); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, value); };
  write('src/alpha.ts', 'export const value = 1;\n');
  write('.env', 'PRIVATE=initial-secret\n');
  write('scripts/audit/delegate.rules.json', JSON.stringify({ rules: [{ path: '**/*', rule: 'Review changed behavior', merge_system_rule: true }] }));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  const ancestor = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-qb', 'feature');
  write('src/alpha.ts', featureContent);
  write('.env', 'PRIVATE=do-not-leak\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'feature');
  const feature = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'main');
  write('src/alpha.ts', 'export const value = 3;\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'main advanced');
  const main = git(root, 'rev-parse', 'HEAD');
  const site = join(base, 'site');
  const bin = join(base, 'fake-ocr.mjs');
  writeFileSync(bin, `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('ocr version 1.13.13');process.exit(0)}
const from=a[a.indexOf('--from')+1],to=a[a.indexOf('--to')+1],repo=a[a.indexOf('--repo')+1];
if(a[1]==='preview'){
 const merge_base=execFileSync('git',['merge-base',from,to],{cwd:repo,encoding:'utf8'}).trim();
 console.log(JSON.stringify({schema_version:'1',mode:'range',repository:repo,from,to,merge_base,
  total_files:2,reviewable_count:2,excluded_count:0,total_insertions:2,total_deletions:2,
  reviewable_files:[{path:'src/alpha.ts',status:'modified',insertions:1,deletions:1},{path:'.env',status:'modified',insertions:1,deletions:1}],excluded_files:[]}));
} else if(a[1]==='rule'){
 const paths=a.slice(a.indexOf('--')+1);
 console.log(JSON.stringify({schema_version:'1',groups:[{group_id:1,source:'built-in',pattern:'*',files:paths,rule:'Check regressions'}]}));
} else process.exit(1);
`);
  chmodSync(bin, 0o755);
  for (const [sha, value] of [[main, 'export const value = 3;\n'], [feature, featureContent]]) {
    const folder = join(site, 'snapshots', sha);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'repomix.json'), JSON.stringify({ audit: { sourceSha: sha }, files: { 'src/alpha.ts': value.replace(/\n$/u, '') } }));
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ sourceSha: sha, files: [{ path: 'src/alpha.ts' }] }));
  }
  writeFileSync(join(site, 'manifest.json'), JSON.stringify({ branches: [{ branch: 'feature', sha: feature }, { branch: 'main', sha: main }],
    snapshots: { [feature]: { status: 'ready', outputs: [{ name: 'repomix.json', bytes: 1 }] }, [main]: { status: 'ready', outputs: [{ name: 'repomix.json', bytes: 1 }] } } }));
  return { base, root, site, bin, ancestor, feature, main };
}

test('one Gemini Markdown covers all verified files and redacts unverified deleted lines', () => {
  const f = fixture();
  try {
    const result = buildDelegation(f);
    assert.equal(result.reviews[f.main].status, 'no-diff');
    assert.equal(result.reviews[f.feature].status, 'partial');
    assert.equal(result.reviews[f.feature].selected, 2);
    assert.equal(result.reviews[f.feature].published, 1);
    const dir = join(f.site, 'reviews', f.feature);
    const summary = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(summary.baseSha, f.main);
    assert.equal(summary.mergeBase, f.ancestor);
    assert.deepEqual(summary.files.map(x => x.path), ['src/alpha.ts']);
    assert.deepEqual(summary.skipped.map(x => x.path), ['.env']);
    const text = readFileSync(join(dir, 'gemini-review.md'), 'utf8');
    assert.match(text, /export const value = 2;/);
    assert.match(text, /Check regressions/);
    assert.match(text, /PACKET_ID/);
    assert.match(text, /END_OF_PACKET/);
    assert.match(text, /INCLUDED:\*\* 1/);
    assert.match(text, /not-in-verified-head-export/);
    assert.match(text, /HEAD_SHA:/);
    const compact = readFileSync(join(dir, 'gemini-diff.md'), 'utf8');
    assert.match(compact, /Limited context/);
    assert.doesNotMatch(compact, /#### Complete source at HEAD/);
    assert.match(compact, /Required review output/);
    assert.match(compact, /END_OF_PACKET/);
    assert.ok(!existsSync(join(dir, 'files')));
    assert.match(text, /removed line withheld/);
    assert.doesNotMatch(text, /export const value = 1;/);
    assert.doesNotMatch(text, /do-not-leak/);
    assert.ok(existsSync(join(dir, 'preview.json')));
    assert.ok(existsSync(join(dir, 'rules.json')));
    assert.match(readFileSync(join(f.site, 'index.html'), 'utf8'), new RegExp(f.feature));
    for (const output of summary.outputs) {
      assert.ok(existsSync(join(dir, output.name)));
      const content = readFileSync(join(dir, output.name));
      assert.equal(output.bytes, content.length);
      assert.equal(output.sha256, createHash('sha256').update(content).digest('hex'));
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a verified zero-byte source is included with its deletion diff in both packets', () => {
  const f = fixture('');
  try {
    const result = buildDelegation(f);
    const dir = join(f.site, 'reviews', f.feature);
    assert.equal(result.reviews[f.feature].published, 1);
    const summary = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(summary.files.map(file => file.path), ['src/alpha.ts']);
    assert.deepEqual(summary.skipped.map(file => file.path), ['.env']);
    const emptyHash = createHash('sha256').update('').digest('hex');
    for (const name of ['gemini-review.md', 'gemini-diff.md']) {
      const packet = readFileSync(join(dir, name), 'utf8');
      assert.ok(packet.includes(emptyHash));
      assert.match(packet, /@@ -1 \+0,0 @@/u);
      assert.match(packet, /END_OF_PACKET [a-f0-9]+ INCLUDED=1/u);
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('bad schema blocks only that branch without publishing a partial review', () => {
  const f = fixture();
  try {
    writeFileSync(f.bin, '#!/usr/bin/env node\nif(process.argv[2]==="--version") console.log("1.13.13"); else console.log(JSON.stringify({schema_version:"bad"}));\n');
    const result = buildDelegation(f);
    assert.equal(result.reviews[f.feature].status, 'blocked');
    assert.equal(existsSync(join(f.site, 'reviews', f.feature)), false);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('compact packet preserves fenced diff containing a source heading collision', () => {
  const f = fixture();
  try {
    const target = join(f.root, 'src/alpha.ts');
    git(f.root, 'checkout', '-q', 'feature');
    writeFileSync(target, 'export const value = 2;\n# Full file at head\n');
    git(f.root, 'add', 'src/alpha.ts'); git(f.root, 'commit', '-qm', 'add heading collision');
    const head = git(f.root, 'rev-parse', 'HEAD');
    const folder = join(f.site, 'snapshots', head);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'repomix.json'), JSON.stringify({ audit: { sourceSha: head }, files: { 'src/alpha.ts': 'export const value = 2;\n# Full file at head' } }));
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ sourceSha: head, files: [{ path: 'src/alpha.ts' }] }));
    const manifest = JSON.parse(readFileSync(join(f.site, 'manifest.json'), 'utf8'));
    manifest.branches[0].sha = head;
    manifest.snapshots[head] = { status: 'ready', outputs: [{ name: 'repomix.json', bytes: 1 }] };
    writeFileSync(join(f.site, 'manifest.json'), JSON.stringify(manifest));
    const result = buildDelegation(f);
    assert.equal(result.reviews[head].published, 1);
    const compact = readFileSync(join(f.site, 'reviews', head, 'gemini-diff.md'), 'utf8');
    assert.ok(compact.includes('+# Full file at head'));
    assert.match(compact, /Required review output/);
    assert.match(compact, /END_OF_PACKET/);
    const markers = compact.match(/^`{3,}$/gmu) ?? [];
    assert.equal(markers.length % 2, 0, 'All fenced blocks must close');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});


test('renamed files preserve provenance but never publish unverified historical deletion', () => {
  const f = fixture();
  try {
    git(f.root, 'checkout', '-q', 'feature');
    git(f.root, 'mv', 'src/alpha.ts', 'src/beta.ts');
    writeFileSync(join(f.root, 'src/beta.ts'), 'export const value = 1;\n');
    git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'rename without source modification');
    const head = git(f.root, 'rev-parse', 'HEAD');
    const folder = join(f.site, 'snapshots', head);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'repomix.json'), JSON.stringify({ audit: { sourceSha: head }, files: { 'src/beta.ts': 'export const value = 1;' } }));
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ sourceSha: head, files: [{ path: 'src/beta.ts' }] }));
    const m = JSON.parse(readFileSync(join(f.site, 'manifest.json'), 'utf8'));
    m.branches[0].sha = head;
    m.snapshots[head] = { status: 'ready', outputs: [{ name: 'repomix.json', bytes: 1 }] };
    writeFileSync(join(f.site, 'manifest.json'), JSON.stringify(m));
    let fake = readFileSync(f.bin, 'utf8');
    fake = fake.replaceAll("path:'src/alpha.ts'", "path:'src/beta.ts'").replace("status:'modified'", "status:'renamed'");
    writeFileSync(f.bin, fake);
    const result = buildDelegation(f);
    assert.equal(result.reviews[head].published, 1);
    const detail = JSON.parse(readFileSync(join(f.site, 'reviews', head, 'manifest.json'), 'utf8'));
    assert.equal(detail.files[0].previousPath, 'src/alpha.ts');
    const compact = readFileSync(join(f.site, 'reviews', head, 'gemini-diff.md'), 'utf8');
    assert.match(compact, /Previous path.*src\/alpha\.ts/u);
    assert.match(compact, /removed line withheld/u);
    assert.doesNotMatch(compact, /^-export const value = 1;/mu);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('real OCR CLI resolves preview and rules into a verified packet', { skip: !process.env.CODEXIA_AUDIT_OCR_BIN }, () => {
  const f = fixture();
  try {
    const result = buildDelegation({ ...f, bin: process.env.CODEXIA_AUDIT_OCR_BIN });
    assert.equal(result.reviews[f.feature].status, 'ready');
    assert.equal(result.reviews[f.feature].selected, 1);
    assert.equal(result.reviews[f.feature].published, 1);
    const output = readFileSync(join(f.site, 'reviews', f.feature, 'gemini-review.md'), 'utf8');
    assert.match(output, /OCR_VERSION/u);
    assert.match(output, /src\/alpha\.ts/u);
    assert.match(output, /END_OF_PACKET/u);
    assert.doesNotMatch(output, /do-not-leak/u);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
