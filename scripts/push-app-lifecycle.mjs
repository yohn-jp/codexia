#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { selectBackendArtifacts, assertBackendProducerAttempt } from './verify-backend-artifacts.mjs';
import { downloadArtifact, extractArtifactFiles } from './download-ci-artifacts.mjs';
import { collectGitHubArrayPages, collectGitHubPages } from './release-policy.mjs';
import { expectedBackendMigrationFingerprint, assertBackendImageIdentity } from './backend-image-inspection.mjs';
import { readComponentVersion } from './component-release-version.mjs';
import { selectPushDeploymentCertificateArtifact, validatePushDeploymentCertificatePair } from './verify-backend-push-handoff.mjs';
import { successfulPublicationJobs, verifyExistingBackendRelease } from './verify-existing-backend-release.mjs';

const repository = 'yohn-jp/codexia';
const imagePrefix = 'ghcr.io/yohn-jp/codexia-backend';
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const shaPattern = /^[a-f0-9]{40}$/u;
const root = fileURLToPath(new URL('../', import.meta.url));
const tempRoot = process.env.RUNNER_TEMP || os.tmpdir();
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const env = process.env;
const actions = env.GITHUB_ACTIONS === 'true';
const runId = Number(env.GITHUB_RUN_ID);
const attempt = Number(env.GITHUB_RUN_ATTEMPT);
const sourceSha = env.CODEXIA_LIFECYCLE_SOURCE_SHA || env.GITHUB_SHA;
const evidencePath = env.CODEXIA_LIFECYCLE_EVIDENCE_FILE || path.join(tempRoot, 'codexia-push-app-lifecycle', 'evidence.json');
const reportPath = env.CODEXIA_LIFECYCLE_REPORT_FILE || path.join(tempRoot, 'codexia-push-app-lifecycle', 'outcome.json');
const preparedPath = path.join(path.dirname(evidencePath), 'prepared-images.json');

function check(condition, message) { assert.ok(condition, message); }
function positive(value) { return Number.isSafeInteger(Number(value)) && Number(value) > 0; }
function rootlessPodman(args, options = {}) {
  const uid = execFileSync('id', ['-u', 'codexia'], { encoding: 'utf8' }).trim();
  const home = execFileSync('getent', ['passwd', 'codexia'], { encoding: 'utf8' }).trim().split(':')[5];
  const { timeout } = options;
  return execFileSync('sudo', ['-u', 'codexia', 'env', `HOME=${home}`, `XDG_CONFIG_HOME=${home}/.config`,
    `XDG_DATA_HOME=${home}/.local/share`, `XDG_STATE_HOME=${home}/.local/state`, `XDG_RUNTIME_DIR=/run/user/${uid}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, '/usr/bin/podman', ...args],
  { encoding: 'utf8', timeout, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function publicError(error) {
  const message = error instanceof Error ? error.message : 'Lifecycle evidence preparation failed';
  const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8').trim() :
    typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  const value = [message.slice(0, 400), stderr.slice(-750)].filter(Boolean).join('\n');
  return value.replace(/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu, '[REDACTED]')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._-]+/giu, 'Bearer [REDACTED]').slice(0, 1200);
}
async function api(resource, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/${resource}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub provenance lookup failed (HTTP ${response.status})`);
  return response.json();
}
async function apiPages(resource, key) {
  return collectGitHubPages((page, perPage) => api(`${resource}${resource.includes('?') ? '&' : '?'}per_page=${perPage}&page=${page}`), key);
}
async function apiArrayPages(resource) {
  return collectGitHubArrayPages((page, perPage) => api(`${resource}${resource.includes('?') ? '&' : '?'}per_page=${perPage}&page=${page}`));
}
function imageIdentity(image, { expectedImage = false, disposableRegistry = false } = {}) {
  const observed = JSON.parse(rootlessPodman(['image', 'inspect', image]))[0];
  const container = rootlessPodman(['create', '--entrypoint', '/bin/false', image]);
  const scratch = path.join(os.tmpdir(), `codexia-image-identity-${runId}-${attempt}-${randomUUID()}`);
  try {
    rootlessPodman(['cp', `${container}:/app/update-identity.json`, scratch]);
    const value = JSON.parse(execFileSync('sudo', ['cat', scratch], { encoding: 'utf8' }));
    const digest = image.split('@')[1];
    const expectedDigestRefs = disposableRegistry ? [image, `localhost:5000/yohn-jp/codexia-backend@${digest}`] : [image];
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
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    const response = await api(`actions/runs?head_sha=${sourceSha}&per_page=100`);
    const acceptedEvents = env.GITHUB_EVENT_NAME === 'pull_request' ? ['pull_request'] : ['pull_request', 'workflow_run'];
    const matches = (response.workflow_runs || []).filter(run => run?.path === '.github/workflows/backend-release.yml' &&
      acceptedEvents.includes(run.event) && run.head_sha === sourceSha && run.repository?.full_name === repository &&
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

export async function readExactBackendProducerArtifacts(run, expected, { readCollection = apiPages, pause = delay } = {}) {
  let remainingRetries = 3;
  for (;;) {
    const [jobs, artifacts] = await Promise.all([
      readCollection(`actions/runs/${run.id}/jobs?filter=latest`, 'jobs'),
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
  const bytes = await downloadArtifact(full.artifact, repository, token, fetch, { maxArchive: 512 * 1024 * 1024, downloadTimeoutMs: 60_000 });
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
async function certifiedCompatibleCandidate(head) {
  const releases = await apiArrayPages('releases');
  const candidates = releases.filter(release => release?.tag_name?.startsWith('backend-v') && !release.draft && !release.prerelease)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  const failures = [];
  for (const release of candidates) {
    let metadata;
    try { metadata = parseRelease(release); } catch (error) { failures.push(publicError(error)); continue; }
    if (!shaPattern.test(metadata.sourceSha || '') || metadata.sourceSha === sourceSha || !metadata.publication?.workflowRunId) continue;
    let scratch;
    try {
      const publicationRun = await api(`actions/runs/${metadata.publication.workflowRunId}`);
      check(publicationRun.path === '.github/workflows/backend-release.yml' && publicationRun.event === 'workflow_run' &&
        publicationRun.head_branch === 'main' && publicationRun.status === 'completed' && publicationRun.conclusion === 'success' &&
        publicationRun.head_sha === metadata.publication.workflowHeadSha, 'Historical backend publication run does not bind its recorded workflow head');
      const [jobs, artifacts] = await Promise.all([
        apiPages(`actions/runs/${publicationRun.id}/jobs?filter=latest`, 'jobs'),
        apiPages(`actions/runs/${publicationRun.id}/artifacts`, 'artifacts'),
      ]);
      const certificateArtifact = selectPushDeploymentCertificateArtifact(artifacts, publicationRun, { sourceSha: metadata.sourceSha });
      const certificateBytes = await downloadArtifact(certificateArtifact, repository, token, fetch, { maxArchive: 4 * 1024 * 1024, downloadTimeoutMs: 30_000 });
      scratch = await mkdtemp(path.join(tempRoot, 'codexia-lifecycle-release-proof-'));
      const certFiles = await extractArtifactFiles(certificateBytes, scratch, { maxArchive: 4 * 1024 * 1024, maxUncompressed: 4 * 1024 * 1024 });
      check(certFiles.length === 2 && certFiles.includes('core.json') && certFiles.includes('full.json'), 'Release certificate artifact is incomplete');
      const certificates = await Promise.all(['core.json', 'full.json'].map(async file => JSON.parse(await readFile(path.join(scratch, file), 'utf8'))));
      const [, fullCertificate] = validatePushDeploymentCertificatePair(certificates, metadata.sourceSha);
      check(successfulPublicationJobs(jobs, fullCertificate.producer.event === 'pull_request', true), 'Backend publication jobs do not prove a successful producer path');
      check(fullCertificate.image === metadata.images?.full, 'Release metadata Full digest differs from its verified certificate');
      const receiptPath = path.join(scratch, fullCertificate.producer.event === 'pull_request' ? 'codexia-backend-promotion.json' : 'codexia-backend-build.json');
      await writeFile(receiptPath, JSON.stringify(fullCertificate.producer.receipt) + '\n', { mode: 0o600, flag: 'wx' });
      const releaseEnv = {
        GITHUB_REPOSITORY: repository, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_run',
        GITHUB_RUN_ID: String(publicationRun.id), GITHUB_RUN_NUMBER: String(publicationRun.run_number),
        GITHUB_SHA: metadata.publication.workflowHeadSha, CODEXIA_SOURCE_SHA: metadata.sourceSha,
        CODEXIA_VERIFY_RUN_ID: String(metadata.publication.verifyRunId), GH_TOKEN: token, RUNNER_TEMP: tempRoot,
        ...(fullCertificate.producer.event === 'pull_request' ? { CODEXIA_BACKEND_PROMOTION_DIR: scratch } : { CODEXIA_BACKEND_ARTIFACT_MANIFEST: receiptPath }),
      };
      await verifyExistingBackendRelease({ env: releaseEnv, args: [fullCertificate.image, metadata.sourceSha,
        fullCertificate.producer.sourceSha, fullCertificate.identity.version, 'full', fullCertificate.producer.event] });
      check(fullCertificate.identity.profile === 'full', 'Historical certificate does not bind a Full image');
      if (fullCertificate.identity.apiEpoch !== head.identity.apiEpoch ||
          fullCertificate.identity.persistenceFormat !== head.identity.persistenceFormat ||
          fullCertificate.identity.migrationFingerprint !== head.identity.migrationFingerprint) continue;
      rootlessPodman(['pull', fullCertificate.image], { timeout: 240_000 });
      const observed = imageIdentity(fullCertificate.image, { expectedImage: true });
      assert.deepEqual(observed.identity, fullCertificate.identity, 'Published compatible image identity differs from its certificate');
      return { image: fullCertificate.image, identity: observed.identity, imageId: observed.imageId,
        sourceSha: observed.identity.sourceSha, releaseTag: release.tag_name,
        publicationRunId: publicationRun.id, certificateArtifactId: certificateArtifact.id,
        certificateArtifactDigest: certificateArtifact.digest };
    } catch (error) { failures.push(`${release.tag_name}: ${publicError(error)}`); }
    finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
  }
  throw new Error(`No compatible verified Full image is available; the update scenario is NOT_CHECKED. ${failures.slice(0, 3).join(' | ')}`);
}
function pushIntoDisposableRegistry(candidate, name) {
  const sourceTag = `localhost:5000/yohn-jp/codexia-backend:lifecycle-${name}-${sourceSha}`;
  rootlessPodman(['tag', candidate.image, sourceTag]);
  const digestFile = path.join(os.tmpdir(), `codexia-lifecycle-${name}-${runId}-${attempt}-${randomUUID()}.digest`);
  let digest;
  try {
    rootlessPodman(['push', '--digestfile', digestFile, sourceTag], { timeout: 300_000 });
    digest = execFileSync('sudo', ['-u', 'codexia', 'cat', digestFile], { encoding: 'utf8' }).trim();
  } finally { execFileSync('sudo', ['rm', '-f', digestFile], { stdio: 'ignore' }); }
  check(digestPattern.test(digest), `Disposable registry returned an invalid ${name} OCI digest`);
  const image = `${imagePrefix}@${digest}`;
  rootlessPodman(['pull', image], { timeout: 180_000 });
  const observed = imageIdentity(image, { expectedImage: true, disposableRegistry: true });
  assert.deepEqual(observed.identity, candidate.identity, `${name} image identity changed in the disposable registry`);
  check(observed.imageId === candidate.imageId, `${name} image content changed in the disposable registry`);
  return { image, digest, imageId: observed.imageId, repoDigests: observed.repoDigests, profile: 'full', identity: observed.identity };
}
async function prepareImages() {
  check(actions && env.GITHUB_REPOSITORY === repository && shaPattern.test(sourceSha || '') && positive(runId) && positive(attempt),
    'Lifecycle image proof must run for an exact repository Actions source and run');
  check(typeof token === 'string' && token.length > 0, 'GitHub Actions read token is required');
  await mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  check(report.sourceSha === sourceSha && report.runId === runId && report.runAttempt === attempt,
    'Existing lifecycle report does not belong to this exact Actions run');
  report.status = 'IN_PROGRESS';
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const head = await loadExactSourceFullCandidate();
  const compatible = await certifiedCompatibleCandidate(head);
  // Reject malformed remote artifact/release metadata before writing private CI evidence.
  validateImageIdentity(head.identity, sourceSha);
  validateImageIdentity(compatible.identity, compatible.sourceSha);
  check(shaPattern.test(compatible.sourceSha || ''), 'Compatible candidate must bind a source SHA');
  check(digestPattern.test(head.artifactDigest || ''), 'Head candidate must bind an immutable artifact digest');
  check(digestPattern.test(compatible.certificateArtifactDigest || ''), 'Compatible certificate must bind an immutable artifact digest');
  check(/^backend-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(compatible.releaseTag || ''),
    'Compatible release must use a canonical version tag');
  const prepared = { format: 'codexia-push-app-lifecycle-prepared/v1', sourceSha, runId, runAttempt: attempt, head, compatible };
  // codeql[js/http-to-file-access] Only verified immutable GitHub artifact identities are persisted to this private runner file.
  await writeFile(preparedPath, JSON.stringify(prepared, null, 2) + '\n', { mode: 0o600 });
  report.images = [
    { role: 'head', sourceSha: head.identity.sourceSha, identity: head.identity, producerRunId: head.producerRunId, artifactId: head.artifactId, artifactDigest: head.artifactDigest, certificateResult: 'NOT_USED_SOURCE_ARTIFACT_IDENTITY_VERIFIED' },
    { role: 'compatible', sourceSha: compatible.identity.sourceSha, identity: compatible.identity, releaseTag: compatible.releaseTag, certificateArtifactId: compatible.certificateArtifactId, certificateArtifactDigest: compatible.certificateArtifactDigest, certificateResult: 'PRODUCTION_CERTIFICATE_VERIFIED_FOR_TEST_USE_ONLY' },
  ];
  report.status = 'IMAGES_VERIFIED_WAITING_FOR_DISPOSABLE_REGISTRY';
  // codeql[js/http-to-file-access] Verified source metadata is recorded as inert 0600 JSON, never executed.
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ preparedPath, reportPath, compatibleRelease: compatible.releaseTag }, null, 2));
}
async function mirrorPreparedImages() {
  check(actions && env.GITHUB_REPOSITORY === repository && shaPattern.test(sourceSha || '') && positive(runId) && positive(attempt),
    'Disposable image mirroring must remain bound to the current Actions run');
  const prepared = JSON.parse(await readFile(preparedPath, 'utf8'));
  check(prepared.format === 'codexia-push-app-lifecycle-prepared/v1' && prepared.sourceSha === sourceSha &&
    prepared.runId === runId && prepared.runAttempt === attempt, 'Prepared image evidence belongs to another workflow run');
  const { head, compatible } = prepared;
  const headRef = pushIntoDisposableRegistry(head, 'head');
  const compatibleRef = pushIntoDisposableRegistry(compatible, 'compatible');
  const evidence = { format: 'codexia-push-app-lifecycle-evidence/v1', sourceSha, runId, runAttempt: attempt,
    backendProducer: { runId: head.producerRunId, attempt: head.producerAttempt, artifactId: head.artifactId,
      artifactDigest: head.artifactDigest, workflow: head.producerWorkflow, event: head.producerEvent,
      conclusion: head.producerConclusion },
    candidates: { head: headRef, compatible: compatibleRef },
    compatibleRelease: { tag: compatible.releaseTag, sourceSha: compatible.sourceSha, publicationRunId: compatible.publicationRunId,
      certificateArtifactId: compatible.certificateArtifactId, certificateArtifactDigest: compatible.certificateArtifactDigest, certificateVerified: true },
    imageChecks: { sourceArtifactDigest: head.artifactDigest, sourceArtifactIdentityVerified: true, sourceArtifactEvent: head.producerEvent,
      compatibleCertificateVerified: true, fullProfile: true, platform: 'linux/amd64' } };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.images = [
    { role: 'head', image: headRef.image, digest: headRef.digest, imageId: headRef.imageId, repoDigests: headRef.repoDigests, sourceSha: head.identity.sourceSha, identity: head.identity, producerRunId: head.producerRunId, producerEvent: head.producerEvent, artifactId: head.artifactId, artifactDigest: head.artifactDigest, certificateResult: 'NOT_USED_SOURCE_ARTIFACT_IDENTITY_VERIFIED' },
    { role: 'compatible', image: compatibleRef.image, digest: compatibleRef.digest, imageId: compatibleRef.imageId, repoDigests: compatibleRef.repoDigests, sourceSha: compatible.identity.sourceSha, identity: compatible.identity, releaseTag: compatible.releaseTag, certificateArtifactId: compatible.certificateArtifactId, certificateArtifactDigest: compatible.certificateArtifactDigest, certificateResult: 'PRODUCTION_CERTIFICATE_VERIFIED_FOR_TEST_USE_ONLY' },
  ];
  report.imageEvidence = { path: evidencePath, format: evidence.format, productionAdmissionUsed: false };
  report.status = 'PREPARED';
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ evidencePath, reportPath, headImage: headRef.image, compatibleImage: compatibleRef.image }, null, 2));
}
async function recordFailedCandidate(image) {
  check(actions && env.GITHUB_REPOSITORY === repository && shaPattern.test(sourceSha || '') && positive(runId) && positive(attempt),
    'Fault candidate proof must remain bound to the current Actions run');
  check(/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u.test(image || ''), 'Fault candidate must use a disposable immutable OCI digest');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  check(evidence.format === 'codexia-push-app-lifecycle-evidence/v1' && evidence.sourceSha === sourceSha && evidence.runId === runId && evidence.runAttempt === attempt,
    'Fault candidate evidence belongs to another workflow run');
  const base = evidence.candidates.compatible;
  rootlessPodman(['pull', image], { timeout: 180_000 });
  const observed = imageIdentity(image, { expectedImage: true, disposableRegistry: true });
  assert.deepEqual(observed.identity, base.identity, 'Fault injection changed the verified Full application identity');
  evidence.candidates.failed = { image, digest: image.slice(image.indexOf('@') + 1), imageId: observed.imageId, profile: 'full', identity: observed.identity,
    injection: 'ENTRYPOINT=/bin/false', testOnly: true };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.images.push({ role: 'failed-candidate-fixture', image, digest: image.slice(image.indexOf('@') + 1), imageId: observed.imageId, repoDigests: observed.repoDigests, sourceSha: observed.identity.sourceSha, identity: observed.identity,
    testOnly: true, productionAdmissionUsed: false });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}

async function recordAuthCandidate(scenario, image) {
  check(actions && env.GITHUB_REPOSITORY === repository && shaPattern.test(sourceSha || '') && positive(runId) && positive(attempt),
    'Better Auth test image proof must remain bound to the current Actions run');
  check(['auth-primary', 'auth-update', 'auth-failed'].includes(scenario) &&
    /^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u.test(image || ''), 'Invalid Better Auth test image');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  check(evidence.format === 'codexia-push-app-lifecycle-evidence/v1' && evidence.sourceSha === sourceSha &&
    evidence.runId === runId && evidence.runAttempt === attempt, 'Better Auth image evidence belongs to another run');
  const base = imageIdentity(evidence.candidates.head.image, { expectedImage: true, disposableRegistry: true });
  rootlessPodman(['pull', image], { timeout: 180_000 });
  const observed = imageIdentity(image, { expectedImage: true, disposableRegistry: true });
  assert.deepEqual(observed.identity, base.identity, 'Better Auth fixture image lost the verified Full application identity');
  assert.ok(Array.isArray(base.layers) && base.layers.length > 0);
  assert.deepEqual(observed.layers?.slice(0, base.layers.length), base.layers, 'Better Auth fixture image changed verified application layers');
  assert.equal(observed.labels?.['org.codexia.lifecycle-scenario'], scenario);
  const candidate = { image, digest: image.split('@')[1], imageId: observed.imageId, profile: 'full', identity: observed.identity,
    baseImage: evidence.candidates.head.image, testOnly: true };
  evidence.candidates[scenario] = candidate;
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.images.push({ ...candidate, role: scenario, repoDigests: observed.repoDigests, productionAdmissionUsed: false });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || 'prepare';
  const operation = command === 'prepare' ? prepareImages : command === 'mirror' ? mirrorPreparedImages :
    command === 'record-failed' ? () => recordFailedCandidate(process.argv[3]) :
    command === 'record-auth' ? () => recordAuthCandidate(process.argv[3], process.argv[4]) : null;
  if (!operation) throw new Error('Usage: push-app-lifecycle.mjs [prepare|mirror|record-failed <immutable-image>|record-auth <scenario> <immutable-image>]');
  operation().catch(async error => {
    const bounded = publicError(error);
    try {
      await mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 });
      const prior = JSON.parse(await readFile(reportPath, 'utf8').catch(() => '{}'));
      prior.sourceSha = sourceSha; prior.runId = runId; prior.runAttempt = attempt;
      if (/No compatible verified Full image is available/u.test(bounded)) {
        prior.status = 'NOT_CHECKED';
        prior.states ||= {};
        prior.states.compatible_update = { status: 'NOT_CHECKED', detail: bounded };
      } else prior.status = 'FAIL';
      prior.failure = bounded; prior.updatedAt = new Date().toISOString();
      await writeFile(reportPath, JSON.stringify(prior, null, 2) + '\n', { mode: 0o600 });
    } catch {}
    console.error(bounded); process.exitCode = 1;
  });
}
