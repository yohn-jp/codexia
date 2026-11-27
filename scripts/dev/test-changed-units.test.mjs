import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./test-changed-units.mjs', import.meta.url));

test('local unit selection includes both sides of renames, untracked files and committed branch changes', t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'codexia-local-selection-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const select = (...args) => execFileSync(process.execPath, [cli, '--list', ...args], { cwd, encoding: 'utf8' });
  git('init', '-q');
  for (const dir of ['modules/search/src', 'modules/story/src', 'modules/nlp/src']) {
    mkdirSync(path.join(cwd, dir), { recursive: true });
  }
  const original = 'modules/search/src/example.test.ts';
  writeFileSync(path.join(cwd, original), '');
  writeFileSync(path.join(cwd, '.gitignore'), 'scratch/\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
  git('branch', 'origin/main');
  assert.match(select(), /: none\s*$/u);
  // A committed deletion and addition must keep both owners, even when Git detects a rename.
  renameSync(path.join(cwd, original), path.join(cwd, 'modules/story/src/example.test.ts'));
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'rename');
  const nlp = path.join(cwd, 'modules/nlp/src/space and\nnewline.test.ts');
  writeFileSync(nlp, '');
  mkdirSync(path.join(cwd, 'scratch'));
  writeFileSync(path.join(cwd, 'scratch/unknown'), '');
  assert.match(select(), /3 changed files.*: unit-story, unit-nlp, unit-search\s*$/u);
  git('add', '--', nlp);
  assert.match(select('HEAD'), /1 changed files.*: unit-nlp\s*$/u);
  writeFileSync(path.join(cwd, 'unknown-build-input'), '');
  assert.match(select('HEAD'), /unit-contracts, .*unit-root\s*$/u);
  assert.notEqual(spawnSync(process.execPath, [cli, '--list', 'missing-base'], { cwd }).status, 0);
});

test('the selected contract suite receives the resolved local baseline and cannot pass with a missing prerequisite', t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'codexia-local-base-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  mkdirSync(path.join(cwd, 'scripts/ci/execution'), { recursive: true });
  writeFileSync(path.join(cwd, 'scripts/ci/execution/workspace.mjs'), `
    import { writeFileSync } from 'node:fs';
    const [command, target, report] = process.argv.slice(2);
    if (command === 'prepare') {
      writeFileSync(report, JSON.stringify(process.env.OMIT_RESULT ? [] :
        JSON.parse(process.env.CODEXIA_CI_GROUP_TASKS).map(task => ({ task }))));
    } else {
      console.log(target + ' base ' + process.env.CODEXIA_OASDIFF_BASE_REF);
    }
  `);
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  mkdirSync(path.join(cwd, 'packages/http-contract/test'), { recursive: true });
  writeFileSync(path.join(cwd, 'packages/http-contract/test/example.test.mjs'), '');
  const output = execFileSync(process.execPath, [cli, 'HEAD'], { cwd, encoding: 'utf8' });
  assert.ok(output.includes('http-contract base ' + base));
  const missing = spawnSync(process.execPath, [cli, 'HEAD'], {
    cwd, encoding: 'utf8', env: { ...process.env, OMIT_RESULT: '1' },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /unit-http-contract: missing preparation result/u);
});
