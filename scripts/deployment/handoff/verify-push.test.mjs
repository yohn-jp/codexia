import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { REQUIRED_VERIFICATION_JOBS } from '../../ci/impact/contract.mjs';
import * as handoff from './verify-push.mjs';
import {
  assertTrustedBackendPublicationRun,
  createHandoffDeploymentOutputs,
  selectPushDeploymentCertificateArtifact,
  validatePushDeploymentCertificatePair,
  verifyBackendPushHandoff,
} from './verify-push.mjs';

const sha = char => char.repeat(40);
const digest = char => `sha256:${char.repeat(64)}`;
const mainSha = sha('a'), mainTree = sha('b'), sourceSha = sha('c');
const buildRun = () => ({ id: 100, run_attempt: 2, path: '.github/workflows/backend-release.yml', event: 'workflow_run',
  run_number: 773, head_branch: 'main', head_sha: mainSha, status: 'completed', conclusion: 'success',
  repository: { full_name: 'yohn-jp/codexia' }, head_repository: { full_name: 'yohn-jp/codexia' } });
const receipt = () => ({ format: 'codexia-backend-build/v1', event: 'workflow_run', sourceSha, version: '0.1.3',
  workflowRunId: 101, workflowRunNumber: 4, sourceTree: mainTree, artifacts: {
    core: { id: 201, digest: digest('d'), producerAttempt: 1, archiveSha256: 'e'.repeat(64) },
    full: { id: 202, digest: digest('e'), producerAttempt: 1, archiveSha256: 'f'.repeat(64) },
  } });
const cert = profile => ({ format: 'codexia-backend-deployment-certificate/v1', verifiedMainSha: mainSha, verifiedMainTree: mainTree,
  verifyRun: { event: 'push', branch: 'main', conclusion: 'success', repository: 'yohn-jp/codexia', headSha: mainSha, id: 90, attempt: 1 },
  producer: { event: 'workflow_run', sourceSha, sourceTree: mainTree, runId: 101, attempt: 1, artifactId: profile === 'core' ? 201 : 202,
    artifactDigest: digest(profile === 'core' ? 'd' : 'e'), receipt: receipt() },
  image: `ghcr.io/yohn-jp/codexia-backend@${digest(profile === 'core' ? 'f' : '9')}`,
  identity: { format: 'codexia-backend-identity/v1', version: '0.1.3', sourceSha, profile, platform: 'linux/amd64',
    migrationFingerprint: digest('a'), persistenceFormat: 1, apiEpoch: 1 } });
const artifact = (run = buildRun()) => ({ id: 303, name: `codexia-backend-deployment-certificate-${mainSha}-run-${run.id}-attempt-${run.run_attempt}`,
  digest: digest('1'), size_in_bytes: 500, expired: false,
  workflow_run: { id: run.id, head_sha: run.head_sha } });
const publicationSteps = conclusion => [
  { name: 'Require complete exact-source main verification', status: 'completed', conclusion: 'success' },
  ...[
    'Publish commit-addressed image',
    'Record independent backend release',
    'Create certified Core and Full push handoff',
    'Run actions/upload-artifact@v7.0.2',
  ].map(name => ({ name, status: 'completed', conclusion })),
];

test('accepts only the completed successful main backend publisher run with exact repository and source', () => {
  assert.equal(assertTrustedBackendPublicationRun(buildRun(), { id: 100, attempt: 2, runNumber: 773, headSha: mainSha }).id, 100);
  for (const patch of [
    { path: '.github/workflows/other.yml' }, { event: 'pull_request' }, { head_branch: 'feature' },
    { status: 'in_progress' }, { conclusion: 'failure' }, { repository: { full_name: 'fork/codexia' } },
    { head_repository: { full_name: 'fork/codexia' } }, { head_sha: sha('9') }, { run_attempt: 1 },
  ]) assert.throws(() => assertTrustedBackendPublicationRun({ ...buildRun(), ...patch }, { id: 100, attempt: 2, runNumber: 773, headSha: mainSha }));
});

test('rejects a verified publisher run whose run number differs from its workflow_run event', () => {
  const publisher = { ...buildRun(), id: 44907163228, run_number: 41 };
  assert.throws(() => assertTrustedBackendPublicationRun(publisher, {
    id: 44907163228, attempt: 2, runNumber: 773, headSha: mainSha,
  }), /Backend publication run number mismatch/u);
});

test('passes the verified backend publisher run identity instead of the handoff run identity', () => {
  const publisher = { ...buildRun(), id: 44907163228, run_number: 773 };
  const trusted = assertTrustedBackendPublicationRun(publisher, {
    id: 44907163228, attempt: 2, runNumber: 773, headSha: mainSha,
  });
  assert.equal(typeof handoff.backendReleaseValidationEnvironment, 'function');
  assert.deepEqual(handoff.backendReleaseValidationEnvironment({
    GITHUB_RUN_ID: '44907575858', GITHUB_RUN_NUMBER: '41',
  }, trusted), {
    GITHUB_RUN_ID: '44907163228', GITHUB_RUN_NUMBER: '773',
  });
});

test('selects the single unexpired digest-bound certificate artifact for the exact publisher run attempt', () => {
  assert.equal(selectPushDeploymentCertificateArtifact([artifact()], buildRun()).id, 303);
  for (const bad of [
    { ...artifact(), expired: true }, { ...artifact(), digest: 'mutable' }, { ...artifact(), workflow_run: { id: 999, head_sha: mainSha } },
    { ...artifact(), name: 'codexia-backend-deployment-certificate-stale' },
  ]) assert.throws(() => selectPushDeploymentCertificateArtifact([bad], buildRun()));
  assert.throws(() => selectPushDeploymentCertificateArtifact([artifact(), artifact()], buildRun()), /one/);
});

test('binds promotion artifact name to its source SHA and workflow association to publication head SHA', () => {
  const publicationRun = { ...buildRun(), head_sha: mainSha };
  const promotedSourceSha = sourceSha;
  const promotedArtifact = {
    ...artifact(publicationRun),
    name: `codexia-backend-deployment-certificate-${promotedSourceSha}-run-${publicationRun.id}-attempt-${publicationRun.run_attempt}`,
  };
  assert.equal(selectPushDeploymentCertificateArtifact([promotedArtifact], publicationRun, { sourceSha: promotedSourceSha }).id, 303);
  assert.equal(selectPushDeploymentCertificateArtifact([promotedArtifact], publicationRun).id, 303);
  assert.throws(() => selectPushDeploymentCertificateArtifact([promotedArtifact], publicationRun, { sourceSha: mainSha }), /source/u);
  assert.throws(() => selectPushDeploymentCertificateArtifact([promotedArtifact, artifact(publicationRun)], publicationRun), /one/u);
  assert.throws(() => selectPushDeploymentCertificateArtifact([
    { ...promotedArtifact, workflow_run: { ...promotedArtifact.workflow_run, head_sha: promotedSourceSha } },
  ], publicationRun, { sourceSha: promotedSourceSha }), /workflow head/u);
});

test('requires both independently certified profiles from the same verified producer and compatible release', () => {
  const [core, full] = validatePushDeploymentCertificatePair([cert('core'), cert('full')], mainSha);
  assert.equal(core.identity.profile, 'core');
  assert.equal(full.identity.profile, 'full');
  assert.throws(() => validatePushDeploymentCertificatePair([cert('core')], mainSha), /Core and Full/);
  assert.throws(() => validatePushDeploymentCertificatePair([cert('core'), cert('core')], mainSha), /one certificate/);
  assert.throws(() => validatePushDeploymentCertificatePair([cert('core'), { ...cert('full'), verifiedMainSha: sha('9') }], mainSha));
  assert.throws(() => validatePushDeploymentCertificatePair([cert('core'), { ...cert('full'), producer: { ...cert('full').producer, attempt: 2 } }], mainSha));
});

test('exposes only a validated Full digest and certificate as bounded job outputs', () => {
  const [, full] = validatePushDeploymentCertificatePair([cert('core'), cert('full')], mainSha);
  const outputs = createHandoffDeploymentOutputs({
    fullImage: full.image,
    producerSha: full.producer.sourceSha,
    fullCertificate: full,
  });
  assert.equal(outputs.fullImage, full.image);
  assert.equal(outputs.producerSha, sourceSha);
  assert.equal(outputs.fullApiEpoch, '1');
  assert.equal(outputs.verifiedMainSha, mainSha);
  assert.deepEqual(JSON.parse(Buffer.from(outputs.fullCertificate, 'base64').toString('utf8')), full);
  assert.throws(() => createHandoffDeploymentOutputs({
    fullImage: `ghcr.io/yohn-jp/codexia-backend@${digest('1')}`,
    producerSha: full.producer.sourceSha,
    fullCertificate: full,
  }));
});

test('handoff validates the certified ancestor and its own Verify run in a historical publication', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codexia-handoff-history-'));
  const caller = process.cwd();
  t.after(async () => {
    process.chdir(caller);
    await rm(root, { recursive: true, force: true });
  });
  const repository = path.join(root, 'repo');
  const assets = path.join(root, 'certificates');
  await mkdir(repository);
  await mkdir(assets);
  const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Handoff Test');
  git('config', 'user.email', 'handoff@example.invalid');
  const commit = async (file, content) => {
    await mkdir(path.dirname(path.join(repository, file)), { recursive: true });
    await writeFile(path.join(repository, file), content);
    git('add', '--', file);
    git('commit', '-qm', file);
    return git('rev-parse', 'HEAD');
  };
  const certifiedSha = await commit('README.md', 'certified revision');
  const certifiedTree = git('rev-parse', 'HEAD^{tree}');
  const workflowSha = await commit('docs/notes.md', 'unrelated documentation change');
  for (const profile of ['core', 'full']) {
    const value = cert(profile);
    value.verifiedMainSha = certifiedSha;
    value.verifiedMainTree = certifiedTree;
    value.verifyRun.headSha = certifiedSha;
    value.producer.sourceTree = certifiedTree;
    value.producer.receipt.sourceTree = certifiedTree;
    await writeFile(path.join(assets, profile + '.json'), JSON.stringify(value));
  }
  execFileSync('zip', ['-q', 'certificates.zip', 'core.json', 'full.json'], { cwd: assets });
  const bytes = await readFile(path.join(assets, 'certificates.zip'));
  const publisher = { name: 'Publish immutable GHCR image', status: 'completed', conclusion: 'success',
    steps: publicationSteps('success') };
  const jobs = [
    { name: 'Resolve verified backend promotion', status: 'completed', conclusion: 'success' },
    { name: 'Build and test backend OCI image (core)', status: 'completed', conclusion: 'success' },
    { name: 'Build and test backend OCI image (full)', status: 'completed', conclusion: 'success' },
    publisher,
  ];
  const verify = { ...buildRun(), id: 90, run_attempt: 1, path: '.github/workflows/verify.yml',
    event: 'push', head_sha: certifiedSha };
  const env = { GITHUB_REPOSITORY: 'yohn-jp/codexia', GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_REF: 'refs/heads/main', CODEXIA_PUBLISHER_RUN_ID: '100', GH_TOKEN: 'fixture-read', RUNNER_TEMP: root };
  const run = async (head, verifySha, verifyJobs = []) => {
    const publicationRun = { ...buildRun(), head_sha: head };
    const artifactMetadata = {
      ...artifact(publicationRun),
      name: `codexia-backend-deployment-certificate-${certifiedSha}-run-100-attempt-2`,
      digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      size_in_bytes: bytes.length,
    };
    const fetchImpl = async input => {
      const url = new URL(input);
      if (url.hostname === 'artifact.example.invalid') return new Response(bytes);
      switch (url.pathname) {
        case '/repos/yohn-jp/codexia/actions/runs/100':
          return Response.json(publicationRun);
        case '/repos/yohn-jp/codexia/actions/runs/100/jobs':
          return Response.json({ total_count: jobs.length, jobs });
        case '/repos/yohn-jp/codexia/actions/runs/100/artifacts':
          return Response.json({ total_count: 1, artifacts: [artifactMetadata] });
        case '/repos/yohn-jp/codexia/actions/artifacts/303/zip':
          return new Response(null, { status: 302, headers: { location: 'https://artifact.example.invalid/certificates.zip' } });
        case '/repos/yohn-jp/codexia/actions/runs/90':
          return Response.json({ ...verify, head_sha: verifySha });
        case '/repos/yohn-jp/codexia/actions/runs/90/jobs':
          return Response.json({ total_count: verifyJobs.length, jobs: verifyJobs });
        default:
          assert.fail('Unexpected external I/O: ' + url.pathname);
      }
    };
    return verifyBackendPushHandoff({ env, payload: { workflow_run: publicationRun }, fetchImpl });
  };

  process.chdir(repository);
  await assert.rejects(run(workflowSha, workflowSha), /Certificate Verify source SHA mismatch/u);
  await assert.rejects(run(workflowSha, certifiedSha), /exact required job set/u);
  const completedJobs = REQUIRED_VERIFICATION_JOBS.map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const tag = 'backend-v' + cert('full').identity.version;
  t.mock.method(globalThis, 'fetch', async input => {
    const path = decodeURIComponent(new URL(input).pathname);
    if (path === '/repos/yohn-jp/codexia/releases/tags/' + tag) {
      return Response.json({ message: 'Not Found' }, { status: 404 });
    }
    assert.equal(path, '/repos/yohn-jp/codexia/git/ref/tags/' + tag);
    return Response.json({ ref: 'refs/tags/' + tag, object: { type: 'commit', sha: certifiedSha } });
  });
  await assert.rejects(run(workflowSha, certifiedSha, completedJobs), { status: 404 });
  const changed = await commit('packages/api/src/server.ts', 'newer backend change');
  await assert.rejects(run(changed, certifiedSha), /newer backend change superseded/u);
});

test('a successful freshness gate that skipped every publication step emits no deployment handoff', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codexia-no-backend-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'output');
  await writeFile(output, '');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const run = { ...buildRun(), head_sha: head };
  const env = { GITHUB_REPOSITORY: 'yohn-jp/codexia', GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_REF: 'refs/heads/main', CODEXIA_PUBLISHER_RUN_ID: '100', GH_TOKEN: 'fixture-read',
    RUNNER_TEMP: root, GITHUB_OUTPUT: output };
  const invoke = async (steps, artifacts = [], conclusion = 'success') => verifyBackendPushHandoff({
    env,
    payload: { workflow_run: run },
    fetchImpl: async input => {
      switch (new URL(input).pathname) {
        case '/repos/yohn-jp/codexia/actions/runs/100':
          return Response.json(run);
        case '/repos/yohn-jp/codexia/actions/runs/100/jobs':
          return Response.json({ total_count: 1, jobs: [{
            name: 'Publish immutable GHCR image', status: 'completed', conclusion, steps,
          }] });
        case '/repos/yohn-jp/codexia/actions/runs/100/artifacts':
          return Response.json({ total_count: artifacts.length, artifacts });
        default:
          assert.fail('A skipped publication must not read artifacts or release records');
      }
    },
  });
  const skipped = publicationSteps('skipped');
  const previousCertificate = { ...artifact({ ...run, run_attempt: 1 }), id: 204 };
  const priorBuildArchive = { id: 205, name: `codexia-backend-image-${head}-core-attempt-1` };
  assert.deepEqual(await invoke(skipped, [previousCertificate, priorBuildArchive]), {
    skipped: true,
    publisherRunId: 100,
  });
  assert.equal(await readFile(output, 'utf8'), '');
  await assert.rejects(invoke(skipped, [artifact(run)]), /cannot emit a deployment certificate/u);
  await assert.rejects(invoke(skipped.map(step => step.name === 'Publish commit-addressed image'
    ? { ...step, conclusion: 'success' } : step)), /Incomplete deployment publication/u);
  await assert.rejects(invoke(skipped.slice(1)), /freshness gate/u);
  await assert.rejects(invoke(skipped, [], 'failure'), /publication job failed/u);
  assert.equal(await readFile(output, 'utf8'), '');
});
