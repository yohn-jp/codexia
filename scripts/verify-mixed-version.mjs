import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFrontendIdentity } from './verify-frontend-compatibility.mjs';

const root = resolve(import.meta.dirname, '..');
const shaPattern = /^[a-f0-9]{40}$/u;

export function assertMixedVersionPair(frontend, { priorSha, currentSha, profile, apiEpoch }) {
  assertFrontendIdentity(frontend);
  assert.match(priorSha, shaPattern);
  assert.match(currentSha, shaPattern);
  assert.notEqual(priorSha, currentSha, 'Mixed-version verification requires distinct sources');
  assert.ok(['core', 'full'].includes(profile), 'Unknown profile');
  assert.ok(Number.isSafeInteger(apiEpoch) && apiEpoch > 0, 'Invalid candidate API epoch');
  assert.equal(frontend.sourceSha, priorSha, 'Prior frontend source mismatch');
  assert.equal(frontend.profile, profile, 'Prior frontend profile mismatch');
  assert.equal(frontend.apiEpoch, apiEpoch, 'Prior frontend API epoch mismatch');
}

export function assertDisposableDatabase(value) {
  assert.ok(value, 'Set CODEXIA_E2E_DATABASE_URL to a disposable loopback database');
  const url = new URL(value);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    /^\/codexia_e2e_compat_[a-z0-9_]+$/u.test(url.pathname),
  'Use a disposable loopback codexia_e2e_compat_* database');
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function run(cwd, args, env) {
  const result = spawnSync('pnpm', args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'pnpm ' + args.join(' ') + ' failed');
}

function cleanSource(cwd) {
  assert.equal(git(cwd, 'status', '--porcelain'), '', 'Use a clean source checkout: ' + cwd);
  return git(cwd, 'rev-parse', 'HEAD');
}

function main() {
  const [prior, profile, ...extra] = process.argv.slice(2);
  assert.ok(prior && isAbsolute(prior) && ['core', 'full'].includes(profile) && extra.length === 0,
    'Usage: node scripts/verify-mixed-version.mjs ABSOLUTE_PRIOR_WORKTREE core|full');
  const previous = realpathSync(prior);
  assert.notEqual(previous, realpathSync(root), 'Use a separate prior source worktree');
  assert.equal(realpathSync(git(previous, 'rev-parse', '--show-toplevel')), previous, 'Use the prior repository root');
  assertDisposableDatabase(process.env.CODEXIA_E2E_DATABASE_URL);
  for (const name of ['CODEXIA_E2E_BASE_URL', 'CODEXIA_BASE_URL', 'CODEXIA_E2E_EXTERNAL_DATABASE',
    'CODEXIA_E2E_TEST_FILE', 'CODEXIA_E2E_STATE_DIR', 'CODEXIA_E2E_COVERAGE_FILE',
    'CODEXIA_E2E_COMPAT_FRONTEND_DIR', 'CODEXIA_E2E_PROJECT_TITLE']) {
    assert.ok(!process.env[name], 'Unset ' + name + ' for isolated mixed-version verification');
  }
  const currentSha = cleanSource(root), priorSha = cleanSource(previous);
  assert.notEqual(currentSha, priorSha, 'Use distinct prior and candidate sources');
  git(root, 'merge-base', '--is-ancestor', priorSha, currentSha);
  const { apiEpoch } = JSON.parse(readFileSync(join(root, 'deploy/update-compatibility.json'), 'utf8'));
  const priorEpoch = JSON.parse(readFileSync(join(previous, 'deploy/frontend-compatibility.json'), 'utf8')).apiEpoch;
  assert.equal(priorEpoch, apiEpoch, 'Breaking API epoch changes require coordinated manual acceptance');
  const env = { ...process.env, CODEXIA_PROFILE: profile };
  run(previous, ['install', '--frozen-lockfile'], env);
  run(previous, ['build:frontend'], env);
  const directory = join(previous, 'app/dist');
  const frontend = JSON.parse(readFileSync(join(directory, 'desktop/update-identity.json'), 'utf8'));
  assertMixedVersionPair(frontend, { priorSha, currentSha, profile, apiEpoch });
  run(root, ['install', '--frozen-lockfile'], env);
  run(root, ['build'], env);
  assert.equal(cleanSource(previous), priorSha);
  assert.equal(cleanSource(root), currentSha);
  console.log(JSON.stringify({ frontend, backendSourceSha: currentSha, apiEpoch, profile }));
  // Run existing browser/real PostgreSQL scenarios, not an identity-only mock.
  // The test server loads current API and serves only the prior static assets.
  run(root, ['exec', 'playwright', 'test', '--config', 'tests/e2e/playwright.config.ts',
    '--project', 'chromium', '--grep',
    'revision history keeps immutable content|exact revision acknowledgement|new typing survives recovery against a newer PostgreSQL base revision'],
    { ...env, CODEXIA_E2E_COMPAT_FRONTEND_DIR: directory,
      CODEXIA_E2E_TEST_FILE: 'core.acceptance.spec.ts' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
