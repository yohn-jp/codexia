import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLAYWRIGHT_IMAGE_DIGESTS } from './ci-browser-image-digests.mjs';
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

test('StrictDoc requirement and grammar Markdown are executable inputs only for the trace task', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'docs/requirements'), { recursive: true });
  await writeFile(path.join(root, 'docs/requirements/REQUIREMENT-REGISTER.md'), 'requirement source\n');
  await writeFile(path.join(root, 'docs/requirements/STRICTDOC-GRAMMAR.gra.md'), 'grammar source\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'add StrictDoc requirements inputs');
  const sha = await git(root, 'rev-parse', 'HEAD');
  const capture = captureTaskInputSource({ root, sha, runtime });
  const traceBefore = capture('requirements-trace');
  const unitBefore = capture('unit-core');
  await writeFile(path.join(root, 'docs/requirements/REQUIREMENT-REGISTER.md'), 'requirement source changed\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'change StrictDoc requirement source');
  const changedSha = await git(root, 'rev-parse', 'HEAD');
  const changed = captureTaskInputSource({ root, sha: changedSha, runtime });
  assert.notEqual(changed('requirements-trace').source, traceBefore.source);
  assert.equal(changed('unit-core').source, unitBefore.source);
});

test('task proof identities distinguish shared Git inputs from actual invocation inputs', async t => {
  const root = await fixture(t);
  const sha = await git(root, 'rev-parse', 'HEAD');
  const capture = captureTaskInputSource({ root, sha, runtime });
  const core = capture('unit-core');
  const app = capture('unit-app');
  const browser = capture('browser-full-ui-v1');

  // All tasks bind the same immutable source tree; task-specific execution must
  // still have a different recipe, environment or producer identity.
  for (const field of ['source', 'tests', 'dependencies', 'toolchain']) {
    assert.equal(core[field], app[field], field);
    assert.equal(browser[field], app[field], field);
    assert.match(core[field], /^[0-9a-f]{64}$/u, field);
  }
  assert.notEqual(core.recipe, app.recipe);
  assert.notEqual(browser.recipe, app.recipe);
  assert.notEqual(browser.environment, app.environment);
  assert.notEqual(browser.producers, app.producers);

  const canonical = taskInvocation('unit-app', runtime.execPath);
  assert.equal(Array.isArray(canonical), false);
  const misconfigured = capture('unit-app', {
    ...canonical,
    arguments: [...canonical.arguments, '--skip-tests'],
    environmentKeys: [...canonical.environmentKeys, 'ADDED_RUNTIME_INPUT'],
  });
  assert.notEqual(misconfigured.recipe, app.recipe, 'Changed execution must not reuse a certified recipe');
  for (const field of ['source', 'tests', 'dependencies', 'environment', 'toolchain', 'producers']) {
    assert.equal(misconfigured[field], app[field], field);
  }
  assert.throws(() => capture('unit-does-not-exist'), /exactly one verification group/u);
});

test('uncommitted worktree changes cannot influence proof for a pinned Git SHA', async t => {
  const root = await fixture(t);
  const sha = await git(root, 'rev-parse', 'HEAD');
  const original = captureTaskInputClosure({ root, sha, task: 'unit-core', runtime });
  await writeFile(path.join(root, 'packages/core/src/index.ts'), 'local uncommitted source mutation\\n');
  assert.deepEqual(captureTaskInputClosure({ root, sha, task: 'unit-core', runtime }), original);
  await git(root, 'add', 'packages/core/src/index.ts');
  await git(root, 'commit', '-qm', 'commit changed source');
  const committed = captureTaskInputClosure({ root, sha: await git(root, 'rev-parse', 'HEAD'), task: 'unit-core', runtime });
  assert.notEqual(committed.source, original.source, 'Commit content must change source proof');
  for (const field of ['tests', 'dependencies', 'environment', 'toolchain', 'recipe', 'producers']) {
    assert.equal(committed[field], original[field], field);
  }
});

test('browser input proofs bind the lane image for both browsers in the shared WebKit lane', async t => {
  const root = await fixture(t);
  const sha = await git(root, 'rev-parse', 'HEAD');
  const mutatedScripts = await mkdtemp(path.join(os.tmpdir(), 'codexia-browser-image-proof-'));
  t.after(() => rm(mutatedScripts, { recursive: true, force: true }));
  for (const file of ['ci-task-inputs.mjs', 'ci-contract.mjs', 'ci-browser-image-digests.mjs']) {
    await cp(new URL(file, import.meta.url), path.join(mutatedScripts, file));
  }
  const digestsFile = path.join(mutatedScripts, 'ci-browser-image-digests.mjs');
  const digests = await readFile(digestsFile, 'utf8');
  await writeFile(digestsFile, digests.replace(PLAYWRIGHT_IMAGE_DIGESTS.webkit, `sha256:${'f'.repeat(64)}`));
  const { captureTaskInputSource: captureWithChangedWebKitImage } = await import(
    pathToFileURL(path.join(mutatedScripts, 'ci-task-inputs.mjs')).href
  );
  const inputs = { root, sha, runtime };
  const original = captureTaskInputSource(inputs);
  const changed = captureWithChangedWebKitImage(inputs);
  for (const profile of ['core', 'full']) {
    for (const shard of ['ui-v1', 'oauth-web', 'webkit']) {
      const task = `browser-${profile}-${shard}`;
      assert.notEqual(changed(task).environment, original(task).environment, `${task} runs in the changed multi-browser image`);
    }
    const writing = `browser-${profile}-core`;
    assert.equal(changed(writing).environment, original(writing).environment, `${writing} uses the unchanged Chromium-only image`);
  }
});

test('Passkey browser shard binds the dedicated acceptance environment', () => {
  assert.deepEqual(taskInvocation('browser-core-passkey-bootstrap', '/opt/node/bin/node'), {
    executable: '/opt/node/bin/node',
    arguments: ['scripts/run-browser-shard.mjs', '--profile', 'core', '--suite', 'passkey-bootstrap', '--prebuilt'],
    environmentKeys: ['CODEXIA_CI_REPORT_DIR', 'CODEXIA_E2E_ADMIN_DATABASE_URL', 'CODEXIA_E2E_DATABASE_URL',
      'CODEXIA_E2E_OUTPUT_DIR', 'CODEXIA_E2E_PORT', 'CODEXIA_E2E_PROJECT_TITLE', 'CODEXIA_E2E_STATE_DIR',
      'CODEXIA_PASSKEY_ACCEPTANCE'],
  });
});

test('requirements trace invocation is canonical and captures runtime identity inputs', () => {
  assert.deepEqual(taskInvocation('requirements-trace', '/opt/node/bin/node'), {
    executable: '/opt/node/bin/node',
    arguments: ['scripts/strictdoc/verify.mjs'],
    environmentKeys: ['CODEXIA_CI_REPORT_DIR', 'CODEXIA_CI_SOURCE_SHA', 'CODEXIA_CI_TASK', 'STRICTDOC_BIN'],
  });
});
