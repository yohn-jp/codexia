import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const playwright = require.resolve('@playwright/test');
const cli = require.resolve('@playwright/test/cli');
const reporter = fileURLToPath(new URL('./browser-coverage-reporter.mjs', import.meta.url));

function runPlaywright(t, sources) {
  const directory = mkdtempSync(path.join(tmpdir(), 'codexia-browser-coverage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputFile = path.join(directory, 'coverage.json');
  writeFileSync(path.join(directory, 'playwright.config.cjs'), 'module.exports = ' + JSON.stringify({
    testDir: directory,
    workers: 1,
    reporter: [[reporter, { outputFile }]],
  }));
  writeFileSync(path.join(directory, 'browser.spec.cjs'), [
    `const { test } = require(${JSON.stringify(playwright)});`,
    ...sources,
  ].join('\n'));
  const result = spawnSync(process.execPath, [cli, 'test'], { cwd: directory, encoding: 'utf8' });
  assert.ifError(result.error);
  const report = JSON.parse(readFileSync(outputFile, 'utf8'));
  return { result, report };
}

test('a Playwright shard with only skipped cases exits unsuccessfully', t => {
  const { result, report } = runPlaywright(t, ['test.skip("outside this profile", () => {});']);
  assert.equal(report.executed, 0);
  assert.equal(report.skipped, 1);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(report.outcome, 'FAIL');
});

test('a passing shard can retain an inapplicable case without counting it as passed', t => {
  const { result, report } = runPlaywright(t, [
    'test("active case", () => {});',
    'test.skip("outside this profile", () => {});',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report.outcome, 'PASS');
  assert.equal(report.passed, 1);
  assert.equal(report.skipped, 1);
});
