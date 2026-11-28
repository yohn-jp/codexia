import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
import { selectScanAdmission, exactPullRequestFiles } from './security-admission.mjs';

test('CodeQL and Trivy accept only owned analyzable inputs on exact PR deltas', () => {
  for (const [files, codeql, trivy] of [
    [['ios/CodexiaApp/Sources/CodexiaApp.swift', 'ios/CodexiaEditor/Package.swift'], false, true],
    [['.github/workflows/ios-api.yml', 'ios/CodexiaTransport/Sources/CodexiaAPI/Client.swift'], false, true],
    [['docs/authoring.sdoc'], false, false],
    [['packages/core/src/operation-records.test.ts'], true, false],
    [['modules/mcp/src/context-manifest.test.ts'], true, false],
    [['app/src/workspace/persistence.test.ts'], true, false],
    [['app/src/editorial.css'], false, false],
    [['app/src/editor.tsx'], true, false],
    [['packages/http-contract/openapi/codexia.openapi.yaml'], false, true],
    [['packages/http-contract/src/routes-core.tsp'], true, true],
    [['packages/http-contract/tspconfig.yaml'], true, true],
    [['scripts/pages-api/package-lock.json'], true, true],
    [['pnpm-lock.yaml'], true, true],
    [['packages/api/package.json'], true, true],
    [['cmd/codexiactl/go.mod'], true, true],
    [['Dockerfile.backend'], false, true],
    [['.github/workflows/codeql.yml'], true, true],
    [['scripts/ci/impact/security-admission.mjs'], true, false],
    [['unknown-domain/new-policy'], true, true],
  ]) {
    const choice = selectScanAdmission(files);
    assert.equal(choice.codeql, codeql, files.join(', ') + ' CodeQL');
    assert.equal(choice.trivy, trivy, files.join(', ') + ' Trivy');
  }
});

test('bad identities, invalid diffs and non-PR events cannot waive scanners', () => {
  for (const files of [null, ['../src/example.ts'], ['/etc/passwd'], [''], ['test\\escape']]) {
    assert.deepEqual(
      Object.fromEntries(Object.entries(selectScanAdmission(files)).filter(([key]) => key !== 'reason')),
      { codeql: true, trivy: true }
    );
  }
  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    assert.deepEqual(
      Object.fromEntries(Object.entries(selectScanAdmission(['docs/only.md'], event)).filter(([key]) => key !== 'reason')),
      { codeql: true, trivy: true }
    );
  }
});

test('PR diff is accepted only from the exact two-parent merged tree', () => {
  const base = 'a'.repeat(40), head = 'b'.repeat(40), merged = 'c'.repeat(40);
  const calls = [];
  const runGit = (...args) => {
    calls.push(args);
    if (args[0] === 'rev-list') return merged + ' ' + base + ' ' + head + '\n';
    if (args[0] === 'diff') return 'ios/CodexiaApp/Sources/CodexiaApp.swift\0';
    throw new Error('Unexpected Git command');
  };
  assert.deepEqual(exactPullRequestFiles({ base, head, checkoutSha: merged, runGit }),
    ['ios/CodexiaApp/Sources/CodexiaApp.swift']);
  assert.deepEqual(calls[1], ['diff', '--name-only', '--no-renames', '-z', base, merged]);
  assert.throws(() => exactPullRequestFiles({
    base, head, checkoutSha: merged, runGit: () => merged + ' ' + head + ' ' + base
  }), /exact two-parent PR merge/u);
  assert.throws(() => exactPullRequestFiles({ base: 'missing', head, checkoutSha: merged, runGit }),
    /exact PR identity/u);
});

test('CodeQL and Trivy maintain stable check jobs, prove scope before scanning and keep Gitleaks', () => {
  const root = new URL('../../../', import.meta.url);
  const codeql = parse(readFileSync(new URL('.github/workflows/codeql.yml', root), 'utf8'));
  const security = parse(readFileSync(new URL('.github/workflows/security-scans.yml', root), 'utf8'));
  for (const [job, stepName] of [
    [codeql.jobs.analyze, 'Select exact-source security scope'],
    [security.jobs.trivy, 'Select exact-source security scope'],
  ]) {
    const index = job.steps.findIndex(s => s.name === stepName);
    assert.ok(index > 0, 'Source checkout must precede scope verification');
    assert.match(job.steps[index].run, /security-admission\.mjs/u);
    assert.match(String(job.steps[index - 1].with?.['fetch-depth']), /pull_request/u);
  }
  assert.ok(codeql.jobs.analyze.steps.filter(s => String(s.if ?? '').includes('steps.scope.outputs.codeql')).length >= 2);
  assert.ok(security.jobs.trivy.steps.filter(s => String(s.if ?? '').includes('steps.scope.outputs.trivy')).length >= 2);
  assert.ok(security.jobs.gitleaks.steps.some(s => s.name === 'Scan Git history'));
  assert.ok(codeql.on.push.branches.includes('main'));
  assert.ok(security.on.push.branches.includes('main'));
});
