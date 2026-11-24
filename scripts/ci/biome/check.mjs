#!/usr/bin/env node
// An exact-source, read-only Biome quality task. Lint SARIF is not a formatter/security report.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const ciStatus = execute(['ci', ...scope]);
assert.equal(ciStatus, 0, 'Biome CI detected a format, lint or import issue');
assert.equal(lintStatus, 0, 'Biome lint failed even though the combined check passed');

// EXPERIMENT ONLY (#846). Remove this integration before the PR is ready.
// The canonical changed-file check and its uploaded SARIF above remain unchanged.
const trialConfigPath = path.resolve('.biome-all-audit-' + process.pid + '.json');
const candidateConfig = JSON.parse(readFileSync('biome.json', 'utf8'));
candidateConfig.linter.rules.preset = 'all';
const trialResults = { sha, biome: execFileSync('biome', ['--version'], { encoding: 'utf8' }).trim(), scope: scope.slice(3), rounds: [], rules: {} };
function trialScan(name, configPath, round) {
  const report = path.join(output, 'trial-' + name + '-' + round + '.sarif');
  const started = performance.now();
  const status = execute(['lint', '--config-path=' + configPath, ...scope.slice(3), '--max-diagnostics=none', '--reporter=sarif', '--reporter-file=' + report]);
  const elapsedMs = Math.round(performance.now() - started);
  assert.ok(status === 0 || status === 1, 'Unexpected trial exit: ' + status);
  assert.ok(existsSync(report), 'Missing trial report: ' + name);
  const result = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(result.version, '2.1.0');
  assert.ok(result.runs?.length, 'Missing trial tool runs: ' + name);
  const counts = {};
  const samples = {};
  for (const run of result.runs) {
    assert.equal(run.tool?.driver?.name, 'Biome');
    for (const finding of run.results ?? []) {
      const rule = finding.ruleId ?? '(missing ruleId)';
      const key = rule + ' ' + (finding.level ?? 'unspecified');
      counts[key] = (counts[key] ?? 0) + 1;
      const loc = finding.locations?.[0]?.physicalLocation;
      if (!samples[key]) samples[key] = { uri: loc?.artifactLocation?.uri, line: loc?.region?.startLine, message: finding.message?.text?.slice(0, 180) };
    }
  }
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  assert.ok(status === 0 || total > 0, 'Trial failed without diagnostics: ' + name);
  if (!trialResults.rules[name]) trialResults.rules[name] = { counts, samples };
  if (round !== 1) rmSync(report);
  const summary = { name, round, status, elapsedMs, total };
  trialResults.rounds.push(summary);
  console.log('BIOME_TRIAL_ROUND ' + JSON.stringify(summary));
}
writeFileSync(trialConfigPath, JSON.stringify(candidateConfig), { flag: 'wx' });
try {
  for (let round = 1; round <= 3; round++) {
    const modes = [['recommended', path.resolve('biome.json')], ['all', trialConfigPath]];
    if (round === 2) modes.reverse();
    for (const [name, configPath] of modes) trialScan(name, configPath, round);
  }
  writeFileSync(path.join(output, 'biome-trial-summary.json'), JSON.stringify(trialResults, null, 2) + '\n');
  for (const [name, { counts, samples }] of Object.entries(trialResults.rules)) {
    for (const [key, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log('BIOME_TRIAL_RULE ' + JSON.stringify({ name, key, count, sample: samples[key] }));
    }
  }
} finally {
  rmSync(trialConfigPath);
}
