import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
  await cp(new URL('./', import.meta.url), path.join(root, 'scripts'), { recursive: true });
  for (const directory of ['app', 'packages/core', 'modules/story', '.github/workflows']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  for (const file of ['.github/workflows/verify.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'app/package.json', 'packages/core/package.json', 'modules/story/package.json']) {
    await cp(new URL(`../${file}`, import.meta.url), path.join(root, file));
  }
  await writeFile(path.join(root, 'packages/core/core.spec.ts'), 'export {};\n');
  const input = { root, runtime: { platform: 'linux', arch: 'x64', nodeVersion: 'v24.22.3', execPath: '/usr/bin/node', imageOS: 'ubuntu24', imageVersion: '20261115.1' },
    invocation: { executable: '/usr/bin/node', arguments: ['scripts/ci-workspace.mjs', 'coverage'], environmentKeys: [] }, workflowJob: 'types_tests' };
  const original = await captureCoverageInputClosure(input);
  await mkdir(path.join(root, 'packages/core/dist'));
  await writeFile(path.join(root, 'packages/core/dist/generated.test.js'), 'generated output\n');
  const generated = await captureCoverageInputClosure(input);
  assert.deepEqual(generated, original, 'generated tests do not alter source coverage');
  assert.deepEqual(selectEquivalentTaskProofs({ tasks: ['coverage'], baseline: [taskProof(original)], candidate: [taskProof(generated)],
    baselineIdentity: identity, candidateIdentity: identity }), ['coverage']);
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
  await writeFile(path.join(root, 'scripts/ci-browser-image-digests.mjs'), 'changed runtime image identity\n');
  const changedImageIdentity = await captureCoverageInputClosure(input);
  assert.notEqual(changedImageIdentity.source, changedClassification.source,
    'changing a runtime/proof image digest must invalidate the coverage input proof');
  assert.deepEqual(selectEquivalentTaskProofs({ tasks: ['coverage'], baseline: [taskProof(changedClassification)], candidate: [taskProof(changedImageIdentity)],
    baselineIdentity: identity, candidateIdentity: identity }), [],
    'coverage proof must refuse reuse after browser image identity changes');
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'changed dependency lock\n');
  const changedDependencies = await captureCoverageInputClosure(input);
  assert.notEqual(changedDependencies.dependencies, changedImageIdentity.dependencies, 'changed lockfile must invalidate coverage proof');
});
