#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertTrustedBackendPublicationRun } from './verify-push.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';

import { actionsRepository } from '../../github/repository.mjs';
const sha = /^[a-f0-9]{40}$/u;

async function readPublisherRun(context, id, token, fetchImpl = fetch) {
  const { owner, repo } = context;
  const github = createGitHubOctokit({ ...context, token, fetchImpl, timeout: 20_000 });
  try {
    return (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: id })).data;
  } catch (error) {
    if (Number.isSafeInteger(error?.status)) {
      throw new Error(`Requested backend publisher run could not be verified (HTTP ${error.status})`, { cause: error });
    }
    throw error;
  }
}

export async function resolveManualPublisherRun({ env, checkoutSha, fetchImpl = fetch }) {
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Manual certificate revalidation requires workflow_dispatch');
  const context = actionsRepository(env);
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Manual certificate revalidation must run from main');
  assert.match(env.GITHUB_SHA ?? '', sha, 'Main workflow SHA is invalid');
  assert.equal(checkoutSha, env.GITHUB_SHA, 'Trusted verifier checkout differs from the dispatch source');
  assert.match(env.CODEXIA_PUBLISHER_RUN_ID ?? '', /^[1-9][0-9]*$/u, 'A positive backend publisher run ID is required');
  assert.match(env.CODEXIA_PUBLISHER_SHA ?? '', sha, 'A backend publisher source SHA is required');
  const id = Number(env.CODEXIA_PUBLISHER_RUN_ID);
  assert.ok(Number.isSafeInteger(id) && id > 0, 'Backend publisher run ID is outside the supported range');
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  assert.ok(typeof token === 'string' && token.length > 0, 'Actions read token is required');
  const run = await readPublisherRun(context, id, token, fetchImpl);
  assertTrustedBackendPublicationRun(run, {
    id,
    attempt: run.run_attempt,
    runNumber: run.run_number,
    headSha: env.CODEXIA_PUBLISHER_SHA,
  }, context);
  return {
    id: run.id,
    run_attempt: run.run_attempt,
    run_number: run.run_number,
    path: run.path,
    event: run.event,
    head_branch: run.head_branch,
    head_sha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion,
    repository: { full_name: context.repository, id: context.repositoryId, owner: { id: context.ownerId } },
    head_repository: { full_name: context.repository, id: context.repositoryId, owner: { id: context.ownerId } },
  };
}

async function main() {
  const env = process.env;
  const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const run = await resolveManualPublisherRun({ env, checkoutSha });
  console.log(`Selected successful main backend publisher run ${run.id}, attempt ${run.run_attempt}, source ${run.head_sha}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Manual backend publisher resolution failed');
    process.exitCode = 1;
  });
}
