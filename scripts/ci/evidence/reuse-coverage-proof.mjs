#!/usr/bin/env node
// Optional reuse applies only to the selected coverage check; impact selection is authoritative.
import { actionsRepository, matchesRunRepository } from '../../github/repository.mjs';
import assert from 'node:assert/strict';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateVerificationPlan, verificationPlanOutputs } from '../impact/plan.mjs';
import { resolveExactMainCoverageProof } from './proof-reuse.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';

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
  assert.equal(command, 'plan', 'Usage: reuse-coverage-proof.mjs plan');
  assert.equal(extra.length, 0, 'Usage: reuse-coverage-proof.mjs plan');
  const planPath = process.env.CODEXIA_CI_PLAN_PATH ?? 'ci-plan.json';
  const selectedPlan = validateVerificationPlan(JSON.parse(await readFile(planPath, 'utf8')));
  let plan = selectedPlan;
  if (plan.event !== 'pull_request' || !plan.tasks.includes('coverage')) {
    console.log('Coverage proof reuse not applicable; impact plan unchanged.');
  } else {
    const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
    if (!GH_TOKEN || !GITHUB_REPOSITORY || !/^\d+$/u.test(GITHUB_RUN_ID ?? '')) {
      console.log('Coverage proof unavailable; execute the selected coverage task.');
    } else {
      try {
        const context = actionsRepository();
        const github = createGitHubOctokit({ token: GH_TOKEN });
        const { owner, repo } = context;
        const { data: current } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(GITHUB_RUN_ID) });
        assert.ok(matchesRunRepository(current, context, { sameHead: false }), 'Verify repository mismatch');
        const coverageReuse = await resolveExactMainCoverageProof({
          plan, current, repository: GITHUB_REPOSITORY, token: GH_TOKEN,
        });
        plan = validateVerificationPlan({ ...plan, coverageReuse });
        console.log(`Optional exact-base static coverage proof found (main run ${coverageReuse.workflowRunId}).`);
      } catch (error) {
        console.log(`Coverage proof not eligible; execute selected coverage only (${String(error.message).replace(/[\r\n]+/gu, ' | ')}).`);
      }
    }
  }
  await publishPlan(plan, planPath);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `Impact plan preserved: ${plan.mode}, ${plan.tasks.length} selected; ${plan.excluded.length} NOT_SELECTED. ` +
    (plan.coverageReuse ? 'Static coverage proof candidate attached.\n' : 'Selected coverage executes normally.\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
export { main };
