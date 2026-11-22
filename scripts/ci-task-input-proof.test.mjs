import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCompleteTaskInputProofSet, assertTaskProducerInventory, assertTrustedCertifiedSourceTaskInputProof, assertTrustedTaskInputProof, sanitizeProducerArguments, selectEquivalentTaskProofs } from './ci-task-input-proof.mjs';
import { createVerificationPlan, planDigest as createPlanDigest, validateVerificationPlan } from './ci-impact.mjs';
import { VERIFICATION_GROUPS } from './ci-contract.mjs';
import { taskGroup, taskWorkflowJob } from './ci-task-inputs.mjs';

const sourceSha = 'a'.repeat(40);
const planDigest = 'b'.repeat(64);
const dimensions = ['source', 'tests', 'dependencies', 'environment', 'toolchain', 'recipe', 'producers'];

function proof(task, overrides = {}) {
  return {
    format: 'codexia-ci-task-input-proof/v2',
    task,
    mode: 'static-coverage',
    status: 'passed',
    sourceSha,
    planDigest,
    workflowRunId: 42,
    workflowAttempt: 1,
    workflowJob: 'types',
    runtime: { platform: 'linux', arch: 'x64', nodeVersion: 'v24.22.3', execPath: '/opt/node/bin/node',
      cwd: '/home/runner/work/codexia/codexia', imageOS: 'ubuntu24', imageVersion: '20261115.1' },
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

test('task proof trust requires an exact successful main run, matching job attempt, and immutable artifact', () => {
  const identity = { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 2 };
  const inputProof = proof('coverage', { workflowAttempt: 2 });
  const run = { id: 42, workflow_id: 7, event: 'push', head_branch: 'main', head_sha: sourceSha,
    run_attempt: 2, status: 'completed', conclusion: 'success', repository: { id: 9 } };
  const job = { id: 84, run_id: 42, run_attempt: 2, head_sha: sourceSha, name: 'types-tests',
    status: 'completed', conclusion: 'success' };
  const artifact = { id: 91, name: 'ci-evidence-types-tests', digest: `sha256:${'c'.repeat(64)}`, expired: false,
    workflow_run: { id: 42, head_sha: sourceSha } };
  assert.doesNotThrow(() => assertTrustedTaskInputProof({ inputProof, identity, run, job, artifact,
    expected: { repositoryId: 9, workflowId: 7, jobName: 'types-tests', workflowJob: 'types', artifactName: 'ci-evidence-types-tests', artifactId: 91, artifactDigest: artifact.digest } }));
  assert.throws(() => assertTrustedTaskInputProof({ inputProof, identity, run: { ...run, conclusion: 'failure' }, job, artifact,
    expected: { repositoryId: 9, workflowId: 7, jobName: 'types-tests', workflowJob: 'types', artifactName: 'ci-evidence-types-tests', artifactId: 91, artifactDigest: artifact.digest } }), /main run did not succeed/);
  assert.throws(() => assertTrustedTaskInputProof({ inputProof, identity, run, job: { ...job, run_attempt: 1 }, artifact,
    expected: { repositoryId: 9, workflowId: 7, jobName: 'types-tests', workflowJob: 'types', artifactName: 'ci-evidence-types-tests', artifactId: 91, artifactDigest: artifact.digest } }), /job attempt mismatch/);
  assert.throws(() => assertTrustedTaskInputProof({ inputProof, identity, run, job, artifact: { ...artifact, expired: true },
    expected: { repositoryId: 9, workflowId: 7, jobName: 'types-tests', workflowJob: 'types', artifactName: 'ci-evidence-types-tests', artifactId: 91, artifactDigest: artifact.digest } }), /artifact is expired/);
  assert.throws(() => assertTrustedTaskInputProof({ inputProof: { ...inputProof, workflowJob: 'types-tests' }, identity, run, job, artifact,
    expected: { repositoryId: 9, workflowId: 7, jobName: 'types-tests', workflowJob: 'types', artifactName: 'ci-evidence-types-tests', artifactId: 91, artifactDigest: artifact.digest } }), /workflow job ID mismatch/);
});

test('task execution proof trust accepts a non-coverage task only from its exact main evidence artifact', () => {
  const identity = { sourceSha, planDigest, workflowRunId: 42, workflowAttempt: 2 };
  const inputProof = proof('unit-core', { workflowAttempt: 2, workflowJob: 'unit', mode: 'task-execution' });
  const run = { id: 42, workflow_id: 7, event: 'push', head_branch: 'main', head_sha: sourceSha,
    run_attempt: 2, status: 'completed', conclusion: 'success', repository: { id: 9 } };
  const job = { id: 84, run_id: 42, run_attempt: 2, head_sha: sourceSha, name: 'unit-core',
    status: 'completed', conclusion: 'success' };
  const artifact = { id: 91, name: 'ci-evidence-unit-core', digest: `sha256:${'c'.repeat(64)}`, expired: false,
    workflow_run: { id: 42, head_sha: sourceSha } };
  const expected = { repositoryId: 9, workflowId: 7, task: 'unit-core', jobName: 'unit-core', workflowJob: 'unit',
    artifactName: 'ci-evidence-unit-core', artifactId: 91, artifactDigest: artifact.digest };
  assert.doesNotThrow(() => assertTrustedTaskInputProof({ inputProof, identity, run, job, artifact, expected }));
  assert.throws(() => assertTrustedTaskInputProof({ inputProof: { ...inputProof, mode: 'static-coverage' },
    identity, run, job, artifact, expected }), /Unsupported reusable task input proof mode/);
  assert.throws(() => assertTrustedTaskInputProof({ inputProof, identity, run, job, artifact,
    expected: { ...expected, artifactDigest: `sha256:${'d'.repeat(64)}` } }), /artifact digest mismatch/);
});

test('task proof reuse metadata is limited to a complete coverage receipt and stays outside the plan digest', () => {
  const plan = createVerificationPlan({ files: ['docs/README.md'], event: 'pull_request', sha: sourceSha, base: 'd'.repeat(40) });
  const receipt = { task: 'coverage', sourceSha: plan.base, proofSourceSha: plan.base, planDigest: 'e'.repeat(64), workflowRunId: 42,
    workflowAttempt: 1, workflowId: 7, repositoryId: 9, jobId: 84, workflowJob: 'types',
    artifactId: 91, artifactName: 'ci-evidence-types-tests', artifactDigest: `sha256:${'c'.repeat(64)}`,
    inputClosure: proof('coverage').inputClosure, runtime: proof('coverage').runtime,
    certification: { sourceSha: plan.base, workflowRunId: 42, workflowAttempt: 1, workflowId: 7, repositoryId: 9,
      jobId: 85, step: 'Certify every required exact-source matrix element' } };
  const reusedPlan = { ...plan, taskInputReuse: { format: 'codexia-ci-task-input-reuse/v1', coverage: receipt } };
  assert.doesNotThrow(() => validateVerificationPlan(reusedPlan));
  assert.equal(createPlanDigest(reusedPlan), createPlanDigest(plan));
  assert.throws(() => validateVerificationPlan({ ...reusedPlan, taskInputReuse: {
    ...reusedPlan.taskInputReuse, coverage: { ...receipt, artifactDigest: 'invalid' },
  } }), /artifact digest/);
  assert.throws(() => validateVerificationPlan({ ...reusedPlan, taskInputReuse: {
    ...reusedPlan.taskInputReuse, unsupported: receipt,
  } }), /Unsupported task/);
});

test('affected PR reuse metadata must account for every omitted validation with exact task artifacts', () => {
  const plan = createVerificationPlan({ files: ['docs/README.md'], event: 'pull_request', sha: sourceSha, base: 'd'.repeat(40) });
  const digest = 'e'.repeat(64);
  const runtime = proof('coverage').runtime;
  const coverage = { task: 'coverage', sourceSha: plan.base, proofSourceSha: plan.base, planDigest: digest,
    workflowRunId: 42, workflowAttempt: 1, workflowId: 7, repositoryId: 9, jobId: 84, workflowJob: 'types',
    artifactId: 91, artifactName: 'ci-evidence-types-tests', artifactDigest: `sha256:${'c'.repeat(64)}`,
    inputClosure: proof('coverage').inputClosure, runtime,
    certification: { sourceSha: plan.base, workflowRunId: 42, workflowAttempt: 1, workflowId: 7, repositoryId: 9,
      jobId: 85, step: 'Certify every required exact-source matrix element' } };
  const omitted = Object.fromEntries(Object.values(VERIFICATION_GROUPS).flat().filter(task => task !== 'coverage').map(task => {
    const group = taskGroup(task);
    return [task, { ...coverage, task, workflowJob: taskWorkflowJob(task), artifactName: `ci-evidence-${group}`,
      artifactId: 100 + Object.keys(VERIFICATION_GROUPS).indexOf(group) }];
  }));
  const reuse = { format: 'codexia-ci-task-input-reuse/v2', coverage, omitted };
  assert.doesNotThrow(() => validateVerificationPlan({ ...plan, taskInputReuse: reuse }));
  const missing = structuredClone(reuse);
  delete missing.omitted['unit-core'];
  assert.throws(() => validateVerificationPlan({ ...plan, taskInputReuse: missing }), /proof inventory/);
  const foreignArtifact = structuredClone(reuse);
  foreignArtifact.omitted['unit-core'].artifactName = 'ci-evidence-unit-modules';
  assert.throws(() => validateVerificationPlan({ ...plan, taskInputReuse: foreignArtifact }), /producer identity/);
});

test('a PR task proof is trusted only through a successful exact-main certification', () => {
  const identity = { sourceSha: 'f'.repeat(40), planDigest, workflowRunId: 52, workflowAttempt: 1 };
  const inputProof = proof('coverage', { sourceSha: identity.sourceSha, workflowRunId: 52, workflowAttempt: 1 });
  const sourceRun = { id: 52, workflow_id: 7, path: '.github/workflows/verify.yml', repository: { id: 9 },
    head_repository: { id: 9 }, head_sha: identity.sourceSha, event: 'pull_request', run_attempt: 1,
    status: 'completed', conclusion: 'success' };
  const job = { id: 84, run_id: 52, run_attempt: 1, head_sha: identity.sourceSha, name: 'types-tests',
    status: 'completed', conclusion: 'success' };
  const artifact = { id: 91, name: 'ci-evidence-types-tests', digest: `sha256:${'c'.repeat(64)}`, expired: false,
    workflow_run: { id: 52, head_sha: identity.sourceSha } };
  const mainRun = { id: 53, workflow_id: 7, repository: { id: 9 }, head_sha: sourceSha, event: 'push',
    head_branch: 'main', run_attempt: 3, status: 'completed', conclusion: 'success' };
  const certificationJob = { id: 85, run_id: 53, run_attempt: 3, head_sha: sourceSha, name: 'certification',
    status: 'completed', conclusion: 'success' };
  const certificationStep = { name: 'Certify reused merged PR proof', conclusion: 'success' };
  const certification = { sourceSha, workflowRunId: 53, workflowAttempt: 3, workflowId: 7, repositoryId: 9,
    jobId: 85, step: certificationStep.name };
  const expected = { repositoryId: 9, workflowId: 7, jobName: 'types-tests', workflowJob: 'types', jobId: 84,
    artifactId: 91, artifactName: 'ci-evidence-types-tests', artifactDigest: artifact.digest };
  assert.doesNotThrow(() => assertTrustedCertifiedSourceTaskInputProof({ inputProof, identity, sourceRun, job,
    artifact, mainRun, certificationJob, certificationStep, certification, expected }));
  assert.throws(() => assertTrustedCertifiedSourceTaskInputProof({ inputProof, identity, sourceRun, job,
    artifact, mainRun: { ...mainRun, conclusion: 'failure' }, certificationJob, certificationStep, certification, expected }), /Main task certification run did not succeed/);
  assert.throws(() => assertTrustedCertifiedSourceTaskInputProof({ inputProof, identity, sourceRun, job,
    artifact, mainRun, certificationJob, certificationStep: { ...certificationStep, conclusion: 'failure' }, certification, expected }), /Main task proof was not certified/);
});

test('report-only producer inventory binds exact source, run, job, and selected task invocation inventory', () => {
  const plan = createVerificationPlan({ files: null, event: 'push', sha: sourceSha });
  const tasks = VERIFICATION_GROUPS['unit-core'].filter(task => plan.tasks.includes(task));
  const digest = createPlanDigest(plan);
  const workflowIdentity = {
    workflowRunId: 501, workflowAttempt: 2, workflowJob: 'unit',
    workflowRef: 'yohn-jp/codexia/.github/workflows/verify.yml@refs/heads/main', workflowSha: sourceSha,
  };
  const taskInputProof = proof('unit-contracts', { planDigest: digest, workflowRunId: 501, workflowAttempt: 2,
    workflowJob: 'unit', mode: 'task-execution', runtime: { platform: 'linux', arch: 'x64', nodeVersion: 'v24.22.3',
      execPath: '/opt/node/bin/node', cwd: '/home/runner/work/codexia/codexia', imageOS: 'ubuntu24', imageVersion: '20261115.1' } });
  const report = {
    group: 'unit-core', sha: sourceSha, planDigest: digest,
    ...workflowIdentity,
    results: tasks.map((task, i) => ({
      task, status: 'passed', seconds: i + 1,
       invocations: [{ executable: '/opt/node/bin/node', arguments: ['scripts/ci-workspace.mjs', 'unit', task.slice(5)], environmentKeys: [] }],
      ...(task === 'unit-contracts' ? { inputProof: taskInputProof } : {}),
    })),
  };
  const inventory = {
    format: 'codexia-ci-task-producer-inventory/v1',
    group: 'unit-core', sourceSha, planDigest: digest,
    ...workflowIdentity,
    runner: { os: 'Linux', arch: 'X64', imageOS: 'ubuntu24', imageVersion: '20261115.1', nodeVersion: 'v24.22.3' },
    selectedTasks: tasks,
    groupInvocations: [],
    taskInvocations: report.results.map(({ task, status, invocations, inputProof }) => ({ task, status, invocations, ...(inputProof ? { inputProof } : {}) })),
  };
  assert.doesNotThrow(() => assertTaskProducerInventory({ plan, report, inventory }));
  assert.throws(() => assertTaskProducerInventory({ plan, report, inventory: { ...inventory, workflowAttempt: 1 } }), /Attempt/);
  assert.throws(() => assertTaskProducerInventory({ plan, report, inventory: { ...inventory, selectedTasks: tasks.slice(0, 1) } }), /inventory/);
  const unbound = { ...report, results: report.results.map((item, i) => i ? item : { ...item, invocations: [] }) };
  assert.throws(() => assertTaskProducerInventory({ plan, report: unbound, inventory }), /invocation/);
});

test('report-only coverage input closure is accepted only for the full-plan static task and exact workflow identity', () => {
  const plan = createVerificationPlan({ files: null, event: 'push', sha: sourceSha });
  const tasks = VERIFICATION_GROUPS['types-tests'].filter(task => plan.tasks.includes(task));
  const digest = createPlanDigest(plan);
  const workflowIdentity = {
    workflowRunId: 701, workflowAttempt: 1, workflowJob: 'types',
    workflowRef: 'yohn-jp/codexia/.github/workflows/verify.yml@refs/heads/main', workflowSha: sourceSha,
  };
  const runtime = { platform: 'linux', arch: 'x64', nodeVersion: 'v24.22.3', execPath: '/opt/node/bin/node',
    cwd: '/home/runner/work/codexia/codexia', imageOS: 'ubuntu24', imageVersion: '20261115.1' };
  const inputProof = {
    format: 'codexia-ci-task-input-proof/v2', task: 'coverage', mode: 'static-coverage', status: 'passed', runtime,
    sourceSha, planDigest: digest, workflowRunId: 701, workflowAttempt: 1, workflowJob: 'types',
    inputClosure: Object.fromEntries(dimensions.map(name => [name, name.charCodeAt(0).toString(16).padStart(64, '0')])),
  };
  const report = {
    group: 'types-tests', sha: sourceSha, planDigest: digest, ...workflowIdentity,
    results: tasks.map(task => ({ task, status: 'passed', seconds: 1,
      invocations: [{ executable: 'node', arguments: ['scripts/ci-workspace.mjs', task === 'coverage' ? 'coverage' : 'test-types'], environmentKeys: [] }],
      ...(task === 'coverage' ? { inputProof } : {}),
    })),
  };
  const inventory = {
    format: 'codexia-ci-task-producer-inventory/v1', group: 'types-tests', sourceSha, planDigest: digest, ...workflowIdentity,
    runner: { os: 'Linux', arch: 'X64', imageOS: 'ubuntu24', imageVersion: '20261115.1', nodeVersion: 'v24.22.3' },
    selectedTasks: tasks, groupInvocations: [],
    taskInvocations: report.results.map(({ task, status, invocations, inputProof }) => ({ task, status, invocations, ...(inputProof ? { inputProof } : {}) })),
  };
  assert.doesNotThrow(() => assertTaskProducerInventory({ plan, report, inventory }));
  const missingRuntime = structuredClone(inventory);
  delete missingRuntime.taskInvocations.find(item => item.task === 'coverage').inputProof.runtime;
  assert.throws(() => assertTaskProducerInventory({ plan, report, inventory: missingRuntime }), /runtime/);
  const stale = structuredClone(inventory);
  stale.taskInvocations.find(item => item.task === 'coverage').inputProof.workflowJob = 'unit-core';
  assert.throws(() => assertTaskProducerInventory({ plan, report, inventory: stale }), /input proof mismatch/);
  const unsupported = structuredClone(report);
  unsupported.results.find(item => item.task === 'coverage').inputProof.mode = 'supplemental-tests';
  const unsupportedInventory = structuredClone(inventory);
  unsupportedInventory.taskInvocations.find(item => item.task === 'coverage').inputProof.mode = 'supplemental-tests';
  assert.throws(() => assertTaskProducerInventory({ plan, report: unsupported, inventory: unsupportedInventory }), /Unsupported task input proof mode/);
});

test('producer command inventory redacts secret-like argument values', () => {
  const safe = sanitizeProducerArguments(['--token', 'secret-token-value', '--password=secret', 'scripts/test.mjs']);
  assert.deepEqual(safe, ['--token', '[redacted]', '--password=[redacted]', 'scripts/test.mjs']);
  assert.doesNotMatch(safe.join(' '), /secret-token-value|password=secret/u);
});
