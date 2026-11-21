import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildDelegation } from './delegate.mjs';

const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'delegate-test-'));
  const root = join(base, 'repo');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  const write = (path, value) => { const dest = join(root, path); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, value); };
  write('src/alpha.ts', 'export const value = 1;\n');
  write('.env', 'PRIVATE=initial-secret\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  const ancestor = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-qb', 'feature');
  write('src/alpha.ts', 'export const value = 2;\n');
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
  for (const [sha, value] of [[main, 'export const value = 3;\n'], [feature, 'export const value = 2;\n']]) {
    const folder = join(site, 'snapshots', sha);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'repomix.json'), JSON.stringify({ audit: { sourceSha: sha }, files: { 'src/alpha.ts': value } }));
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ sourceSha: sha, files: [{ path: 'src/alpha.ts' }] }));
  }
  writeFileSync(join(site, 'manifest.json'), JSON.stringify({ branches: [{ branch: 'feature', sha: feature }, { branch: 'main', sha: main }],
    snapshots: { [feature]: { status: 'ready' }, [main]: { status: 'ready' } } }));
  return { base, root, site, bin, ancestor, feature, main };
}

test('per-file OCR packets are complete, source-verified, and redact unverified deleted lines', () => {
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
    const text = readFileSync(join(dir, 'files', '0001.md'), 'utf8');
    assert.match(text, /export const value = 2;/);
    assert.match(text, /Check regressions/);
    assert.match(text, /removed line withheld/);
    assert.doesNotMatch(text, /export const value = 1;/);
    assert.doesNotMatch(text, /do-not-leak/);
    assert.ok(existsSync(join(dir, 'preview.json')));
    assert.ok(existsSync(join(dir, 'rules.json')));
    assert.match(readFileSync(join(f.site, 'index.html'), 'utf8'), new RegExp(f.feature));
    for (const output of summary.outputs) assert.ok(existsSync(join(dir, output.name)));
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
