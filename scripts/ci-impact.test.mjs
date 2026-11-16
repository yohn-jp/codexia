import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { REQUIRED_VERIFICATION_JOBS } from './ci-contract.mjs';
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');

test('full verification uses twenty jobs including planning and certification', () => {
  assert.equal(REQUIRED_VERIFICATION_JOBS.length, 20);
});

const plan = async (files, event = 'pull_request') => {
  const { createVerificationPlan } = await import('./ci-impact.mjs');
  return createVerificationPlan({ files, event, sha: 'a'.repeat(40), base: 'b'.repeat(40) });
};

test('Full-model OCI impact matches the standalone push paths and the Verify caller', async () => {
  const { FULL_MODEL_OCI_PATHS, matchesFullModelOciPath } = await import('./ci-impact.mjs');
  const standalone = parse(readFileSync(new URL('../.github/workflows/full-model-oci-acceptance.yml', import.meta.url), 'utf8'));
  const pushPaths = standalone.on.push.paths;
  assert.equal(Object.hasOwn(standalone.on, 'workflow_call'), true);
  assert.equal(standalone.on.workflow_dispatch, null);
  assert.deepEqual(standalone.on.push.branches, ['main']);
  assert.equal(Object.hasOwn(standalone.on, 'pull_request'), false);
  assert.deepEqual(pushPaths, FULL_MODEL_OCI_PATHS.filter(file => file !== '.github/workflows/verify.yml'));

  for (const pattern of FULL_MODEL_OCI_PATHS) {
    const changedPath = pattern.endsWith('/**') ? `${pattern.slice(0, -3)}/ci-impact-sentinel.mjs` : pattern;
    assert.equal(matchesFullModelOciPath(changedPath), true, `Expected impact for ${changedPath}`);
    assert.equal((await plan([changedPath])).full_model_oci, true, `Expected plan impact for ${changedPath}`);
  }
  for (const changedPath of [
    '.github/workflows/other.yml',
    'profiles-old/full/config.json',
    'tests/integration/unrelated.acceptance.mjs',
    'docs/deployment/IAC.md',
  ]) {
    assert.equal(matchesFullModelOciPath(changedPath), false, `Unexpected impact for ${changedPath}`);
    assert.equal((await plan([changedPath])).full_model_oci, false, `Unexpected plan impact for ${changedPath}`);
  }
  assert.equal((await plan(null)).full_model_oci, false);
  assert.equal((await plan(['profiles/full/config.json'], 'push')).full_model_oci, false);

  const verify = parse(readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8'));
  assert.equal(verify.jobs.full_model_oci.uses, './.github/workflows/full-model-oci-acceptance.yml');
  assert.equal(verify.jobs.full_model_oci.if, "needs.plan.result == 'success' && needs.plan.outputs.full_model_oci == 'true'");
});

test('Search browser changes do not run unrelated units or native image builds', async () => {
  const selected = await plan(['modules/search/src/browser.ts', 'modules/search/src/browser.test.ts']);
  assert.ok(selected.tasks.includes('unit-search'));
  assert.ok(selected.tasks.includes('build-full'));
  assert.ok(selected.tasks.includes('browser-full-modular-workspace'));
  assert.ok(selected.tasks.includes('browser-full-ui-v1'));
  assert.ok(!selected.tasks.includes('unit-core'));
  assert.ok(!selected.tasks.includes('unit-speaker'));
  assert.ok(!selected.tasks.some(task => task.startsWith('hosted-native-') || task.startsWith('oci-')));
});

test('shared app changes retain both profile browser coverage without backend units', async () => {
  const selected = await plan(['app/src/application/SharedApplication.tsx']);
  assert.ok(selected.tasks.includes('unit-app'));
  for (const profile of ['core', 'full']) {
    assert.ok(selected.tasks.includes(`build-${profile}`));
    assert.ok(selected.tasks.includes(`browser-${profile}-webkit`));
    assert.ok(selected.tasks.includes(`browser-${profile}-core`));
  }
  assert.ok(!selected.tasks.includes('unit-api'));
  assert.ok(!selected.tasks.some(task => task.startsWith('hosted-native-')));
});

test('main, manual, shared contracts, lockfiles, manifests and unknown files fail closed to full verification', async () => {
  const { VERIFICATION_TASKS } = await import('./ci-contract.mjs');
  for (const [files, event] of [
    [['modules/search/src/browser.ts'], 'push'], [[], 'workflow_dispatch'],
    [['packages/contracts/src/index.ts'], 'pull_request'],
    [['packages/persistence-contracts/src/index.ts'], 'pull_request'],
    [['packages/persistence-postgres/src/postgres-store.ts'], 'pull_request'],
    [['pnpm-lock.yaml'], 'pull_request'],
    [['modules/search/package.json'], 'pull_request'], [['new-root-file'], 'pull_request'],
    [null, 'pull_request'],
  ]) {
    assert.deepEqual((await plan(files, event)).tasks, VERIFICATION_TASKS);
  }
});

test('test-only changes select their owner while non-executable documentation selects inventory only', async () => {
  const selected = await plan(['modules/search/src/browser.test.ts']);
  assert.ok(selected.tasks.includes('unit-search'));
  assert.ok(selected.tasks.includes('test-types-modules'));
  assert.ok(!selected.tasks.includes('build-full'));
  assert.deepEqual((await plan(['docs/authoring.md'])).tasks, ['coverage']);
});

test('every selected task has one execution group and every exclusion has a reason', async () => {
  const { VERIFICATION_GROUPS, VERIFICATION_TASKS } = await import('./ci-contract.mjs');
  const mapped = Object.values(VERIFICATION_GROUPS).flat();
  assert.equal(new Set(mapped).size, mapped.length);
  assert.deepEqual(mapped.toSorted(), VERIFICATION_TASKS.toSorted());
  const selected = await plan(['app/src/editor/SceneEditor.tsx']);
  assert.deepEqual(selected.groups, Object.keys(VERIFICATION_GROUPS).filter(group => VERIFICATION_GROUPS[group].some(task => selected.tasks.includes(task))));
  assert.equal(selected.excluded.length + selected.tasks.length, VERIFICATION_TASKS.length);
  assert.ok(selected.excluded.every(item => item.reason && !selected.tasks.includes(item.task)));
});
