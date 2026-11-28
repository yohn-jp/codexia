#!/usr/bin/env node
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { CONFORMANCE_TASKS, VERIFICATION_GROUPS, requiredBuildProfile, requiresWorkspacePreparation } from '../impact/contract.mjs';
import { planDigest, validateVerificationPlan } from '../impact/plan.mjs';
import { assertProfileReceipt } from '../evidence/profile-artifact.mjs';
import { runBounded } from './parallel.mjs';
import { stageCertificationReceipt } from '../evidence/stage-receipt.mjs';
import { withBrowserFixture } from '../browser/fixture.mjs';
import { assertTaskProducerInventory, sanitizeProducerArguments, selectEquivalentTaskProofs } from '../evidence/input-proof.mjs';
import { captureCoverageInputClosure, coverageInputProof, coverageInvocation, coverageRuntime } from '../evidence/coverage-inputs.mjs';
import { captureTaskInputSource, isReadOnlyMergedTask, taskInputProof, taskInvocation } from '../evidence/task-inputs.mjs';

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
const swiftWorkspace = limit === 2 && tasks.includes('architecture-g5') && tasks.includes('swift-linux')
  ? Promise.withResolvers() : null;
const groupPreparation = new Map();
const taskInvocationContext = new AsyncLocalStorage();
const groupInvocations = [];
let groupPreparationError;
let taskProofClosureFor;
const reportDirectory = process.env.CODEXIA_CI_REPORT_DIR ?? path.resolve('ci-results', group);
const conformanceSetup = new Map([
  ['http-conformance', process.env.CODEXIA_CI_HTTP_CONFORMANCE_SETUP],
  ['mcp-conformance', process.env.CODEXIA_CI_MCP_CONFORMANCE_SETUP],
]);
mkdirSync(reportDirectory, { recursive: true });
const run = (command, args, extraEnv = {}, workspaceReady) => new Promise((resolve, reject) => {
  const active = taskInvocationContext.getStore();
  const record = { executable: String(command), arguments: sanitizeProducerArguments(args.map(String)), environmentKeys: Object.keys(extraEnv).sort() };
  (active?.invocations ?? groupInvocations).push(record);
  console.log(`$ ${command} ${args.join(' ')}`);
  const child = spawn(command, args, { stdio: workspaceReady ? ['pipe', 'inherit', 'inherit'] : 'inherit', env: { ...process.env, ...extraEnv } });
  child.once('error', reject);
  let inputError;
  if (workspaceReady && child.stdin) {
    // A failed acquisition can close the private pipe while G5 is still running.
    child.stdin.on('error', error => { inputError = error; });
    workspaceReady.then(() => {
      if (child.stdin.writable) child.stdin.end('workspace-ready\n');
    });
  }
  child.once('close', (status, signal) => {
    if (signal || status !== 0) reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? status})`));
    else if (inputError) reject(inputError);
    else resolve();
  });
});
const node = (...args) => run(process.execPath, args);
let preparationError;
let profileArtifact;
try {
  const requiredProfile = requiredBuildProfile(group);
  if (requiredProfile) {
    // A failed producer or restore is a blocked validation, not a reason to rebuild.
    if (process.env.CODEXIA_CI_PROFILE_RESTORE !== 'success') throw new Error('Profile build/restore prerequisite failed');
    profileArtifact = JSON.parse(readFileSync(process.env.CODEXIA_CI_PROFILE_RECEIPT, 'utf8'));
    assertProfileReceipt(profileArtifact, plan, requiredProfile, process.env.GITHUB_RUN_ID);
  }
  if (group.startsWith('browser-')) await node('scripts/ci/browser/verify-runtime.mjs');
} catch (error) { preparationError = String(error); }
const preparationStarted = Date.now();
const preparationTasks = tasks.filter(task => task !== 'requirements-trace');
if (requiresWorkspacePreparation(preparationTasks) && !preparationError) {
  try {
    const filename = path.resolve(reportDirectory, 'workspace-preparation.json');
    await run(process.execPath, ['scripts/ci/execution/workspace.mjs', 'prepare', 'selected-group', filename], { CODEXIA_CI_GROUP_TASKS: JSON.stringify(preparationTasks) });
    const report = JSON.parse(readFileSync(filename, 'utf8'));
    if (report.length !== preparationTasks.length || report.some((entry, i) => entry.task !== preparationTasks[i])) throw new Error('Invalid workspace preparation report');
    for (const entry of report) groupPreparation.set(entry.task, entry);
  } catch (error) { groupPreparationError = String(error); }
}

const preparationSeconds = (Date.now() - preparationStarted) / 1000;
console.log(JSON.stringify({ phase: 'shared-workspace-preparation', group, seconds: preparationSeconds, concurrency: limit }));

async function executeTask(task, index) {
  const scope = { invocations: [] };
  try {
    return await taskInvocationContext.run(scope, () => executeTaskInContext(task, index, scope));
  } finally {
    if (task === 'architecture-g5') swiftWorkspace?.resolve();
  }
}

async function executeTaskInContext(task, index, scope) {
  const started = Date.now();
  let error = preparationError || (task !== 'coverage' && (groupPreparationError || groupPreparation.get(task)?.error)) || undefined;
  if (conformanceSetup.has(task) && process.env.GITHUB_ACTIONS === 'true' && conformanceSetup.get(task) !== 'success') {
    error ??= 'Official tool or disposable database setup did not complete';
  }
  if (task === 'db-contract' && process.env.GITHUB_ACTIONS === 'true' && process.env.CODEXIA_CI_DB_CONTRACT_IMAGE !== 'success') {
    error ??= 'Pinned DB contract restore image did not materialize';
  }
  if (task === 'codexiactl-linux' && process.env.GITHUB_ACTIONS === 'true' && process.env.CODEXIA_CI_CODEXIACTL_SETUP !== 'success') {
    error ??= 'Pinned Go toolchain setup did not complete';
  }
  let blocked = Boolean(error || (task === 'audit-core' && completed.get('build-core')?.status !== 'passed' && tasks.includes('build-core')));
  if (blocked && !error) error = 'Core build prerequisite failed';
  let inputProof;
  const previous = plan.mergedTaskReuse?.proofs.find(proof => proof.task === task);
  if (!blocked && previous && process.env.GITHUB_ACTIONS === 'true') {
    try {
      const tree = execFileSync('git', ['-c', `safe.directory=${process.cwd()}`, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
      if (tree === plan.mergedTaskReuse.receipt.tree && isReadOnlyMergedTask(process.cwd(), sha, task)) {
        const runtime = coverageRuntime();
        taskProofClosureFor ??= captureTaskInputSource({ root: process.cwd(), sha, runtime });
        const closure = taskProofClosureFor(task, taskInvocation(task, runtime.execPath));
        if (Object.keys(closure).every(key => closure[key] === previous.inputClosure[key])) {
          inputProof = taskInputProof({ task, closure, sourceSha: sha, planDigest: planDigest(plan),
            workflowRunId: Number(process.env.GITHUB_RUN_ID), workflowAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
            workflowJob: process.env.GITHUB_JOB, runtime, reusedFrom: previous });
          console.log('Reused independently certified PR task: ' + task);
        }
      }
    } catch (caught) {
      console.log('Merged task proof unavailable; executing ' + task + ': ' + String(caught).replace(/[\r\n]+/gu, ' | '));
    }
  }
  if (!blocked && !inputProof) {
    try {
      if (task === 'biome-ci') await run(process.execPath, ['scripts/ci/biome/check.mjs'], { CODEXIA_CI_REPORT_DIR: path.join(reportDirectory, task) });
      else if (task === 'swift-linux' || task === 'codexiactl-linux') {
        const { executable, arguments: args } = taskInvocation(task);
        const ready = task === 'swift-linux' ? (swiftWorkspace?.promise ?? Promise.resolve()) : undefined;
        await run(executable, args, {}, ready);
      }
      else if (Object.hasOwn(CONFORMANCE_TASKS, task)) {
        const { executable, arguments: args } = taskInvocation(task);
        await run(executable, args, { CODEXIA_CI_REPORT_DIR: path.join(reportDirectory, task) });
      }
      else if (task.startsWith('unit-')) await node('scripts/ci/execution/workspace.mjs', 'unit', task.slice(5));
      else if (task === 'db-contract') {
        await run('pnpm', ['--filter', '@codexia/persistence-postgres', 'run', 'test:db-contract'], {
          CODEXIA_CI_REPORT_DIR: path.join(reportDirectory, task),
        });
      }
      else if (task.startsWith('typecheck-')) {
        await node('scripts/ci/execution/workspace.mjs', 'typecheck', task.slice(10));
      } else if (task.startsWith('test-types-')) {
        await node('scripts/ci/execution/workspace.mjs', 'test-types', task.slice(11));
      } else if (task === 'safety') {
        await run('pnpm', ['typecheck:safety']);
      } else if (task.startsWith('build-')) await run('pnpm', ['build'], { CODEXIA_PROFILE: task.slice(6) });
      else if (task === 'audit-core') await run('pnpm', ['audit:core']);
      else if (task.startsWith('oci-')) await run('bash', ['scripts/verification/runtime/oci.sh'], { OCI_ENGINE: 'docker', CODEXIA_PROFILE: task.slice(4), CODEXIA_OCI_IMAGE: `codexia-verification:${task.slice(4)}` });
      else if (task.startsWith('browser-')) {
        const [, profile, ...suite] = task.split('-');
        let executing = false;
        try {
          await withBrowserFixture(task, index, async env => {
            executing = true;
            await run(process.execPath, ['scripts/ci/browser/run-shard.mjs', '--profile', profile, '--suite', suite.join('-'), '--prebuilt'],
              { ...env, ...(task.endsWith('-passkey-bootstrap') ? { CODEXIA_PASSKEY_ACCEPTANCE: '1' } : {}),
                CODEXIA_CI_REPORT_DIR: path.join(reportDirectory, task) });
          });
        } catch (error) { if (!executing) blocked = true; throw error; }
      } else if (task === 'coverage') {
        const runtime = coverageRuntime();
        const workflowRunId = Number(process.env.GITHUB_RUN_ID);
        const workflowAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
        const workflowJob = process.env.GITHUB_JOB;
        const closure = await captureCoverageInputClosure({ root: process.cwd(), runtime,
          invocation: coverageInvocation(runtime.execPath), workflowJob });
        const proofArgs = { closure, sourceSha: sha, planDigest: planDigest(plan), workflowRunId, workflowAttempt, workflowJob, runtime };
        const candidateProof = coverageInputProof(proofArgs);
        const reuse = plan.coverageReuse;
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
          await node('scripts/ci/execution/workspace.mjs', 'coverage');
        }
        // These supplemental contract tests remain mandatory for affected plans even when the
        // static coverage check itself is safely reused.
        if (!plan.tasks.includes('unit-root')) await node('--test', 'scripts/ci/impact/contract.test.mjs', 'scripts/ci/impact/plan.test.mjs', 'scripts/ci/evidence/profile-artifact.test.mjs', 'scripts/ci/execution/parallel.test.mjs', 'scripts/ci/evidence/input-proof.test.mjs', 'scripts/ci/certification/reuse-merged-pr.test.mjs');
      } else if (task === 'architecture-g5') {
        await run('npm', ['ci', '--prefix', 'scripts/architecture', '--ignore-scripts', '--no-audit', '--no-fund']);
        const { THREAGILE_IMAGE } = await import('../../architecture/constants.mjs');
        await run('docker', ['pull', THREAGILE_IMAGE]);
        await run(process.execPath, ['scripts/architecture/verify.mjs'], {
          CODEXIA_ARCHITECTURE_EVIDENCE_DIR: path.join(reportDirectory, 'architecture'),
        });
      } else if (task === 'requirements-trace') {
        await run(process.execPath, ['scripts/strictdoc/verify.mjs'], {
          CODEXIA_CI_REPORT_DIR: path.join(reportDirectory, task),
          CODEXIA_CI_SOURCE_SHA: sha,
          CODEXIA_CI_TASK: task,
          CODEXIA_STRICTDOC_PUBLIC: '1',
          STRICTDOC_BIN: process.env.STRICTDOC_BIN ?? path.join(process.env.RUNNER_TEMP ?? '', 'strictdoc/bin/strictdoc'),
        });
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
  if (task !== 'coverage' && !blocked && !error && !inputProof && process.env.GITHUB_RUN_ID !== undefined) {
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
const independentUnits = new Set(['unit-contracts', 'unit-persistence-contracts', 'unit-story', 'unit-publishing', 'unit-mcp', 'unit-search']);
const exclusive = task => {
  // Swift can acquire its tools during G5; its first workspace operation waits on the pipe.
  if (swiftWorkspace && (task === 'architecture-g5' || task === 'swift-linux')) return false;
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
const report = { group, sha, planDigest: digest, ...(workflowIdentity ?? {}), timing: { concurrency: limit, preparationSeconds, executionSeconds }, ...(profileArtifact ? {profileArtifact} : {}), results: reportResults, ...(producerInventory ? { producerInventory } : {}) };
writeFileSync(path.join(reportDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
if (process.env.GITHUB_ACTIONS === 'true') await stageCertificationReceipt(reportDirectory, report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  `| Validation | Result | Seconds |\n| --- | --- | ---: |\n${results.map(item => `| ${item.task} | ${item.status} | ${item.seconds.toFixed(1)} |`).join('\n')}\n`);
if (results.some(item => item.status !== 'passed')) process.exitCode = 1;
