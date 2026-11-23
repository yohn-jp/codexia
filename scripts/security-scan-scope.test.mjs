import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('../.github/workflows/security-scans.yml', import.meta.url), 'utf8'));
const gitleaks = workflow.jobs.gitleaks;
const scope = gitleaks.steps.find(step => step.id === 'history');
const scan = gitleaks.steps.find(step => step.name === 'Scan Git history');

test('Gitleaks scope and SARIF upload are bound to the same verified PR interval', () => {
  assert.ok(scope, 'Git scan scope is required');
  assert.equal(gitleaks.steps[0].with['fetch-depth'], 0);
  assert.equal(gitleaks.steps[0].with['persist-credentials'], false);
  assert.ok(gitleaks.steps.indexOf(scope) < gitleaks.steps.indexOf(scan), 'Range validation precedes scan');
  assert.match(scan.run, /--log-opts "\$\{\{ steps\.history\.outputs\.log_opts \}\}"/u);
  assert.match(scan.run, /--network none/u);
  assert.match(scan.run, /--report-format sarif/u);
  assert.ok(gitleaks.steps.some(step => step.with?.category === 'gitleaks-history'), 'Keep Code scanning category');
  assert.deepEqual(Object.keys(workflow.on).toSorted(), ['pull_request', 'push'].toSorted());
});

test('Gitleaks PR scope includes renamed and prior committed secret additions; main scans all history', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codexia-gitleaks-scope-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'Codexia CI');
    git('config', 'user.email', 'ci@example.invalid');
    writeFileSync(path.join(root, 'README.md'), 'base\\n');
    git('add', '.');
    git('commit', '-qm', 'base source');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'feature');
    writeFileSync(path.join(root, 'fixture.txt'), 'synthetic-scope-marker\\n');
    git('add', '.');
    git('commit', '-qm', 'add fixture');
    git('mv', 'fixture.txt', 'renamed-fixture.txt');
    git('commit', '-qm', 'rename fixture');
    const head = git('rev-parse', 'HEAD');
    const invoke = (event, prBase, prHead) => {
      const output = path.join(root, 'scope-output');
      writeFileSync(output, '');
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', scope.run], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_EVENT_NAME: event, PR_BASE_SHA: prBase,
          PR_HEAD_SHA: prHead, GITHUB_OUTPUT: output },
      });
      return { result, line: readFileSync(output, 'utf8').trim() };
    };
    const pr = invoke('pull_request', base, head);
    assert.equal(pr.result.status, 0, pr.result.stderr);
    assert.equal(pr.line, `log_opts=${base}..${head}`);
    assert.match(git('log', '-p', `${base}..${head}`), /synthetic-scope-marker/u);
    const main = invoke('push', '', '');
    assert.equal(main.result.status, 0, main.result.stderr);
    assert.equal(main.line, 'log_opts=HEAD');
    assert.notEqual(invoke('pull_request', base, 'badsha').result.status, 0);
    assert.notEqual(invoke('pull_request', 'f'.repeat(40), head).result.status, 0);
    assert.notEqual(invoke('pull_request', base, base).result.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
