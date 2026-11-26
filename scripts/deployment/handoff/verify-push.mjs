#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadArtifact, extractArtifactFiles } from '../../ci/evidence/download-artifacts.mjs';
import { assertVerificationJobs } from '../../release/components/policy.mjs';
import { selectReleaseSource } from '../../release/components/source-gate.mjs';
import { publishedBackendCompatibility, successfulPublicationJobs, verifyExistingBackendRelease } from '../../release/backend/verify-existing.mjs';
import { expectedBackendMigrationFingerprint, inspectBackendImageWithoutExecution } from '../../release/backend/image-inspection.mjs';
import { validatePushDeploymentCertificate } from '../admission/validate.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';

const REPOSITORY = 'yohn-jp/codexia';
const WORKFLOW_PATH = '.github/workflows/backend-release.yml';
const VERIFY_PATH = '.github/workflows/verify.yml';
const CERTIFICATE_FILE_LIMIT = 2 * 1024 * 1024;
const JOB_OUTPUT_LIMIT = 512 * 1024;
const ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;
const sha = /^[a-f0-9]{40}$/u;
const positive = value => Number.isSafeInteger(value) && value > 0;

export function assertTrustedBackendPublicationRun(run, expected) {
  assert.ok(run && typeof run === 'object', 'Backend publication run is missing');
  assert.equal(run.id, expected.id, 'Backend publication run ID mismatch');
  assert.equal(run.run_attempt, expected.attempt, 'Backend publication run attempt mismatch');
  assert.ok(positive(expected.runNumber), 'Backend publication expected run number is invalid');
  assert.equal(run.run_number, expected.runNumber, 'Backend publication run number mismatch');
  assert.equal(run.path, WORKFLOW_PATH, 'Unexpected backend publication workflow');
  assert.equal(run.event, 'workflow_run', 'Backend publisher must follow verified main Verify');
  assert.equal(run.head_branch, 'main', 'Backend publication branch must be main');
  assert.equal(run.status, 'completed', 'Backend publication is not complete');
  assert.equal(run.conclusion, 'success', 'Backend publication did not succeed');
  assert.equal(run.repository?.full_name, REPOSITORY, 'Backend publication repository mismatch');
  assert.equal(run.head_repository?.full_name, REPOSITORY, 'Backend publication source repository mismatch');
  assert.match(run.head_sha ?? '', sha, 'Backend publication main SHA is invalid');
  assert.equal(run.head_sha, expected.headSha, 'Backend publication source differs from the expected main SHA');
  return run;
}

export function backendReleaseValidationEnvironment(env, run) {
  assert.ok(positive(run?.id) && positive(run?.run_number), 'Backend publication run identity is invalid');
  return { ...env, GITHUB_RUN_ID: String(run.id), GITHUB_RUN_NUMBER: String(run.run_number) };
}

function certificateArtifactPattern(run) {
  return new RegExp(`^codexia-backend-deployment-certificate-([a-f0-9]{40})-run-${run.id}-attempt-${run.run_attempt}$`, 'u');
}

export function selectPushDeploymentCertificateArtifact(artifacts, run, { sourceSha } = {}) {
  assert.ok(Array.isArray(artifacts), 'Backend publication artifact inventory is invalid');
  assert.ok(positive(run?.id) && positive(run?.run_attempt) && sha.test(run?.head_sha ?? ''), 'Backend publication identity is invalid');
  const pattern = certificateArtifactPattern(run);
  const matches = artifacts.filter(artifact => typeof artifact?.name === 'string' && pattern.test(artifact.name));
  assert.equal(matches.length, 1, 'Expected one deployment certificate artifact for this publication run and attempt');
  const artifact = matches[0];
  if (sourceSha !== undefined) {
    assert.match(sourceSha, sha, 'Backend publication artifact source SHA is invalid');
    assert.equal(pattern.exec(artifact.name)[1], sourceSha, 'Deployment certificate artifact source SHA mismatch');
  }
  assert.equal(artifact.expired, false, 'Deployment certificate artifact is expired');
  assert.equal(String(artifact.workflow_run?.id), String(run.id), 'Deployment certificate artifact run mismatch');
  assert.equal(artifact.workflow_run?.head_sha, run.head_sha, 'Deployment certificate artifact workflow head mismatch');
  assert.match(artifact.digest ?? '', /^sha256:[a-f0-9]{64}$/u, 'Deployment certificate artifact digest is invalid');
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 &&
    artifact.size_in_bytes <= ARTIFACT_MAX_BYTES, 'Deployment certificate artifact size is invalid');
  return artifact;
}

export function validatePushDeploymentCertificatePair(values, expectedMainSha) {
  assert.ok(Array.isArray(values) && values.length === 2, 'Expected Core and Full deployment certificates');
  const certificates = values.map(value => validatePushDeploymentCertificate(value, expectedMainSha));
  const byProfile = new Map(certificates.map(value => [value.identity.profile, value]));
  assert.equal(byProfile.size, 2, 'Expected one certificate for each backend profile');
  assert.ok(byProfile.has('core') && byProfile.has('full'), 'Expected Core and Full deployment certificates');
  const core = byProfile.get('core'), full = byProfile.get('full');
  assert.notEqual(core.image, full.image, 'Core and Full deployment images must be distinct immutable digests');
  for (const key of ['verifiedMainSha', 'verifiedMainTree']) assert.equal(core[key], full[key], 'Backend certificates differ in main source');
  assert.deepEqual(core.verifyRun, full.verifyRun, 'Backend certificates differ in Verify run identity');
  for (const key of ['event', 'sourceSha', 'sourceTree', 'runId', 'attempt']) {
    assert.equal(core.producer[key], full.producer[key], 'Backend certificates differ in producer provenance: ' + key);
  }
  assert.deepEqual(core.producer.receipt, full.producer.receipt, 'Backend certificates differ in complete producer receipt');
  for (const key of ['version', 'sourceSha', 'platform', 'migrationFingerprint', 'apiEpoch', 'persistenceFormat']) {
    assert.equal(core.identity[key], full.identity[key], 'Core and Full identities differ: ' + key);
  }
  return [core, full];
}

export function createHandoffDeploymentOutputs({ fullImage, producerSha, fullCertificate }) {
  const certificate = validatePushDeploymentCertificate(fullCertificate, fullCertificate?.verifiedMainSha);
  assert.match(fullImage ?? '', /^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u);
  assert.match(producerSha ?? '', sha);
  assert.equal(certificate.identity.profile, 'full');
  assert.equal(certificate.image, fullImage);
  assert.equal(certificate.producer.sourceSha, producerSha);
  assert.ok(positive(certificate.identity.apiEpoch), 'Certified Full backend API epoch is invalid');
  const encodedCertificate = Buffer.from(JSON.stringify(certificate)).toString('base64');
  assert.ok(encodedCertificate.length <= JOB_OUTPUT_LIMIT, 'Verified Full deployment certificate exceeds the job output limit');
  return Object.freeze({ fullImage, producerSha, verifiedMainSha: certificate.verifiedMainSha,
    fullApiEpoch: String(certificate.identity.apiEpoch), fullCertificate: encodedCertificate });
}

async function githubJson(resource, token, fetchImpl = fetch) {
  const github = createGitHubOctokit({ token, fetchImpl, timeout: 20_000 });
  const run = /^actions\/runs\/([1-9]\d{0,15})$/u.exec(resource);
  assert.ok(run, 'Unapproved backend deployment run lookup');
  return (await github.rest.actions.getWorkflowRun({ owner: 'yohn-jp', repo: 'codexia', run_id: Number(run[1]) })).data;
}

async function githubPages(resource, token, fetchImpl, key, parameters = {}) {
  const github = createGitHubOctokit({ token, fetchImpl, timeout: 20_000 });
  const [owner, repo] = REPOSITORY.split('/');
  const run = /^actions\/runs\/([1-9]\d{0,15})\/(jobs|artifacts)$/u.exec(resource);
  assert.ok(run, 'Unapproved backend deployment pagination endpoint');
  if (run[2] === 'jobs') return paginateActionsInventory(github, github.rest.actions.listJobsForWorkflowRun,
    { owner, repo, run_id: Number(run[1]), ...parameters }, key);
  return paginateActionsInventory(github, github.rest.actions.listWorkflowRunArtifacts,
    { owner, repo, run_id: Number(run[1]), ...parameters }, key);
}

async function verifyVerifyRun(runId, certificate, token, fetchImpl) {
  const run = await githubJson(`actions/runs/${runId}`, token, fetchImpl);
  assert.equal(run.path, VERIFY_PATH, 'Certificate Verify workflow mismatch');
  assert.equal(run.event, 'push', 'PR Verify runs cannot authorize deployment');
  assert.equal(run.head_branch, 'main', 'Certificate Verify run is not on main');
  assert.equal(run.status, 'completed', 'Certificate Verify run is incomplete');
  assert.equal(run.conclusion, 'success', 'Certificate Verify run failed');
  assert.equal(run.repository?.full_name, REPOSITORY, 'Certificate Verify repository mismatch');
  assert.equal(run.head_repository?.full_name, REPOSITORY, 'Certificate Verify source repository mismatch');
  assert.equal(run.head_sha, certificate.verifiedMainSha, 'Certificate Verify source SHA mismatch');
  assert.equal(run.id, certificate.verifyRun.id, 'Certificate Verify run ID mismatch');
  assert.equal(run.run_attempt, certificate.verifyRun.attempt, 'Certificate Verify run attempt mismatch');
  const jobs = await githubPages(`actions/runs/${runId}/jobs`, token, fetchImpl, 'jobs', { filter: 'latest' });
  assertVerificationJobs(jobs);
}

function publisherSkippedRelease(publisher) {
  assert.equal(publisher.status, 'completed', 'Backend publication job is incomplete');
  if (publisher.conclusion === 'skipped') return true;
  assert.equal(publisher.conclusion, 'success', 'Backend publication job failed');
  const steps = publisher.steps ?? [];
  assert.ok(Array.isArray(steps), 'Backend publication step inventory is invalid');
  const freshness = steps.filter(step => step?.name === 'Require complete exact-source main verification');
  assert.ok(freshness.length === 1 && freshness[0].status === 'completed' && freshness[0].conclusion === 'success',
    'Missing or unsuccessful backend publication freshness gate');

  const publication = [
    steps.filter(step => step?.name === 'Publish commit-addressed image'),
    steps.filter(step => step?.name === 'Record independent backend release'),
    steps.filter(step => step?.name === 'Create certified Core and Full push handoff'),
    steps.filter(step => typeof step?.name === 'string' && /^Run actions\/upload-artifact@\S+$/u.test(step.name)),
  ];
  assert.ok(publication.every(matches => matches.length === 1 && matches[0].status === 'completed'),
    'Incomplete deployment publication step inventory');
  if (publication.every(([step]) => step.conclusion === 'skipped')) return true;
  assert.ok(publication.every(([step]) => step.conclusion === 'success'),
    'Incomplete deployment publication: publishing, release recording and certificate upload must agree');
  return false;
}

async function verifyArtifactAndRelease({ env, payload, run, token, fetchImpl = fetch, usePublishedSourceCompatibility = false }) {
  const runId = run.id;
  const [jobs, artifacts] = await Promise.all([
    githubPages(`actions/runs/${runId}/jobs`, token, fetchImpl, 'jobs', { filter: 'latest' }),
    githubPages(`actions/runs/${runId}/artifacts`, token, fetchImpl, 'artifacts'),
  ]);
  const publishers = jobs.filter(job => job?.name === 'Publish immutable GHCR image');
  assert.equal(publishers.length, 1, 'Expected exactly one backend publication job');
  if (publisherSkippedRelease(publishers[0])) {
    const pattern = certificateArtifactPattern(run);
    assert.equal(artifacts.filter(artifact => typeof artifact?.name === 'string' && pattern.test(artifact.name)).length,
      0, 'A skipped publication cannot emit a deployment certificate');
    return { skipped: true, publisherRunId: run.id };
  }
  const artifact = selectPushDeploymentCertificateArtifact(artifacts, run);
  const sourceSha = certificateArtifactPattern(run).exec(artifact.name)[1];
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 60_000 });
  if (sourceSha !== run.head_sha) {
    assert.ok(selectReleaseSource('backend', sourceSha, run.head_sha, git, null).affected,
      'A newer backend change superseded the certified source');
  }
  const sourceTree = git('rev-parse', sourceSha + '^{tree}').trim();
  const bytes = await downloadArtifact(artifact, REPOSITORY, token, fetchImpl, { maxArchive: ARTIFACT_MAX_BYTES, downloadTimeoutMs: 30_000 });
  const scratch = await mkdtemp(path.join(env.RUNNER_TEMP || tmpdir(), 'codexia-backend-deploy-handoff-'));
  try {
    const files = await extractArtifactFiles(bytes, scratch, { maxArchive: ARTIFACT_MAX_BYTES, maxUncompressed: ARTIFACT_MAX_BYTES });
    assert.deepEqual(files.sort(), ['core.json', 'full.json'], 'Handoff artifact must contain only Core and Full certificates');
    const certificates = await Promise.all(['core.json', 'full.json'].map(async filename =>
      JSON.parse(await readFile(path.join(scratch, filename), 'utf8'))));
    const [core, full] = validatePushDeploymentCertificatePair(certificates, sourceSha);
    assert.equal(core.verifiedMainTree, sourceTree, 'Deployment certificate source tree differs from the certified Git tree');
    const publisherJobsOkay = successfulPublicationJobs(jobs, full.producer.event === 'pull_request', true);
    assert.ok(publisherJobsOkay, 'Backend publication jobs do not prove the certified producer path');
    await verifyVerifyRun(core.verifyRun.id, core, token, fetchImpl);

    const selected = full;
    const receiptPath = selected.producer.event === 'pull_request'
      ? path.join(scratch, 'codexia-backend-promotion.json')
      : path.join(scratch, 'codexia-backend-build.json');
    await writeFile(receiptPath, JSON.stringify(selected.producer.receipt) + '\n', { mode: 0o600, flag: 'wx' });
    const backendWorkflowEvent = payload?.workflow_run?.event;
    assert.equal(backendWorkflowEvent, 'workflow_run', 'Backend publication was not triggered by the completed Verify workflow');
    const releaseEnv = {
      ...backendReleaseValidationEnvironment(env, run),
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: run.head_sha,
      GITHUB_EVENT_NAME: backendWorkflowEvent,
      GITHUB_RUN_ID: String(run.id),
      CODEXIA_SOURCE_SHA: sourceSha,
      CODEXIA_VERIFY_RUN_ID: String(core.verifyRun.id),
      GH_TOKEN: token,
      ...(selected.producer.event === 'pull_request'
        ? { CODEXIA_BACKEND_PROMOTION_DIR: scratch }
        : { CODEXIA_BACKEND_ARTIFACT_MANIFEST: receiptPath }),
    };
    await verifyExistingBackendRelease({ env: releaseEnv, usePublishedSourceCompatibility, args: [full.image, sourceSha, full.producer.sourceSha,
      full.identity.version, 'full', full.producer.event] });

    const compatibility = usePublishedSourceCompatibility
      ? publishedBackendCompatibility(sourceSha)
      : JSON.parse(await readFile(new URL('../../../deploy/update-compatibility.json', import.meta.url), 'utf8'));
    const migrationFingerprint = await expectedBackendMigrationFingerprint(usePublishedSourceCompatibility ? sourceSha : undefined);
    for (const certificate of [core, full]) {
      execFileSync('docker', ['pull', certificate.image], { stdio: 'ignore', timeout: 180_000 });
      const observed = await inspectBackendImageWithoutExecution(certificate.image, {
        sourceSha: certificate.identity.sourceSha,
        version: certificate.identity.version,
        profile: certificate.identity.profile,
        migrationFingerprint,
        compatibility,
      }, { tempRoot: env.RUNNER_TEMP || undefined });
      assert.deepEqual(observed, certificate.identity, 'Published OCI image differs from its handoff certificate');
    }
    return { publisherRunId: run.id, verifyRunId: core.verifyRun.id, coreImage: core.image, fullImage: full.image,
      producerSha: full.producer.sourceSha, fullCertificate: full };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Verify a selected completed production publisher in a separately approved maintenance run. */
export async function verifyLifecycleBackendPublication(publisherRunId, { env = process.env, fetchImpl = fetch } = {}) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, 'Lifecycle backend repository mismatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Lifecycle backend verification requires main');
  assert.ok(positive(publisherRunId), 'Lifecycle backend publisher run ID is invalid');
  const token = env.GH_TOKEN;
  assert.ok(token, 'Actions read token is required');
  const selected = await githubJson('actions/runs/' + publisherRunId, token, fetchImpl);
  const run = assertTrustedBackendPublicationRun(selected, {
    id: publisherRunId, attempt: selected.run_attempt, runNumber: selected.run_number, headSha: selected.head_sha,
  });
  execFileSync('git', ['merge-base', '--is-ancestor', run.head_sha, 'HEAD'], { stdio: 'ignore' });
  const result = await verifyArtifactAndRelease({
    env, payload: { workflow_run: run }, run, token, fetchImpl, usePublishedSourceCompatibility: true,
  });
  assert.equal(result.skipped, undefined, 'Selected backend publisher did not publish certified images');
  return result;
}

export async function verifyBackendPushHandoff(options = {}) {
  const env = options.env || process.env;
  const payload = options.payload || JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  const fetchImpl = options.fetchImpl || fetch;
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, 'Handoff repository mismatch');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_run', 'Handoff requires a completed backend workflow run');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Handoff workflow must execute from main');
  const triggered = payload?.workflow_run;
  assert.equal(triggered?.path, WORKFLOW_PATH, 'Unexpected completed workflow');
  assert.equal(triggered?.event, 'workflow_run', 'Backend publication must be from verified main source');
  assert.equal(triggered?.head_branch, 'main', 'Backend publication source branch must be main');
  assert.equal(triggered?.conclusion, 'success', 'Failed backend publication cannot hand off an image');
  assert.equal(triggered?.repository?.full_name, REPOSITORY, 'Backend publication repository mismatch');
  assert.equal(triggered?.head_repository?.full_name, REPOSITORY, 'Backend publication source repository mismatch');
  assert.ok(positive(triggered?.id) && positive(triggered?.run_attempt) && positive(triggered?.run_number),
    'Backend publication run identity is invalid');
  assert.match(triggered?.head_sha ?? '', sha, 'Backend publication main SHA is invalid');
  assert.match(env.CODEXIA_PUBLISHER_RUN_ID ?? '', /^[1-9][0-9]*$/u, 'Trusted publisher run ID is required');
  const publisherRunId = Number(env.CODEXIA_PUBLISHER_RUN_ID);
  assert.ok(positive(publisherRunId), 'Trusted publisher run ID is invalid');
  assert.equal(triggered.id, publisherRunId, 'Publisher run ID differs from the workflow event input');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), triggered.head_sha,
    'Handoff checkout differs from backend publication SHA');
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  assert.ok(typeof token === 'string' && token.length > 0, 'Actions read token is required');
  const run = assertTrustedBackendPublicationRun(await githubJson(`actions/runs/${publisherRunId}`, token, fetchImpl), {
    id: publisherRunId,
    attempt: triggered.run_attempt,
    runNumber: triggered.run_number,
    headSha: triggered.head_sha,
  });
  const result = await verifyArtifactAndRelease({ env, payload, run, token, fetchImpl });
  if (result.skipped) {
    if (env.GITHUB_STEP_SUMMARY) await writeFile(env.GITHUB_STEP_SUMMARY,
      `No backend release was selected for main revision ${triggered.head_sha}; no deployment handoff was emitted.\n`);
    console.log(`No backend release selected in publication run ${result.publisherRunId}; handoff not applicable`);
    return result;
  }
  if (env.GITHUB_OUTPUT) {
    const outputs = createHandoffDeploymentOutputs(result);
    await appendFile(env.GITHUB_OUTPUT,
      `full-image=${outputs.fullImage}\nfull-api-epoch=${outputs.fullApiEpoch}\nverified-main-sha=${outputs.verifiedMainSha}\nproducer-sha=${outputs.producerSha}\nfull-certificate=${outputs.fullCertificate}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    await writeFile(env.GITHUB_STEP_SUMMARY,
      '## Certified backend handoff\n\nThe backend publication, Verify provenance, immutable image digests, and deployment certificates were validated.\n\nNo VM or production resource was changed.\n');
  }
  console.log(`Verified backend deployment handoff from publication run ${result.publisherRunId}`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyBackendPushHandoff().catch(error => {
    console.error(error instanceof Error ? error.message : 'Backend deployment handoff verification failed');
    process.exitCode = 1;
  });
}
