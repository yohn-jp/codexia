#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveManualPublisherRun } from './prepare-backend-handoff-revalidation.mjs';
import { verifyBackendPushHandoff } from './verify-backend-push-handoff.mjs';

export async function prepareManualVerifierContext({ env = process.env, fetchImpl = fetch } = {}) {
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Manual certificate revalidation requires the actual workflow_dispatch event');
  assert.equal(env.CODEXIA_MANUAL_REVALIDATION, 'true', 'Manual revalidation workflow marker is missing');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Manual certificate revalidation must run from main');
  assert.ok(path.isAbsolute(env.GITHUB_WORKSPACE ?? ''), 'Trusted main checkout path is invalid');

  const mainCheckoutSha = execFileSync('git', ['-C', env.GITHUB_WORKSPACE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const publisherCheckoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const publisher = await resolveManualPublisherRun({ env, checkoutSha: mainCheckoutSha, fetchImpl });
  assert.equal(publisherCheckoutSha, publisher.head_sha, 'Publisher checkout differs from the authenticated publisher run');

  // Build the workflow_run payload only from the authenticated REST response.
  // The runner's reserved GITHUB_EVENT_NAME remains workflow_dispatch.
  const payload = Object.freeze({ workflow_run: publisher });
  const verifierEnv = { ...env, GITHUB_EVENT_NAME: 'workflow_run' };
  return { env: verifierEnv, payload };
}

export async function runManualRevalidation(options = {}) {
  const context = await prepareManualVerifierContext(options);
  return verifyBackendPushHandoff({ ...context, fetchImpl: options.fetchImpl || fetch });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runManualRevalidation().catch(error => {
    console.error(error instanceof Error ? error.message : 'Manual backend handoff revalidation failed');
    process.exitCode = 1;
  });
}
