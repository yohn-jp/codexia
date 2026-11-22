import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureCoverageInputClosure } from './ci-coverage-inputs.mjs';
import { selectEquivalentTaskProofs } from './ci-task-input-proof.mjs';

const identity = { sourceSha: 'a'.repeat(40), planDigest: 'b'.repeat(64), workflowRunId: 42, workflowAttempt: 1 };
function taskProof(inputClosure) {
  return { task: 'coverage', status: 'passed', ...identity, workflowJob: 'types', inputClosure };
}

test('coverage closure changes when a declared test input changes and is stable otherwise', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codexia-coverage-closure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['scripts', 'app', 'packages/core', 'modules/story', '.github/workflows']) await mkdir(path.join(root, directory), { recursive: true });
  for (const file of ['scripts/ci-workspace.mjs', 'scripts/ci-contract.mjs', 'scripts/ci-parallel.mjs', 'scripts/ci-impact.mjs',
    'scripts/ci-group.mjs', 'scripts/ci-profile-artifact.mjs', 'scripts/ci-native-producer.mjs', 'scripts/ci-browser-fixture.mjs',
    'scripts/ci-task-input-proof.mjs', 'scripts/ci-task-inputs.mjs', 'scripts/ci-coverage-inputs.mjs', '.github/workflows/verify.yml',
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'app/package.json', 'packages/core/package.json', 'modules/story/package.json',
    'scripts/coverage.test.mjs', 'app/app.test.ts', 'packages/core/core.spec.ts', 'modules/story/story.test.mjs']) {
    await writeFile(path.join(root, file), file + '\n');
  }
  const input = { root, runtime: { platform: 'linux', arch: 'x64', nodeVersion: 'v24.22.3', execPath: '/usr/bin/node', imageOS: 'ubuntu24', imageVersion: '20261115.1' },
    invocation: { executable: '/usr/bin/node', arguments: ['scripts/ci-workspace.mjs', 'coverage'], environmentKeys: [] }, workflowJob: 'types_tests' };
  const original = await captureCoverageInputClosure(input);
  assert.deepEqual(await captureCoverageInputClosure(input), original);
  await writeFile(path.join(root, 'packages/core/core.spec.ts'), 'changed test source\n');
  const changedTest = await captureCoverageInputClosure(input);
  assert.notEqual(changedTest.tests, original.tests, 'changed declared test input must invalidate coverage proof');
  assert.equal(changedTest.recipe, original.recipe, 'test contents do not change the declared task recipe');
  assert.deepEqual(selectEquivalentTaskProofs({ tasks: ['coverage'], baseline: [taskProof(original)], candidate: [taskProof(changedTest)],
    baselineIdentity: identity, candidateIdentity: identity }), [], 'changed declared input must refuse proof reuse');
  await writeFile(path.join(root, 'scripts/ci-workspace.mjs'), 'changed coverage implementation\n');
  const changedSource = await captureCoverageInputClosure(input);
  assert.notEqual(changedSource.source, changedTest.source, 'changed coverage implementation must invalidate coverage proof');
  await writeFile(path.join(root, 'scripts/ci-task-inputs.mjs'), 'changed proof input classification\n');
  const changedClassification = await captureCoverageInputClosure(input);
  assert.notEqual(changedClassification.source, changedSource.source, 'changed proof input classification must invalidate coverage proof');
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'changed dependency lock\n');
  const changedDependencies = await captureCoverageInputClosure(input);
  assert.notEqual(changedDependencies.dependencies, changedClassification.dependencies, 'changed lockfile must invalidate coverage proof');
});
