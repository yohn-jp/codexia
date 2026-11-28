#!/usr/bin/env node
import { actionsRepository, assertArtifactRunRepository, matchesRunRepository } from '../../github/repository.mjs';
import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';
import { selectLatestPlanArtifact } from '../evidence/artifact-selection.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';

const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_OUTPUT, RUNNER_TEMP, CODEXIA_EXPECTED_SHA } = process.env;
assert.match(GITHUB_REPOSITORY ?? '', /^[\w.-]+\/[\w.-]+$/);
assert.match(GITHUB_RUN_ID ?? '', /^\d+$/);
assert.match(CODEXIA_EXPECTED_SHA ?? '', /^[a-f0-9]{40}$/);
assert.ok(GH_TOKEN, 'Read token is required');
assert.ok(GITHUB_OUTPUT, 'GitHub output path is required');
assert.ok(RUNNER_TEMP, 'Runner temporary directory is required');

const context = actionsRepository();
const github = createGitHubOctokit({ token: GH_TOKEN });
const { owner, repo } = context;
const run = (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(GITHUB_RUN_ID) })).data;
assert.equal(String(run.id), GITHUB_RUN_ID, 'Workflow run ID mismatch');
assert.ok(matchesRunRepository(run, context, { sameHead: run.event !== 'pull_request' }), 'Verification repository mismatch');
assert.equal(run.path, '.github/workflows/verify.yml', 'Verification workflow path mismatch');
assert.equal(run.head_sha, CODEXIA_EXPECTED_SHA, 'Workflow run source SHA mismatch');
const identity = { runId: GITHUB_RUN_ID, sourceSha: CODEXIA_EXPECTED_SHA };
const [artifacts, jobs] = await Promise.all([
  paginateActionsInventory(github, github.rest.actions.listWorkflowRunArtifacts,
    { owner, repo, run_id: Number(GITHUB_RUN_ID) }, 'artifacts'),
  paginateActionsInventory(github, github.rest.actions.listJobsForWorkflowRun,
    { owner, repo, run_id: Number(GITHUB_RUN_ID), filter: 'latest' }, 'jobs'),
]);
const planArtifact = selectLatestPlanArtifact(artifacts, jobs, identity);
assertArtifactRunRepository(planArtifact, run);
for (const artifact of artifacts.filter(item => item.name.startsWith('ci-evidence-'))) assertArtifactRunRepository(artifact, run);
const inventoryPath = path.join(RUNNER_TEMP, 'ci-artifact-inventory.json');
await mkdir(path.dirname(inventoryPath), { recursive: true });
await writeFile(inventoryPath, `${JSON.stringify({ identity, artifacts, jobs }, null, 2)}\n`, { mode: 0o600 });
await appendFile(GITHUB_OUTPUT, `artifact-id=${planArtifact.id}\ninventory-path=${inventoryPath}\n`);
console.log(`Selected latest exact-run ci-plan artifact ${planArtifact.id} from successful job window at ${CODEXIA_EXPECTED_SHA}.`);
