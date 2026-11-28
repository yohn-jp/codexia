#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { selectBackendArtifacts, assertBackendProducerAttempt } from '../../verification/artifacts/backend.mjs';
import { downloadArtifact, extractArtifactFiles } from '../../ci/evidence/download-artifacts.mjs';
import { expectedBackendMigrationFingerprint, assertBackendImageIdentity } from '../../release/backend/image-inspection.mjs';
import { compareComponentVersions, readComponentVersion } from '../../release/components/version.mjs';
import { selectPushDeploymentCertificateArtifact, validatePushDeploymentCertificatePair } from '../handoff/verify-push.mjs';
import { publicationInWorkflowWindow } from '../../release/components/record-model.mjs';
import { successfulPublicationJobs, verifyExistingBackendRelease } from '../../release/backend/verify-existing.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory, paginateGitHubArray } from '../../github/paginate-actions.mjs';

import { actionsRepository, backendImageName, matchesRunRepository, assertBackendImageDigest } from '../../github/repository.mjs';

const target = () => actionsRepository();
const imageRepository = () => backendImageName(target().repository);
const fixtureRegistry = () => imageRepository().replace('ghcr.io/', 'localhost:5000/');
const repositoryBinding = () => {
  const { repository, repositoryId, ownerId } = target();
  return { repository, repositoryId, ownerId };
};
const matchesEvidenceRepository = evidence => Object.entries(repositoryBinding())
  .every(([key, value]) => evidence[key] === value);
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const shaPattern = /^[a-f0-9]{40}$/u;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const tempRoot = process.env.RUNNER_TEMP || os.tmpdir();
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const env = process.env;
const actions = env.GITHUB_ACTIONS === 'true';
const runId = Number(env.GITHUB_RUN_ID);
const attempt = Number(env.GITHUB_RUN_ATTEMPT);
const sourceSha = env.CODEXIA_LIFECYCLE_SOURCE_SHA || env.GITHUB_SHA;
const lifecycleDirectory = path.resolve(tempRoot, 'codexia-push-app-lifecycle');
const evidencePath = path.join(lifecycleDirectory, 'evidence.json');
const reportPath = path.join(lifecycleDirectory, 'outcome.json');
const preparedPath = path.join(lifecycleDirectory, 'prepared-images.json');
// The runner owns this directory; environment overrides must not redirect evidence writes.
if (env.CODEXIA_LIFECYCLE_EVIDENCE_FILE && path.resolve(env.CODEXIA_LIFECYCLE_EVIDENCE_FILE) !== evidencePath) {
  throw new Error('Lifecycle evidence override must equal the runner-owned path');
}
if (env.CODEXIA_LIFECYCLE_REPORT_FILE && path.resolve(env.CODEXIA_LIFECYCLE_REPORT_FILE) !== reportPath) {
  throw new Error('Lifecycle report override must equal the runner-owned path');
}
function check(condition, message) { assert.ok(condition, message); }
function positive(value) { return Number.isSafeInteger(Number(value)) && Number(value) > 0; }

// Writes only run-owned JSON files, atomically replacing their directory entries.
// An exclusive temporary descriptor prevents symlink following or partial evidence files.
async function writeLifecycleJson(destination, value) {
  check([reportPath, preparedPath, evidencePath].includes(destination), 'Unapproved lifecycle evidence destination');
  await mkdir(lifecycleDirectory, { recursive: true, mode: 0o700 });
  const staged = path.join(lifecycleDirectory, `.${path.basename(destination)}-${randomUUID()}.tmp`);
  try {
    const handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    } finally {
      await handle.close();
    }
    await rename(staged, destination);
  } finally {
    await rm(staged, { force: true });
  }
}
function rootlessPodman(args, options = {}) {
  const uid = execFileSync('id', ['-u', 'codexia'], { encoding: 'utf8' }).trim();
  const home = execFileSync('getent', ['passwd', 'codexia'], { encoding: 'utf8' }).trim().split(':')[5];
  const { timeout } = options;
  return execFileSync('sudo', ['-u', 'codexia', 'env', `HOME=${home}`, `XDG_CONFIG_HOME=${home}/.config`,
    `XDG_DATA_HOME=${home}/.local/share`, `XDG_STATE_HOME=${home}/.local/state`, `XDG_RUNTIME_DIR=/run/user/${uid}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,
    // The unprivileged runner must not chdir into the private (0700) home.
    // Change directory only after sudo has switched to the service UID.
    '/bin/bash', '-c', 'cd "$HOME" && exec "$@"', 'bash', '/usr/bin/podman', ...args],
  { encoding: 'utf8', timeout, cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function publicError(error) {
  const message = error instanceof Error ? error.message : 'Lifecycle evidence preparation failed';
  const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8').trim() :
    typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  const value = [message.slice(0, 400), stderr.slice(-750)].filter(Boolean).join('\n');
  return value.replace(/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu, '[REDACTED]')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._-]+/giu, 'Bearer [REDACTED]').slice(0, 1200);
}
let github;
function octokit() { return github ??= createGitHubOctokit({ token, timeout: 20_000 }); }
async function readBackendInventory(endpoint, key, parameters = {}) {
  const { owner, repo } = target();
  if (endpoint === 'actions/runs') return paginateActionsInventory(octokit(),
    octokit().rest.actions.listWorkflowRunsForRepo,
    { owner, repo, ...parameters }, key);
  const jobs = /^actions\/runs\/([1-9]\d*)\/jobs$/u.exec(endpoint);
  if (jobs) return paginateActionsInventory(octokit(), octokit().rest.actions.listJobsForWorkflowRun,
    { owner, repo, run_id: Number(jobs[1]), ...parameters }, key);
  const artifacts = /^actions\/runs\/([1-9]\d*)\/artifacts$/u.exec(endpoint);
  if (artifacts) return paginateActionsInventory(octokit(), octokit().rest.actions.listWorkflowRunArtifacts,
    { owner, repo, run_id: Number(artifacts[1]), ...parameters }, key);
  throw new Error('Unapproved backend lifecycle evidence inventory');
}
function imageIdentity(image, { expectedImage = false, disposableRegistry = false } = {}) {
  const observed = JSON.parse(rootlessPodman(['image', 'inspect', image]))[0];
  const container = rootlessPodman(['create', '--image-volume=ignore', '--entrypoint', '/bin/false', image]);
  const scratch = path.join(os.tmpdir(), `codexia-image-identity-${runId}-${attempt}-${randomUUID()}`);
  try {
    rootlessPodman(['cp', `${container}:/app/update-identity.json`, scratch]);
    const value = JSON.parse(execFileSync('sudo', ['cat', scratch], { encoding: 'utf8' }));
    const digest = image.split('@')[1];
    const expectedDigestRefs = disposableRegistry ? [image, `${fixtureRegistry()}@${digest}`] : [image];
    const identity = assertBackendImageIdentity(value, observed, {});
    if (expectedImage) check(expectedDigestRefs.some(reference => observed.RepoDigests?.includes(reference)), 'Pulled backend image does not bind its exact immutable digest');
    return { identity, imageId: observed.Id, repoDigests: observed.RepoDigests || [], layers: observed.RootFS?.Layers, labels: observed.Config?.Labels };
  } finally {
    rootlessPodman(['rm', '--force', container]);
    execFileSync('sudo', ['rm', '-f', scratch], { stdio: 'ignore' });
  }
}
function parseRelease(release) {
  const blocks = [...String(release?.body || '').matchAll(/```json\s*\n([\s\S]*?)\n```/gu)];
  check(blocks.length === 1, 'Backend release metadata is missing or ambiguous');
  const metadata = JSON.parse(blocks[0][1]);
  check(metadata.component === 'backend' && metadata.tag === undefined, 'Unexpected backend release metadata');
  return metadata;
}
function validateImageIdentity(identity, expectedSha) {
  check(identity.sourceSha === expectedSha, 'Backend image source differs from expected source');
  check(identity.profile === 'full', 'Backend candidate is not the Full profile');
  check(identity.platform === 'linux/amd64', 'Backend image platform is not linux/amd64');
  check(digestPattern.test(identity.migrationFingerprint || ''), 'Backend migration fingerprint is invalid');
  check(Number.isSafeInteger(identity.apiEpoch) && identity.apiEpoch > 0, 'Backend API epoch is invalid');
  check(Number.isSafeInteger(identity.persistenceFormat) && identity.persistenceFormat > 0, 'Backend persistence format is invalid');
  return identity;
}
async function waitForExactSourceBackendRun() {
  const context = target();
  const { owner, repo } = context;
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    const workflowRuns = await paginateActionsInventory(octokit(), octokit().rest.actions.listWorkflowRunsForRepo,
      { owner, repo, head_sha: sourceSha }, 'workflow_runs');
    const acceptedEvents = env.GITHUB_EVENT_NAME === 'pull_request' ? ['pull_request'] : ['pull_request', 'workflow_run'];
    const matches = workflowRuns.filter(run => run?.path === '.github/workflows/backend-release.yml' &&
      acceptedEvents.includes(run.event) && run.head_sha === sourceSha && matchesRunRepository(run, context, { sameHead: run.event !== 'pull_request' }) &&
      (run.event !== 'workflow_run' || run.head_branch === 'main'))
      .sort((left, right) => right.run_number - left.run_number || right.id - left.id);
    if (matches.length) {
      const run = matches[0];
      if (run.status === 'completed') {
        check(run.conclusion === 'success', 'Exact-source backend OCI build did not succeed; no older artifact will be substituted');
        return run;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 15_000));
  }
  throw new Error('Exact-source backend OCI artifact did not become available within 45 minutes');
}

export async function readExactBackendProducerArtifacts(run, expected, { readCollection = readBackendInventory, pause = delay } = {}) {
  let remainingRetries = 3;
  for (;;) {
    const [jobs, artifacts] = await Promise.all([
      readCollection(`actions/runs/${run.id}/jobs`, 'jobs', { filter: 'latest' }),
      readCollection(`actions/runs/${run.id}/artifacts`, 'artifacts'),
    ]);
    try {
      const selected = selectBackendArtifacts(run, artifacts, jobs, expected);
      const full = selected.find(item => item.profile === 'full');
      assertBackendProducerAttempt(full, jobs, expected);
      return selected;
    } catch (error) {
      // The workflow run can become visible as completed before the jobs
      // inventory contains final producer timestamps. Reobserve that same
      // run briefly without changing the accepted artifact window.
      if (remainingRetries === 0 || error?.code !== 'ERR_ASSERTION' ||
          error.message !== 'Invalid backend producer time window') throw error;
      remainingRetries--;
      await pause(5_000);
    }
  }
}

async function loadExactSourceFullCandidate() {
  const run = await waitForExactSourceBackendRun();
  const selected = await readExactBackendProducerArtifacts(run, { sourceSha, runId: run.id, currentAttempt: run.run_attempt,
    event: run.event, workflowSha: sourceSha, headBranch: run.head_branch });
  const full = selected.find(item => item.profile === 'full');
  const bytes = await downloadArtifact(full.artifact, target().repository, token, fetch, { maxArchive: 512 * 1024 * 1024, downloadTimeoutMs: 60_000 });
  const folder = await mkdtemp(path.join(tempRoot, 'codexia-lifecycle-pr-full-'));
  try {
    const files = await extractArtifactFiles(bytes, folder, { maxArchive: 512 * 1024 * 1024, maxUncompressed: 512 * 1024 * 1024 });
    check(files.length === 1 && files[0] === 'codexia-backend-image.tar.gz', 'PR Full artifact contents are unexpected');
    const loadPath = path.join(os.tmpdir(), `codexia-lifecycle-pr-image-${runId}-${attempt}-${randomUUID()}.tar.gz`);
    execFileSync('sudo', ['install', '-m', '0644', path.join(folder, files[0]), loadPath], { stdio: 'ignore' });
    try { rootlessPodman(['load', '--input', loadPath]); }
    finally { execFileSync('sudo', ['rm', '-f', loadPath], { stdio: 'ignore' }); }
    const releaseVersion = readComponentVersion('backend', String(run.run_number));
    const matches = JSON.parse(rootlessPodman(['images', '--format', 'json']));
    const image = matches.flatMap(item => item.Names || []).find(name =>
      /(?:^|\/)codexia-backend-ci(?::latest)?$/u.test(name)) || 'localhost/codexia-backend-ci:latest';
    const observed = imageIdentity(image);
    assert.equal(observed.identity.version, releaseVersion, 'PR Full OCI version differs from its producer run');
    validateImageIdentity(observed.identity, sourceSha);
    assert.equal(observed.identity.migrationFingerprint, await expectedBackendMigrationFingerprint(), 'PR Full image migrations differ from source');
    const compatibility = JSON.parse(await readFile(path.join(root, 'deploy/update-compatibility.json'), 'utf8'));
    assert.equal(observed.identity.apiEpoch, compatibility.apiEpoch, 'PR Full image API epoch differs from source compatibility');
    assert.equal(observed.identity.persistenceFormat, compatibility.persistenceFormat, 'PR Full image persistence format differs from source compatibility');
    check(/^sha256:[a-f0-9]{64}$/u.test(full.artifact.digest || ''), 'PR Full artifact has no immutable artifact digest');
    return { image, identity: observed.identity, imageId: observed.imageId, sourceSha, producerRunId: run.id,
      producerAttempt: run.run_attempt, artifactId: full.artifact.id, artifactDigest: full.artifact.digest,
      producerWorkflow: run.path, producerEvent: run.event, producerConclusion: run.conclusion };
  } finally { await rm(folder, { recursive: true, force: true }); }
}
export function selectPriorPublication(releases, identity) {
  let prior;
  for (const release of releases) {
    if (!/^backend-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(release?.tag_name) ||
        release.draft || release.prerelease) continue;
    let metadata;
    try { metadata = parseRelease(release); } catch { continue; }
    if (release.tag_name !== 'backend-v' + metadata.version || !shaPattern.test(metadata.sourceSha || '') ||
        !metadata.producer || metadata.sourceSha === identity.sourceSha || metadata.producer.sourceSha === identity.sourceSha ||
        metadata.providedApiEpoch !== identity.apiEpoch || metadata.persistenceFormat !== identity.persistenceFormat ||
        compareComponentVersions(metadata.version, identity.version) >= 0) continue;
    if (!prior || compareComponentVersions(metadata.version, prior.metadata.version) > 0) prior = { release, metadata };
  }
  return prior;
}

export function selectLifecycleTransition(head, prior) {
  if (!prior) return { from: 'head', to: 'app-update', kind: 'test-only-digest' };
  check(prior.profile === 'full' && compareComponentVersions(prior.version, head.version) < 0 &&
    prior.apiEpoch === head.apiEpoch && prior.persistenceFormat === head.persistenceFormat &&
    prior.migrationFingerprint === head.migrationFingerprint,
    'The earlier Full image must have compatible database and API identities');
  return { from: 'prior', to: 'head', kind: 'published-upgrade' };
}

async function certifiedCompatibleCandidate(head) {
  const context = target();
  const { owner, repo, repository, repositoryId, ownerId } = context;
  const prior = selectPriorPublication(await paginateGitHubArray(octokit(), octokit().rest.repos.listReleases,
    { owner, repo }, { maxItems: 1_000_000 }), head.identity);
  check(prior, 'No earlier published backend matches the current API epoch and persistence format');
  const { release, metadata } = prior;
  let scratch;
  try {
    check(matchesEvidenceRepository(metadata), 'Backend release repository does not match the current repository');
    const workflowHead = metadata.publication?.workflowHeadSha ?? metadata.sourceSha;
    const runs = metadata.publication
      ? [(await octokit().rest.actions.getWorkflowRun({ owner, repo, run_id: metadata.publication.workflowRunId })).data]
      : await paginateActionsInventory(octokit(), octokit().rest.actions.listWorkflowRuns,
        { owner, repo, workflow_id: 'backend-release.yml', event: 'workflow_run', branch: 'main', head_sha: workflowHead }, 'workflow_runs');
    const publications = runs.filter(run => matchesRunRepository(run, context) && run.path === '.github/workflows/backend-release.yml' && run.event === 'workflow_run' &&
      run.head_branch === 'main' && run.head_sha === workflowHead && run.status === 'completed' &&
      run.conclusion === 'success' && publicationInWorkflowWindow(release, run));
    check(publications.length === 1, 'Backend release must bind one successful publication workflow');
    const [publicationRun] = publications;
    const [jobs, artifacts] = await Promise.all([
      paginateActionsInventory(octokit(), octokit().rest.actions.listJobsForWorkflowRun,
        { owner, repo, run_id: publicationRun.id, filter: 'latest' }, 'jobs'),
      paginateActionsInventory(octokit(), octokit().rest.actions.listWorkflowRunArtifacts,
        { owner, repo, run_id: publicationRun.id }, 'artifacts'),
    ]);
    const certificateArtifact = selectPushDeploymentCertificateArtifact(artifacts, publicationRun, { sourceSha: metadata.sourceSha });
    const certificateBytes = await downloadArtifact(certificateArtifact, repository, token, fetch, { maxArchive: 4 * 1024 * 1024, downloadTimeoutMs: 30_000 });
    scratch = await mkdtemp(path.join(tempRoot, 'codexia-lifecycle-release-proof-'));
    const certFiles = await extractArtifactFiles(certificateBytes, scratch, { maxArchive: 4 * 1024 * 1024, maxUncompressed: 4 * 1024 * 1024 });
    check(certFiles.length === 2 && certFiles.includes('core.json') && certFiles.includes('full.json'), 'Release certificate artifact is incomplete');
    const certificates = await Promise.all(['core.json', 'full.json'].map(async file => JSON.parse(await readFile(path.join(scratch, file), 'utf8'))));
    const [, fullCertificate] = validatePushDeploymentCertificatePair(certificates, metadata.sourceSha, context);
    check(successfulPublicationJobs(jobs, fullCertificate.producer.event === 'pull_request', true), 'Backend publication jobs do not prove a successful producer path');
    check(fullCertificate.image === metadata.images?.full, 'Release metadata Full digest differs from its verified certificate');
    check(fullCertificate.identity.version === metadata.version, 'Full certificate version differs from release metadata');
    selectLifecycleTransition(head.identity, fullCertificate.identity);
    const receiptPath = path.join(scratch, fullCertificate.producer.event === 'pull_request' ? 'codexia-backend-promotion.json' : 'codexia-backend-build.json');
    await writeFile(receiptPath, JSON.stringify(fullCertificate.producer.receipt) + '\n', { mode: 0o600, flag: 'wx' });
    const releaseEnv = {
      GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: String(repositoryId),
      GITHUB_REPOSITORY_OWNER_ID: String(ownerId), GITHUB_ACTIONS: env.GITHUB_ACTIONS, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_run',
      GITHUB_RUN_ID: String(publicationRun.id), GITHUB_RUN_NUMBER: String(publicationRun.run_number),
      GITHUB_SHA: workflowHead, CODEXIA_SOURCE_SHA: metadata.sourceSha,
      CODEXIA_VERIFY_RUN_ID: String(metadata.publication?.verifyRunId ?? ''), GH_TOKEN: token, RUNNER_TEMP: tempRoot,
      ...(fullCertificate.producer.event === 'pull_request' ? { CODEXIA_BACKEND_PROMOTION_DIR: scratch } : { CODEXIA_BACKEND_ARTIFACT_MANIFEST: receiptPath }),
    };
    const verified = await verifyExistingBackendRelease({ env: releaseEnv, usePublishedSourceCompatibility: true, args: [fullCertificate.image, metadata.sourceSha,
      fullCertificate.producer.sourceSha, fullCertificate.identity.version, 'full', fullCertificate.producer.event] });
    check(verified.publicationRunId === publicationRun.id, 'Release and certificate belong to different publications');
    rootlessPodman(['pull', fullCertificate.image], { timeout: 240_000 });
    const observed = imageIdentity(fullCertificate.image, { expectedImage: true });
    assert.deepEqual(observed.identity, fullCertificate.identity, 'Published compatible image identity differs from its certificate');
    return { image: fullCertificate.image, identity: observed.identity, imageId: observed.imageId,
      sourceSha: observed.identity.sourceSha, releaseTag: release.tag_name,
      publicationRunId: publicationRun.id, certificateArtifactId: certificateArtifact.id,
      certificateArtifactDigest: certificateArtifact.digest };
  } catch (error) {
    throw new Error(`${release.tag_name}: ${publicError(error)}`);
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
function pushIntoDisposableRegistry(candidate, name) {
  const sourceTag = `${fixtureRegistry()}:lifecycle-${name}-${sourceSha}`;
  rootlessPodman(['tag', candidate.image, sourceTag]);
  const digestFile = path.join(os.tmpdir(), `codexia-lifecycle-${name}-${runId}-${attempt}-${randomUUID()}.digest`);
  let digest;
  try {
    rootlessPodman(['push', '--digestfile', digestFile, sourceTag], { timeout: 300_000 });
    digest = execFileSync('sudo', ['-u', 'codexia', 'cat', digestFile], { encoding: 'utf8' }).trim();
  } finally { execFileSync('sudo', ['rm', '-f', digestFile], { stdio: 'ignore' }); }
  check(digestPattern.test(digest), `Disposable registry returned an invalid ${name} OCI digest`);
  const image = `${imageRepository()}@${digest}`;
  rootlessPodman(['pull', image], { timeout: 180_000 });
  const observed = imageIdentity(image, { expectedImage: true, disposableRegistry: true });
  assert.deepEqual(observed.identity, candidate.identity, `${name} image identity changed in the disposable registry`);
  check(observed.imageId === candidate.imageId, `${name} image content changed in the disposable registry`);
  return { image, digest, imageId: observed.imageId, repoDigests: observed.repoDigests, profile: 'full', identity: observed.identity };
}
async function prepareImages() {
  check(actions && shaPattern.test(sourceSha || '') && positive(runId) && positive(attempt),
    'Lifecycle image proof must run for an exact repository Actions source and run');
  check(typeof token === 'string' && token.length > 0, 'GitHub Actions read token is required');
  await mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  check(report.sourceSha === sourceSha && report.runId === runId && report.runAttempt === attempt,
    'Existing lifecycle report does not belong to this exact Actions run');
  report.status = 'IN_PROGRESS';
  await writeLifecycleJson(reportPath, report);
  const head = await loadExactSourceFullCandidate();
  validateImageIdentity(head.identity, sourceSha);
  check(digestPattern.test(head.artifactDigest || ''), 'Head candidate must bind an immutable artifact digest');
  let published;
  try {
    const candidate = await certifiedCompatibleCandidate(head);
    validateImageIdentity(candidate.identity, candidate.sourceSha);
    check(digestPattern.test(candidate.certificateArtifactDigest || ''), 'Publication certificate must bind an immutable artifact digest');
    check(/^backend-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(candidate.releaseTag || ''),
      'Published release must use a canonical version tag');
    published = candidate;
  } catch (error) {
    report.fixtureFallbackReason = publicError(error);
  }
  const prepared = { format: 'codexia-push-app-lifecycle-prepared/v1', ...repositoryBinding(), sourceSha, runId, runAttempt: attempt, head, published };
  // codeql[js/http-to-file-access] Only verified immutable GitHub artifact identities are persisted to this private runner file.
  await writeLifecycleJson(preparedPath, prepared);
  report.images = [
    { role: 'head', sourceSha: head.identity.sourceSha, identity: head.identity, producerRunId: head.producerRunId, artifactId: head.artifactId, artifactDigest: head.artifactDigest, certificateResult: 'NOT_USED_SOURCE_ARTIFACT_IDENTITY_VERIFIED' },
  ];
  if (published) report.images.push({ role: 'prior', sourceSha: published.identity.sourceSha, identity: published.identity, releaseTag: published.releaseTag, certificateArtifactId: published.certificateArtifactId, certificateArtifactDigest: published.certificateArtifactDigest, certificateResult: 'PRODUCTION_CERTIFICATE_VERIFIED_FOR_TEST_USE_ONLY' });
  report.status = 'IMAGES_VERIFIED_WAITING_FOR_DISPOSABLE_REGISTRY';
  // codeql[js/http-to-file-access] Verified source metadata is recorded as inert 0600 JSON, never executed.
  await writeLifecycleJson(reportPath, report);
  console.log(JSON.stringify({ preparedPath, reportPath, publishedRelease: published?.releaseTag }, null, 2));
}
async function mirrorPreparedImages() {
  check(actions && shaPattern.test(sourceSha || '') && positive(runId) && positive(attempt),
    'Disposable image mirroring must remain bound to the current Actions run');
  const prepared = JSON.parse(await readFile(preparedPath, 'utf8'));
  check(prepared.format === 'codexia-push-app-lifecycle-prepared/v1' && matchesEvidenceRepository(prepared) && prepared.sourceSha === sourceSha &&
    prepared.runId === runId && prepared.runAttempt === attempt, 'Prepared image evidence belongs to another workflow run');
  const { head, published } = prepared;
  const headRef = pushIntoDisposableRegistry(head, 'head');
  const publishedRef = published && pushIntoDisposableRegistry(published, 'prior');
  const evidence = { format: 'codexia-push-app-lifecycle-evidence/v1', ...repositoryBinding(), sourceSha, runId, runAttempt: attempt,
    backendProducer: { runId: head.producerRunId, attempt: head.producerAttempt, artifactId: head.artifactId,
      artifactDigest: head.artifactDigest, workflow: head.producerWorkflow, event: head.producerEvent,
      conclusion: head.producerConclusion },
    candidates: { head: headRef, ...(publishedRef ? { prior: publishedRef } : {}) },
    transition: selectLifecycleTransition(headRef.identity, publishedRef?.identity),
    ...(published && { publishedRelease: { role: 'prior', tag: published.releaseTag, sourceSha: published.sourceSha, publicationRunId: published.publicationRunId,
      certificateArtifactId: published.certificateArtifactId, certificateArtifactDigest: published.certificateArtifactDigest, certificateVerified: true } }),
    imageChecks: { sourceArtifactDigest: head.artifactDigest, sourceArtifactIdentityVerified: true, sourceArtifactEvent: head.producerEvent,
      publishedCertificateVerified: Boolean(publishedRef), fullProfile: true, platform: 'linux/amd64' } };
  await writeLifecycleJson(evidencePath, evidence);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.images = [
    { role: 'head', image: headRef.image, digest: headRef.digest, imageId: headRef.imageId, repoDigests: headRef.repoDigests, sourceSha: head.identity.sourceSha, identity: head.identity, producerRunId: head.producerRunId, producerEvent: head.producerEvent, artifactId: head.artifactId, artifactDigest: head.artifactDigest, certificateResult: 'NOT_USED_SOURCE_ARTIFACT_IDENTITY_VERIFIED' },
  ];
  if (publishedRef) report.images.push({ role: 'prior', image: publishedRef.image, digest: publishedRef.digest, imageId: publishedRef.imageId, repoDigests: publishedRef.repoDigests, sourceSha: published.identity.sourceSha, identity: published.identity, releaseTag: published.releaseTag, certificateArtifactId: published.certificateArtifactId, certificateArtifactDigest: published.certificateArtifactDigest, certificateResult: 'PRODUCTION_CERTIFICATE_VERIFIED_FOR_TEST_USE_ONLY' });
  report.transition = evidence.transition;
  report.imageEvidence = { path: evidencePath, format: evidence.format, productionAdmissionUsed: false };
  report.status = 'PREPARED';
  await writeLifecycleJson(reportPath, report);
  console.log(JSON.stringify({ evidencePath, reportPath, headImage: headRef.image, publishedImage: publishedRef?.image }, null, 2));
}
async function recordFailedCandidate(image) {
  check(actions && shaPattern.test(sourceSha || '') && positive(runId) && positive(attempt),
    'Fault candidate proof must remain bound to the current Actions run');
  assertBackendImageDigest(image, target().repository);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  check(evidence.format === 'codexia-push-app-lifecycle-evidence/v1' && matchesEvidenceRepository(evidence) && evidence.sourceSha === sourceSha && evidence.runId === runId && evidence.runAttempt === attempt,
    'Fault candidate evidence belongs to another workflow run');
  const base = evidence.candidates[evidence.transition.to];
  check(base && base.image !== evidence.candidates[evidence.transition.from].image,
    'Fault injection requires a verified transition between distinct images');
  const baseImage = imageIdentity(base.image, { expectedImage: true, disposableRegistry: true });
  rootlessPodman(['pull', image], { timeout: 180_000 });
  const observed = imageIdentity(image, { expectedImage: true, disposableRegistry: true });
  assert.deepEqual(observed.identity, base.identity, 'Fault injection changed the verified Full application identity');
  assert.deepEqual(observed.layers, baseImage.layers, 'Fault injection changed the verified Full application layers');
  check(observed.imageId !== base.imageId && image !== base.image, 'Fault injection did not create a distinct image');
  evidence.candidates.failed = { image, digest: image.slice(image.indexOf('@') + 1), imageId: observed.imageId, profile: 'full', identity: observed.identity,
    injection: 'ENTRYPOINT=/bin/false', testOnly: true };
  await writeLifecycleJson(evidencePath, evidence);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.images.push({ role: 'failed-candidate-fixture', image, digest: image.slice(image.indexOf('@') + 1), imageId: observed.imageId, repoDigests: observed.repoDigests, sourceSha: observed.identity.sourceSha, identity: observed.identity,
    testOnly: true, productionAdmissionUsed: false });
  await writeLifecycleJson(reportPath, report);
}

async function recordAuthCandidate(scenario, image) {
  check(actions && shaPattern.test(sourceSha || '') && positive(runId) && positive(attempt),
    'Better Auth test image proof must remain bound to the current Actions run');
  check(['auth-primary', 'auth-update', 'auth-failed', 'app-update'].includes(scenario), 'Invalid Better Auth test scenario');
  assertBackendImageDigest(image, target().repository);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  check(evidence.format === 'codexia-push-app-lifecycle-evidence/v1' && matchesEvidenceRepository(evidence) && evidence.sourceSha === sourceSha &&
    evidence.runId === runId && evidence.runAttempt === attempt, 'Better Auth image evidence belongs to another run');
  const base = imageIdentity(evidence.candidates.head.image, { expectedImage: true, disposableRegistry: true });
  rootlessPodman(['pull', image], { timeout: 180_000 });
  const observed = imageIdentity(image, { expectedImage: true, disposableRegistry: true });
  assert.deepEqual(observed.identity, base.identity, 'Better Auth fixture image lost the verified Full application identity');
  check(observed.imageId !== base.imageId && image !== evidence.candidates.head.image, 'Better Auth fixture image must be a distinct immutable image');
  assert.ok(Array.isArray(base.layers) && base.layers.length > 0);
  assert.deepEqual(observed.layers?.slice(0, base.layers.length), base.layers, 'Better Auth fixture image changed verified application layers');
  assert.equal(observed.labels?.['org.codexia.lifecycle-scenario'], scenario);
  const candidate = { image, digest: image.split('@')[1], imageId: observed.imageId, profile: 'full', identity: observed.identity,
    baseImage: evidence.candidates.head.image, testOnly: true };
  evidence.candidates[scenario] = candidate;
  await writeLifecycleJson(evidencePath, evidence);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.images.push({ ...candidate, role: scenario, repoDigests: observed.repoDigests, productionAdmissionUsed: false });
  await writeLifecycleJson(reportPath, report);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || 'prepare';
  const operation = command === 'prepare' ? prepareImages : command === 'mirror' ? mirrorPreparedImages :
    command === 'record-failed' ? () => recordFailedCandidate(process.argv[3]) :
    command === 'record-auth' ? () => recordAuthCandidate(process.argv[3], process.argv[4]) : null;
  if (!operation) throw new Error('Usage: app.mjs [prepare|mirror|record-failed <immutable-image>|record-auth <scenario> <immutable-image>]');
  operation().catch(async error => {
    const bounded = publicError(error);
    try {
      await mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 });
      const prior = JSON.parse(await readFile(reportPath, 'utf8').catch(() => '{}'));
      prior.sourceSha = sourceSha; prior.runId = runId; prior.runAttempt = attempt;
      prior.status = 'FAIL';
      prior.failure = bounded; prior.updatedAt = new Date().toISOString();
      await writeLifecycleJson(reportPath, prior);
    } catch {}
    console.error(bounded); process.exitCode = 1;
  });
}
