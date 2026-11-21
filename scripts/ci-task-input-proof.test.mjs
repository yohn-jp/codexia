import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCompleteTaskInputProofSet, assertTaskProducerInventory, sanitizeProducerArguments, selectEquivalentTaskProofs } from './ci-task-input-proof.mjs';
import { createVerificationPlan, planDigest as createPlanDigest } from './ci-impact.mjs';
import { VERIFICATION_GROUPS } from './ci-contract.mjs';

const sourceSha = 'a'.repeat(40);
const planDigest = 'b'.repeat(64);
const dimensions = ['source', 'tests', 'dependencies', 'environment', 'toolchain', 'recipe', 'producers'];

function proof(task, overrides = {}) {
  return {
    task,
    status: 'passed',
    sourceSha,
    planDigest,
    workflowRunId: 42,
    workflowAttempt: 1,
    jobId: 84,
    inputClosure: Object.fromEntries(dimensions.map(name => [name, name.charCodeAt(0).toString(16).padStart(64, '0')])),
    ...overrides,
  };
}

test('complete task proofs require every declared input dimension and exact run identity', () => {
  const proofs = [proof('unit-contracts'), proof('build-core')];
  assert.doesNotThrow(() => assertCompleteTaskInputProofSet({
    tasks: ['unit-contracts', 'build-core'], proofs, sourceSha, planDigest,
    workflowRunId: 42, workflowAttempt: 1,
  }));
  const incomplete = proof('unit-contracts', { inputClosure: { source: '0'.repeat(64) } });
  assert.throws(() => assertCompleteTaskInputProofSet({
    tasks: ['unit-contracts'], proofs: [incomplete], sourceSha, planDigest,
    workflowRunId: 42, workflowAttempt: 1,
  }), /input closure/);
  assert.throws(() => assertCompleteTaskInputProofSet({
    tasks: ['unit-contracts'], proofs: [proof('unit-contracts', { workflowAttempt: 2 })], sourceSha, planDigest,
    workflowRunId: 42, workflowAttempt: 1,
  }), /attempt/);
});

test('task proof selection fails closed on missing, duplicate, stale, or changed evidence', () => {
  const baseline = [proof('unit-contracts'), proof('build-core')];
  const candidate = [proof('unit-contracts'), proof('build-core')];
  assert.deepEqual(selectEquivalentTaskProofs({
    tasks: ['unit-contracts', 'build-core'], baseline, candidate,
    baselineIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
    candidateIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
  }), ['unit-contracts', 'build-core']);
  assert.throws(() => selectEquivalentTaskProofs({
    tasks: ['unit-contracts', 'build-core'], baseline, candidate: candidate.slice(0, 1),
    baselineIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
    candidateIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
  }), /task proof inventory/);
  assert.throws(() => selectEquivalentTaskProofs({
    tasks: ['unit-contracts', 'build-core'], baseline: [...baseline, baseline[0]], candidate,
    baselineIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
    candidateIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
  }), /task proof inventory/);
  assert.throws(() => selectEquivalentTaskProofs({
    tasks: ['unit-contracts', 'build-core'], baseline, candidate: [proof('unit-contracts'), proof('build-core', { sourceSha: 'c'.repeat(40) })],
    baselineIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
    candidateIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
  }), /source mismatch/);
  const changed = [proof('unit-contracts'), proof('build-core', { inputClosure: {
    ...proof('build-core').inputClosure, environment: 'f'.repeat(64),
  } })];
  assert.deepEqual(selectEquivalentTaskProofs({
    tasks: ['unit-contracts', 'build-core'], baseline, candidate: changed,
    baselineIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
    candidateIdentity: { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 1 },
  }), ['unit-contracts']);
});

test('report-only producer inventory binds exact source, run, job, and selected task invocation inventory', () => {
  const plan = createVerificationPlan({ files: null, event: 'push', sha: sourceSha });
  const tasks = VERIFICATION_GROUPS['unit-core'].filter(task => plan.tasks.includes(task));
  const digest = createPlanDigest(plan);
  const workflowIdentity = {
    workflowRunId: 501, workflowAttempt: 2, workflowJob: 'unit',
    workflowRef: 'yohn-jp/codexia/.github/workflows/verify.yml@refs/heads/main', workflowSha: sourceSha,
  };
  const report = {
    group: 'unit-core', sha: sourceSha, planDigest: digest,
    ...workflowIdentity,
    results: tasks.map((task, i) => ({
      task, status: 'passed', seconds: i + 1,
      invocations: [{ executable: 'node', arguments: ['scripts/ci-workspace.mjs', 'unit', task.slice(5)], environmentKeys: [] }],
    })),
  };
  const inventory = {
    format: 'codexia-ci-task-producer-inventory/v1',
    group: 'unit-core', sourceSha, planDigest: digest,
    ...workflowIdentity,
    runner: { os: 'Linux', arch: 'X64', imageOS: 'ubuntu24', imageVersion: '20261115.1', nodeVersion: 'v24.22.3' },
    selectedTasks: tasks,
    groupInvocations: [],
    taskInvocations: report.results.map(({ task, status, invocations }) => ({ task, status, invocations })),
  };
  assert.doesNotThrow(() => assertTaskProducerInventory({ plan, report, inventory }));
  assert.throws(() => assertTaskProducerInventory({ plan, report, inventory: { ...inventory, workflowAttempt: 1 } }), /Attempt/);
  assert.throws(() => assertTaskProducerInventory({ plan, report, inventory: { ...inventory, selectedTasks: tasks.slice(0, 1) } }), /inventory/);
  const unbound = { ...report, results: report.results.map((item, i) => i ? item : { ...item, invocations: [] }) };
  assert.throws(() => assertTaskProducerInventory({ plan, report: unbound, inventory }), /invocation/);
});

test('producer command inventory redacts secret-like argument values', () => {
  const safe = sanitizeProducerArguments(['--token', 'secret-token-value', '--password=secret', 'scripts/test.mjs']);
  assert.deepEqual(safe, ['--token', '[redacted]', '--password=[redacted]', 'scripts/test.mjs']);
  assert.doesNotMatch(safe.join(' '), /secret-token-value|password=secret/u);
});
