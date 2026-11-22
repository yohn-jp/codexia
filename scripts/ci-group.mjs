#!/usr/bin/env node
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { VERIFICATION_GROUPS, requiredBuildProfile } from './ci-contract.mjs';
import { planDigest, validateVerificationPlan } from './ci-impact.mjs';
import { assertProfileReceipt } from './ci-profile-artifact.mjs';
import { assertNativeReceipt } from './ci-native-producer.mjs';
import { runBounded } from './ci-parallel.mjs';
import { withBrowserFixture } from './ci-browser-fixture.mjs';
import { assertTaskProducerInventory, sanitizeProducerArguments, selectEquivalentTaskProofs } from './ci-task-input-proof.mjs';
import { captureCoverageInputClosure, coverageInputProof, coverageInvocation, coverageRuntime } from './ci-coverage-inputs.mjs';
import { captureTaskInputSource, taskInputProof } from './ci-task-inputs.mjs';

const group = process.argv[2];
const plan = validateVerificationPlan(JSON.parse(readFileSync(process.env.CODEXIA_CI_PLAN_PATH ?? 'ci-plan.json', 'utf8')));
// Container checkout mounts can have the host runner's UID. Trust only this
// explicit checkout for the read; do not change global Git trust or other repos.
const sha = execFileSync('git', ['-c', `safe.directory=${process.cwd()}`, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (sha !== plan.sha || !plan.groups.includes(group)) throw new Error('Group is not selected for this exact source');
const tasks = VERIFICATION_GROUPS[group].filter(task => plan.tasks.includes(task));
const completed = new Map();
const limit = Number(process.env.CODEXIA_CI_CONCURRENCY ?? '2');
if (![1, 2].includes(limit)) throw new Error('CI concurrency must be 1 or 2');
const groupPreparation = new Map();
const taskInvocationContext = new AsyncLocalStorage();
const groupInvocations = [];
let groupPreparationError;
let taskProofClosureFor;
const reportDirectory = process.env.CODEXIA_CI_REPORT_DIR ?? path.resolve('ci-results', group);
mkdirSync(reportDirectory, { recursive: true });
const run = (command, args, extraEnv = {}) => new Promise((resolve, reject) => {
  const active = taskInvocationContext.getStore();
  const record = { executable: String(command), arguments: sanitizeProducerArguments(args.map(String)), environmentKeys: Object.keys(extraEnv).sort() };
  (active?.invocations ?? groupInvocations).push(record);
  console.log(`$ ${command} ${args.join(' ')}`);
  const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  child.once('error', reject);
  child.once('close', (status, signal) => {
    if (signal || status !== 0) reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? status})`));
    else resolve();
  });
});
const node = (...args) => run(process.execPath, args);
let preparationError;
let profileArtifact;
let nativeArtifact;
try {
  const requiredProfile = requiredBuildProfile(group);
  if (requiredProfile) {
    // A failed producer or restore is a blocked validation, not a reason to rebuild.
    if (process.env.CODEXIA_CI_PROFILE_RESTORE !== 'success') throw new Error('Profile build/restore prerequisite failed');
    profileArtifact = JSON.parse(readFileSync(process.env.CODEXIA_CI_PROFILE_RECEIPT, 'utf8'));
    assertProfileReceipt(profileArtifact, plan, requiredProfile, process.env.GITHUB_RUN_ID);
  }
  if (group.startsWith('browser-')) await node('scripts/verify-browser-runtime.mjs');
  if (group.startsWith('hosted-native-') && group !== 'hosted-native-catalog') {
    if (process.env.CODEXIA_CI_NATIVE_RESTORE !== 'success') throw new Error('Hosted Native producer prerequisite failed');
    nativeArtifact = JSON.parse(readFileSync(process.env.CODEXIA_CI_NATIVE_RECEIPT,'utf8'));
    assertNativeReceipt(nativeArtifact,plan,process.env.GITHUB_RUN_ID);
  }
} catch (error) { preparationError = String(error); }
const preparationStarted = Date.now();
if ((group.startsWith('types-') || group.startsWith('unit-')) && !preparationError) {
  try {
    const filename = path.resolve(reportDirectory, 'workspace-preparation.json');
    await run(process.execPath, ['scripts/ci-workspace.mjs', 'prepare', 'selected-group', filename], { CODEXIA_CI_GROUP_TASKS: JSON.stringify(tasks) });
    const report = JSON.parse(readFileSync(filename, 'utf8'));
    if (report.length !== tasks.length || report.some((entry, i) => entry.task !== tasks[i])) throw new Error('Invalid workspace preparation report');
    for (const entry of report) groupPreparation.set(entry.task, entry);
  } catch (error) { groupPreparationError = String(error); }
}

const preparationSeconds = (Date.now() - preparationStarted) / 1000;
console.log(JSON.stringify({ phase: 'shared-workspace-preparation', group, seconds: preparationSeconds, concurrency: limit }));

function executeTask(task, index) {
  const scope = { invocations: [] };
  return taskInvocationContext.run(scope, () => executeTaskInContext(task, index, scope));
}

async function executeTaskInContext(task, index, scope) {
  const started = Date.now();
  let error = preparationError || (task !== 'coverage' && (groupPreparationError || groupPreparation.get(task)?.error)) || undefined;
  let blocked = Boolean(error || (task === 'audit-core' && completed.get('build-core')?.status !== 'passed' && tasks.includes('build-core')));
  if (blocked && !error) error = 'Core build prerequisite failed';
  let inputProof;
  if (!blocked) {
    try {
      if (task.startsWith('unit-')) await node('scripts/ci-workspace.mjs', 'unit', task.slice(5));
      else if (task.startsWith('typecheck-')) {
        await node('scripts/ci-workspace.mjs', 'typecheck', task.slice(10));
      } else if (task.startsWith('test-types-')) {
        await node('scripts/ci-workspace.mjs', 'test-types', task.slice(11));
      } else if (task === 'safety') {
        await run('pnpm', ['typecheck:safety']);
      } else if (task.startsWith('build-')) await run('pnpm', ['build'], { CODEXIA_PROFILE: task.slice(6) });
      else if (task === 'audit-core') await run('pnpm', ['audit:core']);
      else if (task.startsWith('oci-')) await run('bash', ['scripts/verify-oci.sh'], { OCI_ENGINE: 'docker', CODEXIA_PROFILE: task.slice(4), CODEXIA_OCI_IMAGE: `codexia-verification:${task.slice(4)}` });
      else if (task.startsWith('browser-')) {
        const [, profile, ...suite] = task.split('-');
        let executing = false;
        try {
          await withBrowserFixture(task, index, async env => {
            executing = true;
            await run(process.execPath, ['scripts/run-browser-shard.mjs', '--profile', profile, '--suite', suite.join('-'), '--prebuilt'],
              { ...env, CODEXIA_CI_REPORT_DIR: path.join(reportDirectory, task) });
          });
        } catch (error) { if (!executing) blocked = true; throw error; }
      } else if (task.startsWith('hosted-native-')) {
        const selection = task.slice(14);
        // Composition consumers have already restored every Full server/module build.
        // profile-package still rebuilds the actual selected UI and verifies its deployed closure.
        if (selection === 'catalog') await run('pnpm', ['--filter', '@codexia/module-*...', 'build']);
        await run(process.execPath, ['scripts/verify-hosted-native.mjs', '--selection', selection],
          { CODEXIA_NATIVE_REPORT_PATH: path.join(reportDirectory, 'native-report.json'),
            ...(nativeArtifact ? {CODEXIA_NATIVE_PRODUCER_REPORT:process.env.CODEXIA_CI_NATIVE_PRODUCER_REPORT} : {}) });
      } else if (task === 'coverage') {
        const runtime = coverageRuntime();
        const workflowRunId = Number(process.env.GITHUB_RUN_ID);
        const workflowAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
        const workflowJob = process.env.GITHUB_JOB;
        const closure = await captureCoverageInputClosure({ root: process.cwd(), runtime,
          invocation: coverageInvocation(runtime.execPath), workflowJob });
        const proofArgs = { closure, sourceSha: sha, planDigest: planDigest(plan), workflowRunId, workflowAttempt, workflowJob, runtime };
        const candidateProof = coverageInputProof(proofArgs);
        const reuse = plan.taskInputReuse?.coverage;
        let reusable = false;
        if (reuse && plan.base === reuse.sourceSha && process.env.GITHUB_RUN_ID && process.env.GITHUB_RUN_ATTEMPT) {
          const baselineProof = { ...reuse, sourceSha: reuse.proofSourceSha, format: 'codexia-ci-task-input-proof/v2', mode: 'static-coverage', status: 'passed' };
          reusable = selectEquivalentTaskProofs({ tasks: ['coverage'], baseline: [baselineProof], candidate: [candidateProof],
            baselineIdentity: { sourceSha: reuse.proofSourceSha, planDigest: reuse.planDigest,
              workflowRunId: reuse.workflowRunId, workflowAttempt: reuse.workflowAttempt },
            candidateIdentity: { sourceSha: sha, planDigest: planDigest(plan), workflowRunId, workflowAttempt },
          }).includes('coverage');
        }
        if (reusable) {
          inputProof = coverageInputProof({ ...proofArgs, reusedFrom: reuse });
          console.log('Reused exact-base static coverage proof; supplemental CI contract tests remain selected when required.');
        } else {
          await node('scripts/ci-workspace.mjs', 'coverage');
        }
        // These supplemental contract tests remain mandatory for affected plans even when the
        // static coverage check itself is safely reused.
        if (!plan.tasks.includes('unit-root')) await node('--test', 'scripts/ci-contract.test.mjs', 'scripts/ci-impact.test.mjs', 'scripts/ci-profile-artifact.test.mjs', 'scripts/ci-native-producer.test.mjs', 'scripts/ci-parallel.test.mjs', 'scripts/ci-task-input-proof.test.mjs', 'scripts/reuse-pr-verification.test.mjs');
      } else throw new Error(`No runner for ${task}`);
    } catch (caught) { error = String(caught); }
  }
  if (task === 'coverage' && !blocked && !error && process.env.GITHUB_RUN_ID !== undefined && !inputProof) {
    const workflowRunId = Number(process.env.GITHUB_RUN_ID);
    const workflowAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
    const workflowJob = process.env.GITHUB_JOB;
    const runtime = coverageRuntime();
    const closure = await captureCoverageInputClosure({ root: process.cwd(), runtime,
      invocation: coverageInvocation(runtime.execPath), workflowJob });
    inputProof = coverageInputProof({ closure, sourceSha: sha, planDigest: planDigest(plan), workflowRunId, workflowAttempt, workflowJob, runtime });
  }
  if (task !== 'coverage' && !blocked && !error && process.env.GITHUB_RUN_ID !== undefined) {
    const workflowRunId = Number(process.env.GITHUB_RUN_ID);
    const workflowAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
    const workflowJob = process.env.GITHUB_JOB;
    try {
      const runtime = coverageRuntime();
      taskProofClosureFor ??= captureTaskInputSource({ root: process.cwd(), sha, runtime });
      const closure = taskProofClosureFor(task, scope.invocations);
      inputProof = taskInputProof({ task, closure, sourceSha: sha, planDigest: planDigest(plan),
        workflowRunId, workflowAttempt, workflowJob, runtime });
    } catch (caught) {
      console.log(`Task input proof unavailable for ${task}; task result remains executed and future reuse will fall back (${String(caught).replace(/[\r\n]+/gu, ' | ')}).`);
    }
  }
  const result = { task, status: blocked ? 'blocked' : error ? 'failed' : 'passed', seconds: (Date.now() - started) / 1000, invocations: scope.invocations, ...(inputProof ? { inputProof } : {}), ...(error ? { error } : {}) };
  completed.set(task, result);
  console.log(JSON.stringify(result));
  return result;
}
// Only proven read-only unit suites can overlap; writers, model tests and root scripts are barriers.
const independentUnits = new Set(['unit-contracts', 'unit-persistence-contracts', 'unit-app', 'unit-story', 'unit-publishing', 'unit-mcp', 'unit-search']);
const exclusive = task => {
  if (group.startsWith('browser-')) return task.endsWith('-redesign-visual'); // performance measurements must not contend with siblings
  if (group.startsWith('types-')) return groupPreparation.get(task)?.exclusive ?? false;
  if (group.startsWith('unit-')) return !independentUnits.has(task);
  return true;
};
const executionStarted = Date.now();
const settled = await runBounded(tasks, executeTask, { limit, exclusive });
const executionSeconds = (Date.now() - executionStarted) / 1000;
const results = settled.map((entry, index) => entry.status === 'fulfilled' ? entry.value : { task: tasks[index], status: 'failed', seconds: 0, error: String(entry.reason) });
const digest = planDigest(plan);
const reportResults = results;
let producerInventory = null;
let workflowIdentity = null;
if (process.env.GITHUB_RUN_ID !== undefined) {
  workflowIdentity = {
    workflowRunId: Number(process.env.GITHUB_RUN_ID),
    workflowAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    workflowJob: process.env.GITHUB_JOB,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
  };
  producerInventory = assertTaskProducerInventory({
    plan,
    report: { group, sha, planDigest: digest, ...workflowIdentity, results: reportResults },
    inventory: {
      format: 'codexia-ci-task-producer-inventory/v1',
      group,
      sourceSha: sha,
      planDigest: digest,
      ...workflowIdentity,
      runner: {
        os: process.env.RUNNER_OS ?? process.platform,
        arch: process.env.RUNNER_ARCH ?? process.arch,
        imageOS: process.env.ImageOS ?? null,
        imageVersion: process.env.ImageVersion ?? null,
        nodeVersion: process.version,
      },
      selectedTasks: tasks,
      groupInvocations,
      taskInvocations: results.map(({ task, status, invocations, inputProof }) => ({ task, status, invocations, ...(inputProof ? { inputProof } : {}) })),
    },
  });
}
const report = { group, sha, planDigest: digest, ...(workflowIdentity ?? {}), timing: { concurrency: limit, preparationSeconds, executionSeconds }, ...(profileArtifact ? {profileArtifact} : {}), ...(nativeArtifact ? {nativeArtifact} : {}), results: reportResults, ...(producerInventory ? { producerInventory } : {}) };
writeFileSync(path.join(reportDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  `| Validation | Result | Seconds |\n| --- | --- | ---: |\n${results.map(item => `| ${item.task} | ${item.status} | ${item.seconds.toFixed(1)} |`).join('\n')}\n`);
if (results.some(item => item.status !== 'passed')) process.exitCode = 1;
