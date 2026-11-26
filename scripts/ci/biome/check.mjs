#!/usr/bin/env node
// An exact-source, read-only Biome quality task. Lint SARIF is not a formatter/security report.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const plan = JSON.parse(readFileSync(process.env.CODEXIA_CI_PLAN_PATH ?? 'ci-plan.json', 'utf8'));
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(sha, plan.sha, 'Biome source does not match certified plan');
assert.ok(plan.tasks.includes('biome-ci'), 'Biome was not selected by the canonical plan');
const base = plan.base ?? execFileSync('git', ['rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
assert.match(base, /^[a-f0-9]{40}$/u, 'Biome requires an exact comparison base');
assert.notEqual(base, sha, 'Biome base cannot equal HEAD');
const output = process.env.CODEXIA_CI_REPORT_DIR;
assert.ok(path.isAbsolute(output ?? ''), 'Biome output directory must be absolute');
mkdirSync(output, { recursive: true });
const sarifPath = path.join(output, 'biome-lint.sarif');
// Begin with shipped application code, not pre-existing unformatted build/CI scripts.
const scope = ['--changed', `--since=${base}`, '--no-errors-on-unmatched', 'app', 'packages', 'modules', 'edge/frontend'];
function execute(args) {
  const result = spawnSync('biome', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Biome interrupted: ${result.signal}`);
  return result.status;
}
const lintStatus = execute(['lint', ...scope, '--reporter=sarif', `--reporter-file=${sarifPath}`]);
assert.ok(existsSync(sarifPath), 'Lint-only SARIF was not created');
const sarif = JSON.parse(readFileSync(sarifPath, 'utf8'));
assert.equal(sarif.version, '2.1.0', 'Unexpected SARIF version');
assert.ok(Array.isArray(sarif.runs) && sarif.runs.length > 0, 'Missing SARIF tool runs');
for (const run of sarif.runs) {
  assert.equal(run.tool?.driver?.name, 'Biome');
  for (const result of run.results ?? []) {
    assert.match(result.ruleId ?? '', /^lint\//u, 'Only lint diagnostics may enter Code Scanning');
  }
}
const ciStatus = execute(['ci', ...scope, '--max-diagnostics=none']);
assert.equal(ciStatus, 0, 'Biome CI detected a format, lint or import issue');
assert.equal(lintStatus, 0, 'Biome lint failed even though the combined check passed');

// A config-only PR otherwise has no changed application files to check.
// Reuse Biome itself to verify every explicitly enforced root rule on its
// entire existing source scope. The ordinary changed-file gate stays intact.
if (execFileSync('git', ['diff', '--name-only', base, sha, '--', 'biome.json'], { encoding: 'utf8' }).trim()) {
  const config = JSON.parse(readFileSync('biome.json', 'utf8'));
  const required = Object.entries(config.linter.rules).flatMap(([group, rules]) =>
    rules && typeof rules === 'object'
      ? Object.entries(rules)
        .filter(([, setting]) => setting === 'error' || setting?.level === 'error')
        .map(([rule]) => group + '/' + rule)
      : [],
  );
  if (required.length) {
    console.log('Full-scope configured error rules: ' + required.join(', '));
    const policyStatus = execute(['lint', ...scope.slice(3), ...required.map(rule => '--only=' + rule), '--error-on-warnings']);
    assert.equal(policyStatus, 0, 'Full-scope Biome rule enforcement failed');
  }
}
