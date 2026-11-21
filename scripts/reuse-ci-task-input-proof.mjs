#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planDigest, validateVerificationPlan } from './ci-impact.mjs';
import { resolveExactMainCoverageProof } from './ci-task-proof-reuse.mjs';

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  assert.equal(command, 'plan', 'Usage: reuse-ci-task-input-proof.mjs plan');
  assert.equal(extra.length, 0, 'Usage: reuse-ci-task-input-proof.mjs plan');
  const planPath = process.env.CODEXIA_CI_PLAN_PATH ?? 'ci-plan.json';
  const plan = validateVerificationPlan(JSON.parse(await readFile(planPath, 'utf8')));
  if (plan.event !== 'pull_request' || !plan.tasks.includes('coverage')) {
    console.log('Task proof reuse not applicable; canonical verification plan remains unchanged.');
    return;
  }
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GH_TOKEN || !GITHUB_REPOSITORY || !/^\d+$/u.test(GITHUB_RUN_ID ?? '')) {
    console.log('Exact-main task proof unavailable; coverage runs normally.');
    return;
  }
  let coverage;
  try {
    const currentResponse = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    assert.ok(currentResponse.ok, `Current workflow identity unavailable: HTTP ${currentResponse.status}`);
    const current = await currentResponse.json();
    coverage = await resolveExactMainCoverageProof({ plan, current, repository: GITHUB_REPOSITORY, token: GH_TOKEN });
  } catch (error) {
    console.log(`Exact-base task proof unavailable; full selected verification remains enabled (${String(error)}).`);
    return;
  }
  const updated = { ...plan, taskInputReuse: { format: 'codexia-ci-task-input-reuse/v1', coverage } };
  validateVerificationPlan(updated);
  if (planDigest(updated) !== planDigest(plan)) throw new Error('Task proof metadata changed the canonical plan digest');
  const temporaryPath = `${planPath}.${GITHUB_RUN_ID}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, { flag: 'wx' });
  await rename(temporaryPath, planPath);
  console.log(`Exact-base coverage proof selected from main run ${coverage.workflowRunId}, artifact ${coverage.artifactId}.`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `Static coverage input proof candidate: main run ${coverage.workflowRunId}, attempt ${coverage.workflowAttempt}, artifact ${coverage.artifactId} (${coverage.artifactDigest}). The task runner will compare every closure digest before reuse.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

export { main };
