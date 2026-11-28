import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolveManualPublisherRun } from './prepare-revalidation.mjs';
import { prepareManualVerifierContext } from './run-revalidation.mjs';

const context = { repository: 'yohn-jp/codexia', owner: 'yohn-jp', repo: 'codexia', repositoryId: 1450072993, ownerId: 405 };

const require = createRequire(new URL('../../../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(await readFile(new URL('../../../.github/workflows/backend-handoff-revalidate.yml', import.meta.url), 'utf8'));
const sha = char => char.repeat(40);
const run = () => ({
  id: 44878012473,
  run_attempt: 1,
  run_number: 773,
  path: '.github/workflows/backend-release.yml',
  event: 'workflow_run',
  head_branch: 'main',
  head_sha: sha('a'),
  status: 'completed',
  conclusion: 'success',
  repository: { full_name: context.repository, id: context.repositoryId, owner: { id: context.ownerId } },
  head_repository: { full_name: context.repository, id: context.repositoryId, owner: { id: context.ownerId } },
  actor: { login: 'ignored-public-metadata' },
});
const env = () => ({
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: context.repository, GITHUB_REPOSITORY_ID: String(context.repositoryId), GITHUB_REPOSITORY_OWNER_ID: String(context.ownerId),
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: sha('b'),
  CODEXIA_PUBLISHER_RUN_ID: '44878012473',
  CODEXIA_PUBLISHER_SHA: sha('a'),
  GH_TOKEN: 'opaque-test-token',
});

test('manual selection queries the authenticated API and accepts only the exact successful main publisher', async () => {
  let requested;
  const publisher = await resolveManualPublisherRun({ env: env(), checkoutSha: sha('b'), fetchImpl: async (url, options) => {
    requested = { url, options };
    return Response.json(run());
  } });
  assert.equal(String(requested.url), 'https://api.github.com/repos/yohn-jp/codexia/actions/runs/44878012473');
  assert.ok(new Headers(requested.options.headers).get('authorization')?.includes('opaque-test-token'));
  assert.equal(publisher.id, 44878012473);
  assert.equal(publisher.run_number, 773);
  assert.equal(publisher.head_sha, sha('a'));
  assert.equal('actor' in publisher, false, 'The local event contains only verifier-required run fields');

  for (const [patch, checkoutSha] of [
    [{ GITHUB_EVENT_NAME: 'push' }, sha('b')],
    [{ GITHUB_REF: 'refs/heads/feature' }, sha('b')],
    [{ GITHUB_SHA: sha('c') }, sha('b')],
    [{ CODEXIA_PUBLISHER_RUN_ID: '0' }, sha('b')],
    [{ CODEXIA_PUBLISHER_RUN_ID: '44878012473x' }, sha('b')],
    [{ CODEXIA_PUBLISHER_SHA: 'invalid' }, sha('b')],
  ]) {
    await assert.rejects(resolveManualPublisherRun({ env: { ...env(), ...patch }, checkoutSha, fetchImpl: async () => Response.json(run()) }));
  }
  for (const invalid of [
    { path: '.github/workflows/other.yml' },
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { repository: { full_name: 'fork/codexia' } },
    { head_repository: { full_name: 'fork/codexia' } },
  ]) {
    await assert.rejects(resolveManualPublisherRun({ env: env(), checkoutSha: sha('b'), fetchImpl: async () => Response.json({ ...run(), ...invalid }) }));
  }
  await assert.rejects(resolveManualPublisherRun({ env: env(), checkoutSha: sha('b'), fetchImpl: async () => Response.json({}, { status: 403 }) }), /HTTP 403/u);
});

test('manual context is built from the authenticated API run and exact checked-out publisher source', async () => {
  const repositoryPath = fileURLToPath(new URL('../../../', import.meta.url));
  const checkedOutSha = execFileSync('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const envForWrapper = {
    ...env(),
    GITHUB_SHA: checkedOutSha,
    CODEXIA_PUBLISHER_SHA: checkedOutSha,
    GITHUB_WORKSPACE: repositoryPath,
    CODEXIA_MANUAL_REVALIDATION: 'true',
  };
  const context = await prepareManualVerifierContext({ env: envForWrapper, fetchImpl: async () => Response.json({ ...run(), head_sha: checkedOutSha }) });
  assert.equal(context.env.GITHUB_EVENT_NAME, 'workflow_run');
  assert.equal(context.payload.workflow_run.head_sha, checkedOutSha);
  assert.equal(context.payload.workflow_run.id, 44878012473);
  assert.equal(context.payload.workflow_run.run_number, 773);
  assert.equal(context.payload.workflow_run.path, '.github/workflows/backend-release.yml');
  assert.equal('GITHUB_EVENT_PATH' in context.env, false);
  await assert.rejects(prepareManualVerifierContext({ env: { ...envForWrapper, GITHUB_EVENT_NAME: 'push' }, fetchImpl: async () => Response.json(run()) }));
  await assert.rejects(prepareManualVerifierContext({ env: { ...envForWrapper, CODEXIA_MANUAL_REVALIDATION: 'false' }, fetchImpl: async () => Response.json(run()) }));
  await assert.rejects(prepareManualVerifierContext({
    env: { ...envForWrapper, CODEXIA_PUBLISHER_SHA: sha('a') },
    fetchImpl: async () => Response.json(run()),
  }), /Publisher checkout differs/u);
});

test('manual publisher selection requires a separate exact source SHA input', async () => {
  await assert.rejects(resolveManualPublisherRun({
    env: { ...env(), CODEXIA_PUBLISHER_SHA: undefined },
    checkoutSha: sha('b'),
    fetchImpl: async () => ({ ok: true, json: async () => run() }),
  }));
});

test('deployment-credential-free workflow revalidates on main and has no target mutation capability', () => {
  assert.equal(workflow.on.workflow_dispatch.inputs.publisher_run_id.required, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.publisher_sha.required, true);
  assert.equal(workflow.jobs.contract.if, "github.event_name == 'pull_request'");
  const manual = workflow.jobs.revalidate;
  assert.match(manual.if, /github\.event_name == 'workflow_dispatch'/u);
  assert.match(manual.if, /github\.ref == 'refs\/heads\/main'/u);
  assert.equal(manual.environment, undefined);
  assert.deepEqual(manual.permissions, { contents: 'read', actions: 'read', packages: 'read' });
  assert.equal(manual.permissions['id-token'], undefined);
  assert.equal(manual.steps.some(step => /ansible-playbook|deploy-production|codexia_stage:\s*deploy/u.test(step.run ?? '')), false);
  for (const step of manual.steps) {
    for (const value of Object.values(step.env ?? {})) assert.doesNotMatch(String(value), /secrets\./u);
  }
  const checkoutSource = manual.steps.find(step => step.name === 'Check out exact publisher source for source binding');
  assert.equal(checkoutSource.with.ref, '${{ inputs.publisher_sha }}');
  assert.equal(manual.steps.find(step => step.name === 'Resolve exact successful publisher run from GitHub API')
    .env.CODEXIA_PUBLISHER_SHA, '${{ inputs.publisher_sha }}');
  const verifier = manual.steps.find(step => step.name === 'Verify exact certificate, producer receipt and immutable images');
  assert.equal(verifier['working-directory'], 'publisher-source');
  assert.equal(verifier.run, 'node "$GITHUB_WORKSPACE/scripts/deployment/handoff/run-revalidation.mjs"');
  assert.equal(verifier.env.CODEXIA_MANUAL_REVALIDATION, 'true');
  assert.equal(verifier.env.CODEXIA_PUBLISHER_SHA, '${{ inputs.publisher_sha }}');
  assert.equal(verifier.env.GITHUB_EVENT_NAME, undefined, 'The runner-owned event name must not be overridden');
  assert.equal(verifier.env.GITHUB_EVENT_PATH, undefined, 'Caller-supplied workflow payloads are not accepted');
  assert.equal(JSON.stringify(workflow).includes('codexia-production'), false);
});
