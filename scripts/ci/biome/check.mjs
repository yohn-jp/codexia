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

// Temporary formatter retrieval for this draft experiment only. Never mutate the checked-out source.
{
  const { cpSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const scratch = mkdtempSync(path.join(tmpdir(), 'codexia-format-'));
  const paths = ['app/src/App.tsx', 'app/src/entries/mobile-native.tsx', 'app/src/entries/mobile.tsx', 'app/src/persistence/PersistenceEntry.tsx'];
  try {
    const config = JSON.parse(readFileSync('biome.json', 'utf8'));
    config.vcs.enabled = false;
    writeFileSync(path.join(scratch, 'biome.json'), JSON.stringify(config));
    for (const file of paths) {
      const target = path.join(scratch, file);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(file, target);
    }
    const formatted = spawnSync('biome', ['check', '--write', ...paths], { cwd: scratch, stdio: 'inherit' });
    console.log('CODEXIA_FORMAT_STATUS', formatted.status);
    if (formatted.status === 0) {
      for (const file of paths) {
        const content = readFileSync(path.join(scratch, file), 'utf8');
        content.split('\n').forEach((line, index) => console.log('CODEXIA_FORMAT_LINE ' + JSON.stringify({ file, index, line })));
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const ciStatus = execute(['ci', ...scope]);
assert.equal(ciStatus, 0, 'Biome CI detected a format, lint or import issue');
assert.equal(lintStatus, 0, 'Biome lint failed even though the combined check passed');
