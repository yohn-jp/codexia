import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The coverage closure reads every workspace manifest and every discovered
// test, not just the selected tasks. Keep that inventory intact. Whole scripts,
// deploy and profile trees retain the independent compatibility/evidence logic
// and every pnpm workspace importer. Git objects retain full ancestry.
const testFile = /\.(?:test|spec)\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx)$/u;
const workspaces = /^(?:packages|modules)\/[^/]+\/package\.json$/u;
const exactPaths = new Set([
  '.github/workflows/verify.yml',
  '.github/workflows/verify-profile.yml',
  'app/package.json',
  'packages/persistence-postgres/src/migration-set.ts',
  'packages/persistence-postgres/tests/db-contract/toolchain.json',
  'packages/api/src/auth-schema.ts',
]);
const wholeTrees = ['scripts/', 'deploy/', 'profiles/', 'packages/persistence-postgres/migrations/'];
const safeLiteral = file => !/[\s\[\]*?\\]/u.test(file);

export function evidenceCheckoutInputs(tracked) {
  const files = new Set(tracked);
  // A previously unknown workspace directory must not disappear from the
  // independent coverage discovery simply because it lacks a manifest.
  for (const file of files) {
    const workspace = /^(packages|modules)\/([^/]+)\//u.exec(file);
    if (workspace && !files.has(workspace[1] + '/' + workspace[2] + '/package.json')) return null;
  }
  const literals = [...files].filter(file => exactPaths.has(file) || workspaces.test(file) ||
    (/^(?:app|packages|modules)\//u.test(file) && testFile.test(file)));
  if (literals.some(file => !safeLiteral(file))) return null;
  const required = [...files].filter(file => !file.includes('/') ||
    wholeTrees.some(prefix => file.startsWith(prefix)) || literals.includes(file)).sort();
  return {
    patterns: ['/*', '!/*/', ...wholeTrees.map(prefix => '/' + prefix), ...literals.sort().map(file => '/' + file)],
    required,
  };
}

function git(cwd, args, input) {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
}

export function materializeEvidenceInputs(cwd, sha) {
  assert.match(sha ?? '', /^[a-f0-9]{40}$/u);
  assert.equal(git(cwd, ['rev-parse', 'HEAD']).trim(), sha, 'Evidence checkout must use the exact source');
  const tracked = git(cwd, ['ls-tree', '-r', '-z', '--name-only', sha]).split('\0').filter(Boolean);
  const inputs = evidenceCheckoutInputs(tracked);
  let sparse = inputs !== null;
  if (sparse) {
    git(cwd, ['sparse-checkout', 'set', '--no-cone', '--stdin'], inputs.patterns.join('\n') + '\n');
  } else {
    console.log('Unrecognized workspace/path input; materialize the complete checkout.');
    git(cwd, ['sparse-checkout', 'disable']);
  }
  const required = sparse ? inputs.required : tracked;
  const materialized = new Set(git(cwd, ['ls-files', '-t', '-z']).split('\0')
    .filter(record => record && !record.startsWith('S ')).map(record => record.slice(2)));
  assert.ok(required.every(file => materialized.has(file) &&
    lstatSync(path.join(cwd, file), { throwIfNoEntry: false }) !== undefined),
  'Evidence checkout is missing an independently required tracked input');
  assert.equal(git(cwd, ['rev-parse', 'HEAD']).trim(), sha);
  return { sparse, tracked: tracked.length, materialized: materialized.size, required: required.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const start = performance.now();
  const result = materializeEvidenceInputs(process.cwd(), process.env.CODEXIA_EXPECTED_SHA);
  const report = { ...result, elapsedMs: Math.round(performance.now() - start) };
  console.log(JSON.stringify(report));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    'Evidence input materialization: ' + report.materialized + '/' + report.tracked +
    ' files, ' + report.elapsedMs + ' ms (' + (report.sparse ? 'sparse' : 'full fallback') + ').\n');
}
