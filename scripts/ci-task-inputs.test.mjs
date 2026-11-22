import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { captureTaskInputClosure, taskInvocation } from './ci-task-inputs.mjs';

async function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codexia-task-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'ci@example.test');
  await git(root, 'config', 'user.name', 'CI');
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, '.github/workflows'), { recursive: true });
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/ci-group.mjs',
    'scripts/ci-contract.mjs', 'scripts/ci-workspace.mjs', '.github/workflows/verify.yml',
    'packages/core/package.json', 'packages/core/src/index.ts', 'packages/core/index.test.mjs', 'docs/README.md']) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    const content = file === 'package.json' ? JSON.stringify({ packageManager: 'pnpm@12.21.0' })
      : file.endsWith('/package.json') ? JSON.stringify({ name: '@codexia/core', dependencies: {} }) : file + '\n';
    await writeFile(target, content);
  }
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'fixture');
  return root;
}

const runtime = { platform: 'linux', arch: 'x64', nodeVersion: 'v24.22.3', execPath: '/opt/node/bin/node',
  cwd: '/home/runner/work/codexia/codexia', imageOS: 'ubuntu24', imageVersion: '20261122.1' };

test('task input closure is stable for an unchanged tree and ignores only impact-excluded documentation', async t => {
  const root = await fixture(t);
  const input = { root, sha: await git(root, 'rev-parse', 'HEAD'), task: 'unit-core', runtime };
  const first = await captureTaskInputClosure(input);
  assert.deepEqual(await captureTaskInputClosure(input), first);
  await writeFile(path.join(root, 'docs/README.md'), 'documentation changed\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'docs only');
  const docsOnly = await captureTaskInputClosure({ ...input, sha: await git(root, 'rev-parse', 'HEAD') });
  assert.deepEqual(docsOnly, first, 'documentation excluded by the canonical impact rules does not change task inputs');
});

test('task input closure binds source, test, dependency, environment, toolchain, recipe, and producer inputs', async t => {
  const root = await fixture(t);
  const sha = await git(root, 'rev-parse', 'HEAD');
  const input = { root, sha, task: 'unit-core', runtime };
  const original = await captureTaskInputClosure(input);
  for (const [file, nextSha, dimension] of [
    ['packages/core/src/index.ts', 'source change\n', 'source'],
    ['packages/core/index.test.mjs', 'test change\n', 'tests'],
    ['packages/core/package.json', 'dependency change\n', 'dependencies'],
  ]) {
    await writeFile(path.join(root, file), nextSha);
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'change ' + dimension);
    const changed = await captureTaskInputClosure({ ...input, sha: await git(root, 'rev-parse', 'HEAD') });
    assert.notEqual(changed[dimension], original[dimension], `${dimension} change must invalidate the proof`);
    await git(root, 'reset', '--hard', sha);
  }
  const changedRuntime = await captureTaskInputClosure({ ...input,
    runtime: { ...runtime, imageVersion: '20261123.1' } });
  assert.notEqual(changedRuntime.environment, original.environment);
  assert.notEqual(changedRuntime.toolchain, original.toolchain);
  const changedRecipe = await captureTaskInputClosure({ ...input, task: 'unit-app' });
  assert.notEqual(changedRecipe.recipe, original.recipe);
  assert.notEqual(changedRecipe.producers, original.producers);
});

test('task invocations describe only canonical executable work with secret values redacted elsewhere', () => {
  assert.deepEqual(taskInvocation('unit-core', '/opt/node/bin/node'), {
    executable: '/opt/node/bin/node', arguments: ['scripts/ci-workspace.mjs', 'unit', 'core'], environmentKeys: [],
  });
  assert.deepEqual(taskInvocation('browser-full-ui-v1', '/opt/node/bin/node'), {
    executable: '/opt/node/bin/node',
    arguments: ['scripts/run-browser-shard.mjs', '--profile', 'full', '--suite', 'ui-v1', '--prebuilt'],
    environmentKeys: ['CODEXIA_CI_REPORT_DIR', 'CODEXIA_E2E_ADMIN_DATABASE_URL', 'CODEXIA_E2E_DATABASE_URL', 'CODEXIA_E2E_OUTPUT_DIR',
      'CODEXIA_E2E_PORT', 'CODEXIA_E2E_PROJECT_TITLE', 'CODEXIA_E2E_STATE_DIR'],
  });
});


test('task-scoped proofs reuse unrelated inputs but invalidate global and unknown paths', async t => {
  const root = await fixture(t);
  for (const file of ['modules/search/src/browser.ts', 'modules/search/src/browser.test.ts',
    'deploy/ansible/deploy-transaction.yml']) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file + '\n');
  }
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'add reviewed independent inputs');
  const base = await git(root, 'rev-parse', 'HEAD');
  const tasks = ['unit-core', 'unit-search', 'unit-root'];
  const capture = async sha => Object.fromEntries(await Promise.all(tasks.map(async task =>
    [task, await captureTaskInputClosure({ root, sha, task, runtime })])));
  const baseline = await capture(base);
  const changed = async (file, value) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value);
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'change ' + file);
    const result = await capture(await git(root, 'rev-parse', 'HEAD'));
    await git(root, 'reset', '--hard', base);
    return result;
  };

  const search = await changed('modules/search/src/browser.ts', 'search browser changed\n');
  assert.equal(search['unit-core'].source, baseline['unit-core'].source, 'unrelated core task can reuse source proof');
  assert.notEqual(search['unit-search'].source, baseline['unit-search'].source, 'search owner must invalidate');
  const searchTest = await changed('modules/search/src/browser.test.ts', 'search test changed\n');
  assert.equal(searchTest['unit-core'].tests, baseline['unit-core'].tests, 'unrelated tests must not invalidate');
  assert.notEqual(searchTest['unit-search'].tests, baseline['unit-search'].tests, 'own tests must invalidate');

  const deploy = await changed('deploy/ansible/deploy-transaction.yml', 'deployment changed\n');
  assert.equal(deploy['unit-core'].source, baseline['unit-core'].source, 'dedicated deployment proof is independent');
  assert.notEqual(deploy['unit-root'].source, baseline['unit-root'].source, 'root verification owns deployment inputs');

  const global = await changed('packages/core/src/index.ts', 'shared core changed\n');
  assert.notEqual(global['unit-core'].source, baseline['unit-core'].source);
  assert.notEqual(global['unit-search'].source, baseline['unit-search'].source, 'shared contracts invalidate other tasks');
  const unknown = await changed('scripts/unmapped-ci-tool.mjs', 'unknown executable\n');
  assert.notEqual(unknown['unit-core'].source, baseline['unit-core'].source, 'unknown paths fail closed');
  assert.notEqual(unknown['unit-search'].source, baseline['unit-search'].source, 'unknown paths invalidate all tasks');

  const lockfile = await changed('pnpm-lock.yaml', 'changed lockfile\n');
  assert.notEqual(lockfile['unit-core'].dependencies, baseline['unit-core'].dependencies);
  assert.notEqual(lockfile['unit-search'].dependencies, baseline['unit-search'].dependencies);
});
