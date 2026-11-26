import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readApprovedOpenapi } from '../scripts/approved-openapi.mjs';

test('reads a historical blob and rebuilds a source-only base with its own locked generator', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'codexia-base-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = () => {
    git(['add', '-A']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    return git(['rev-parse', 'HEAD']);
  };
  git(['init', '-q']);
  const pkg = path.join(root, 'packages/http-contract');
  const artifact = path.join(pkg, 'openapi/codexia.openapi.yaml');
  mkdirSync(path.dirname(artifact), { recursive: true });
  writeFileSync(artifact, 'approved historical bytes');
  assert.equal(readApprovedOpenapi(root, commit()).toString(), 'approved historical bytes');

  rmSync(artifact);
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  assert.throws(() => readApprovedOpenapi(root, commit()), /main\.tsp/u);
  const { packageManager } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, packageManager }));
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  mkdirSync(path.join(pkg, 'src'));
  writeFileSync(path.join(pkg, 'src/main.tsp'), 'approved source bytes');
  writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({
      name: '@codexia/http-contract',
      private: true,
      scripts: { generate: 'node generate.mjs' },
    }),
  );
  writeFileSync(
    path.join(pkg, 'generate.mjs'),
    [
      "import { copyFileSync, mkdirSync } from 'node:fs';",
      "mkdirSync('openapi', { recursive: true });",
      "copyFileSync('src/main.tsp', 'openapi/codexia.openapi.yaml');",
    ].join('\n'),
  );
  execFileSync('corepack', ['pnpm', 'install', '--lockfile-only'], { cwd: root });
  const base = commit();
  writeFileSync(path.join(pkg, 'generate.mjs'), "throw Error('candidate generator must never run for the base');");
  writeFileSync(artifact, 'untrusted working copy');
  assert.equal(readApprovedOpenapi(root, base).toString(), 'approved source bytes');
  assert.equal(readFileSync(artifact, 'utf8'), 'untrusted working copy');
  assert.equal(git(['worktree', 'list', '--porcelain']).split('worktree ').length - 1, 1);
});
