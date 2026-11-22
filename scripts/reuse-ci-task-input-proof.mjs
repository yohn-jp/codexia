#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planDigest, validateVerificationPlan, createVerificationPlan, verificationPlanOutputs } from './ci-impact.mjs';
import { resolveExactMainCoverageProof, resolveExactMainTaskProofs } from './ci-task-proof-reuse.mjs';
import { captureTaskInputSource, taskWorkflowJob } from './ci-task-inputs.mjs';
import { selectEquivalentTaskProofs } from './ci-task-input-proof.mjs';
import { coverageRuntime } from './ci-coverage-inputs.mjs';
import { VERIFICATION_TASKS } from './ci-contract.mjs';

async function publishPlan(plan, planPath) {
  const temporaryPath = `${planPath}.${process.env.GITHUB_RUN_ID ?? 'local'}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'w' });
  await rename(temporaryPath, planPath);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    Object.entries(verificationPlanOutputs(plan)).map(([key, value]) => `${key}=${value}\n`).join(''));
  return plan;
}

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  assert.equal(command, 'plan', 'Usage: reuse-ci-task-input-proof.mjs plan');
  assert.equal(extra.length, 0, 'Usage: reuse-ci-task-input-proof.mjs plan');
  const planPath = process.env.CODEXIA_CI_PLAN_PATH ?? 'ci-plan.json';
  const selectedPlan = validateVerificationPlan(JSON.parse(await readFile(planPath, 'utf8')));
  let plan = selectedPlan;
  if (plan.event !== 'pull_request' || !plan.tasks.includes('coverage')) {
    console.log('Task proof reuse not applicable; canonical verification plan remains unchanged.');
    await publishPlan(plan, planPath);
    return;
  }
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GH_TOKEN || !GITHUB_REPOSITORY || !/^\d+$/u.test(GITHUB_RUN_ID ?? '')) {
    if (plan.mode === 'affected') plan = validateVerificationPlan(createVerificationPlan({ ...plan, forceFull: true }));
    console.log('Exact-main task proof unavailable; full verification selected.');
    await publishPlan(plan, planPath);
    return;
  }
  try {
    const currentResponse = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (!currentResponse.ok) throw new Error(`Current workflow identity lookup returned HTTP ${currentResponse.status}`);
    const current = await currentResponse.json();
    if (plan.mode === 'affected') {
      const omitted = VERIFICATION_TASKS.filter(task => !plan.tasks.includes(task) && task !== 'coverage');
      const resolved = await resolveExactMainTaskProofs({ plan, current, repository: GITHUB_REPOSITORY, token: GH_TOKEN, tasks: omitted });
      const runtime = coverageRuntime();
      const baseline = omitted.map(task => ({ ...resolved[task], format: 'codexia-ci-task-input-proof/v2',
        mode: 'task-execution', status: 'passed', sourceSha: resolved[task].proofSourceSha }));
      const closureFor = captureTaskInputSource({ root: process.cwd(), sha: plan.sha, runtime });
      const candidate = [];
      for (const task of omitted) {
        const closure = closureFor(task);
        candidate.push({ task, format: 'codexia-ci-task-input-proof/v2', mode: 'task-execution', status: 'passed',
          sourceSha: plan.sha, planDigest: planDigest(plan), workflowRunId: current.id, workflowAttempt: current.run_attempt,
          workflowJob: taskWorkflowJob(task), inputClosure: closure });
      }
      const reusable = selectEquivalentTaskProofs({ tasks: omitted, baseline, candidate,
        baselineIdentity: { sourceSha: resolved[omitted[0]].proofSourceSha, planDigest: resolved[omitted[0]].planDigest,
          workflowRunId: resolved[omitted[0]].workflowRunId, workflowAttempt: resolved[omitted[0]].workflowAttempt },
        candidateIdentity: { sourceSha: plan.sha, planDigest: planDigest(plan), workflowRunId: current.id,
          workflowAttempt: current.run_attempt },
      });
      assert.deepEqual(reusable, omitted, 'One or more omitted task inputs differ from exact-base main');
      const omittedProofs = Object.fromEntries(omitted.map(task => [task, resolved[task]]));
      plan = validateVerificationPlan({ ...plan, taskInputReuse: { format: 'codexia-ci-task-input-reuse/v2',
        coverage: resolved.coverage, omitted: omittedProofs } });
      console.log(`Exact-base task proof set accepted for all ${omitted.length} omitted validations.`);
    } else {
      const coverage = await resolveExactMainCoverageProof({ plan, current, repository: GITHUB_REPOSITORY, token: GH_TOKEN });
      plan = validateVerificationPlan({ ...plan, taskInputReuse: { format: 'codexia-ci-task-input-reuse/v2', coverage, omitted: {} } });
      console.log(`Exact-base static coverage proof selected from main run ${coverage.workflowRunId}, artifact ${coverage.artifactId}.`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    if (selectedPlan.mode === 'affected') {
      plan = validateVerificationPlan(createVerificationPlan({ ...selectedPlan, forceFull: true }));
      console.log(`Exact-base task proof incomplete or ineligible; full verification selected (${detail.replace(/[\r\n]+/gu, ' | ')}).`);
    } else {
      plan = selectedPlan;
      console.log(`Exact-base coverage proof unavailable; full verification remains selected (${detail.replace(/[\r\n]+/gu, ' | ')}).`);
    }
  }
  if (planDigest(plan) !== planDigest(selectedPlan) && !plan.forceFull) throw new Error('Task proof metadata changed the canonical plan digest');
  await publishPlan(plan, planPath);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    plan.mode === 'affected' && plan.taskInputReuse?.omitted
      ? `Reused ${Object.keys(plan.taskInputReuse.omitted).length} omitted task proofs from first-parent main after all seven input dimensions matched.\n`
      : plan.taskInputReuse?.coverage
        ? `Static coverage input proof candidate: main run ${plan.taskInputReuse.coverage.workflowRunId}, attempt ${plan.taskInputReuse.coverage.workflowAttempt}, artifact ${plan.taskInputReuse.coverage.artifactId} (${plan.taskInputReuse.coverage.artifactDigest}).\n`
        : `All verification tasks selected because exact-base proof reuse was not eligible.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

export { main };
