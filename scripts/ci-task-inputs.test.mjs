import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { captureTaskInputSource, taskInvocation } from './ci-task-inputs.mjs';

function captureTaskInputClosure({ root, sha, task, runtime }) {
  return captureTaskInputSource({ root, sha, runtime })(task);
}

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
  const first = captureTaskInputClosure(input);
  assert.deepEqual(captureTaskInputClosure(input), first);
  await writeFile(path.join(root, 'docs/README.md'), 'documentation changed\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'docs only');
  const docsOnly = captureTaskInputClosure({ ...input, sha: await git(root, 'rev-parse', 'HEAD') });
  assert.deepEqual(docsOnly, first, 'documentation excluded by the canonical impact rules does not change task inputs');
});

test('task input closure binds source, test, dependency, environment, toolchain, recipe, and producer inputs', async t => {
  const root = await fixture(t);
  const sha = await git(root, 'rev-parse', 'HEAD');
  const input = { root, sha, task: 'unit-core', runtime };
  const original = captureTaskInputClosure(input);
  for (const [file, nextSha, dimension] of [
    ['packages/core/src/index.ts', 'source change\n', 'source'],
    ['packages/core/index.test.mjs', 'test change\n', 'tests'],
    ['packages/core/package.json', 'dependency change\n', 'dependencies'],
  ]) {
    await writeFile(path.join(root, file), nextSha);
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'change ' + dimension);
    const changed = captureTaskInputClosure({ ...input, sha: await git(root, 'rev-parse', 'HEAD') });
    assert.notEqual(changed[dimension], original[dimension], `${dimension} change must invalidate the proof`);
    await git(root, 'reset', '--hard', sha);
  }
  const changedRuntime = captureTaskInputClosure({ ...input,
    runtime: { ...runtime, imageVersion: '20261123.1' } });
  assert.notEqual(changedRuntime.environment, original.environment);
  assert.notEqual(changedRuntime.toolchain, original.toolchain);
  const changedRecipe = captureTaskInputClosure({ ...input, task: 'unit-app' });
  assert.notEqual(changedRecipe.recipe, original.recipe);
  assert.notEqual(changedRecipe.producers, original.producers);
});

test('a historical task closure uses the package manager from its requested Git tree', async t => {
  const root = await fixture(t);
  const input = { root, sha: await git(root, 'rev-parse', 'HEAD'), task: 'unit-core', runtime };
  const historical = captureTaskInputClosure(input);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@12.22.0' }));
  await git(root, 'add', 'package.json');
  await git(root, 'commit', '-qm', 'new toolchain');
  assert.deepEqual(captureTaskInputClosure(input), historical);
  const current = captureTaskInputClosure({ ...input, sha: await git(root, 'rev-parse', 'HEAD') });
  assert.notEqual(current.toolchain, historical.toolchain);
});

test('a deployment document checked by root tests is included in the task source closure', async t => {
  const root = await fixture(t);
  const input = { root, sha: await git(root, 'rev-parse', 'HEAD'), task: 'unit-root', runtime };
  const original = captureTaskInputClosure(input);
  await mkdir(path.join(root, 'docs/deployment'), { recursive: true });
  await writeFile(path.join(root, 'docs/deployment/IOS-CLIENT.md'), 'asserted deployment contract\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'add executable documentation input');
  const changed = captureTaskInputClosure({ ...input, sha: await git(root, 'rev-parse', 'HEAD') });
  assert.notEqual(changed.source, original.source);
});

test('one source capture preserves independent task recipes and executed invocations', async t => {
  const root = await fixture(t);
  const input = { root, sha: await git(root, 'rev-parse', 'HEAD'), runtime };
  const closureFor = captureTaskInputSource(input);
  for (const task of ['unit-core', 'unit-app', 'browser-full-ui-v1']) {
    assert.deepEqual(closureFor(task), captureTaskInputClosure({ ...input, task }));
  }
  const configured = closureFor('unit-app');
  const execution = closureFor('unit-app', { ...taskInvocation('unit-app', runtime.execPath), environmentKeys: ['CUSTOM'] });
  assert.deepEqual({ ...execution, recipe: configured.recipe }, configured);
  assert.notEqual(execution.recipe, configured.recipe);
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
  assert.deepEqual(taskInvocation('browser-core-passkey-bootstrap', '/opt/node/bin/node'), {
    executable: '/opt/node/bin/node',
    arguments: ['scripts/run-browser-shard.mjs', '--profile', 'core', '--suite', 'passkey-bootstrap', '--prebuilt'],
    environmentKeys: ['CODEXIA_CI_REPORT_DIR', 'CODEXIA_E2E_ADMIN_DATABASE_URL', 'CODEXIA_E2E_DATABASE_URL',
      'CODEXIA_E2E_OUTPUT_DIR', 'CODEXIA_E2E_PORT', 'CODEXIA_E2E_PROJECT_TITLE', 'CODEXIA_E2E_STATE_DIR',
      'CODEXIA_PASSKEY_ACCEPTANCE'],
  });
});
