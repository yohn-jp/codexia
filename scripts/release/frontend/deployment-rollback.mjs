#!/usr/bin/env node
// Reconcile an uncertain Wrangler response against the exact active Worker,
// then return only the candidate version to its captured previous deployment.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deploymentEdgeFromEnvironment, protectedCloudflareTarget } from './initial-publication.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const digest = /^[a-f0-9]{64}$/u;
const account = /^[a-f0-9]{32}$/u;
const worker = 'codexia-frontend';

export function frontendPublicationContext(env) {
  const target = protectedCloudflareTarget(env);
  assert.ok(account.test(target.accountId ?? '') && env.CLOUDFLARE_ACCOUNT_ID === target.accountId,
    'Worker publication credentials do not match the protected Cloudflare account');
  const { GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt, CODEXIA_SOURCE_SHA: sourceSha } = env;
  assert.ok(/^[1-9]\d*$/u.test(runId ?? '') && /^[1-9]\d*$/u.test(attempt ?? '') &&
    /^[a-f0-9]{40}$/u.test(sourceSha ?? ''), 'Worker publication requires the certified source and current Actions run');
  return { ...target, runId, attempt, sourceSha };
}

export function assertSingleDeployment(value) {
  assert.ok(value && uuid.test(value.id) && value.strategy === 'percentage' &&
    Array.isArray(value.versions) && value.versions.length === 1 &&
    uuid.test(value.versions[0].version_id) && value.versions[0].percentage === 100,
  'Production Worker must have exactly one pinned version at 100%');
  return { deploymentId: value.id, versionId: value.versions[0].version_id };
}

export function selectRollback(before, current, deployedTag, expectedTag) {
  assert.ok(before && uuid.test(before.deploymentId) && uuid.test(before.versionId),
    'Missing pinned pre-deploy Worker identity');
  assert.ok(current && uuid.test(current.deploymentId) && uuid.test(current.versionId),
    'Missing observed post-deploy Worker identity');
  if (current.deploymentId === before.deploymentId && current.versionId === before.versionId) return 'unchanged';
  assert.notEqual(current.versionId, before.versionId, 'Worker deployment identity changed without a new version');
  assert.equal(deployedTag, expectedTag, 'A different Worker version is now live; refuse to override it');
  return 'rollback';
}

export async function reconcileFrontendDeployment(mode, env, fetchImpl = fetch) {
  const context = frontendPublicationContext(env);
  const { accountId } = context;
  const token = env.CLOUDFLARE_API_TOKEN;
  const artifactDigest = env.CODEXIA_FRONTEND_ARTIFACT_DIGEST;
  const state = env.CODEXIA_FRONTEND_ROLLBACK_STATE;
  assert.ok(account.test(accountId ?? '') && typeof token === 'string' && token.length > 0 &&
    digest.test(artifactDigest ?? '') && typeof state === 'string' && state.startsWith('/'),
  'Rollback requires approved Worker account, credentials, immutable artifact and private state path');
  assert.ok(mode === 'capture' || mode === 'restore', 'Unsupported frontend rollback operation');
  const expectedTag = `frontend-${artifactDigest}`;
  const record = mode === 'restore' ? JSON.parse(await readFile(state, 'utf8')) : null;
  if (record) {
    assert.equal(record.format, 'codexia-frontend-rollback/v2');
    assert.equal(record.expectedTag, expectedTag);
    assert.deepEqual(record.context, context, 'Frontend rollback belongs to a different deployment target');
  }
  const ingress = await deploymentEdgeFromEnvironment(env, fetchImpl).observeIngress();
  if (record) {
    assert.equal(record.ingressDigest, ingress.ingressDigest, 'Protected Cloudflare ingress changed since publication');
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker}`;
  const request = async (path, init = {}) => {
    const response = await fetchImpl(base + path, {
      ...init, headers: { Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json();
    assert.ok(response.ok && payload.success === true && !payload.errors?.length && payload.result,
      `Worker deployment operation rejected (HTTP ${response.status})`);
    return payload.result;
  };
  const readCurrent = async () => {
    const result = await request('/deployments?per_page=1');
    assert.ok(Array.isArray(result.deployments) && result.deployments.length === 1,
      'Missing Worker deployment inventory');
    return assertSingleDeployment(result.deployments[0]);
  };
  if (mode === 'capture') {
    const before = await readCurrent();
    assert.equal(before.deploymentId, ingress.deployment.id, 'Worker deployment changed during target verification');
    assert.equal(before.versionId, ingress.deployment.versionId, 'Worker version changed during target verification');
    await writeFile(state, JSON.stringify({ format: 'codexia-frontend-rollback/v2', context,
      ingressDigest: ingress.ingressDigest, before, expectedTag }) + '\n',
      { flag: 'wx', mode: 0o600 });
    console.log('Pinned pre-deployment Worker version for failure reconciliation.');
    return;
  }
  const current = await readCurrent();
  if (current.deploymentId === record.before?.deploymentId && current.versionId === record.before?.versionId) {
    console.log('Worker was not changed; no rollback required.');
    return;
  }
  const version = await request('/versions/' + current.versionId);
  assert.equal(version.id, current.versionId, 'Active Worker version identity changed');
  const decision = selectRollback(record.before, current, version.annotations?.['workers/tag'], expectedTag);
  if (decision === 'unchanged') return;
  try {
    await request('/deployments', { method: 'POST', body: JSON.stringify({
      strategy: 'percentage', versions: [{ version_id: record.before.versionId, percentage: 100 }],
      annotations: { 'workers/message': 'Restore prior verified Codexia frontend after failed publication' },
    }) });
  } catch {
    // A lost response is ambiguous. Observe the actual active version below.
  }
  const restored = await readCurrent();
  assert.equal(restored.versionId, record.before.versionId,
    'Worker rollback was not verified; production identity requires operator recovery');
  console.log('Restored the exact pre-deployment Worker version.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  reconcileFrontendDeployment(process.argv[2], process.env).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
