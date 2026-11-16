import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseFromIdentity } from './publish-stable-channel.mjs';
import { assertVerificationJobs, collectGitHubPages, verifiedSourceRun } from './release-policy.mjs';
import { assertCompatibleUpdate, validateUpdateRelease } from './update-release-policy.mjs';
import { selectUpdateCandidate, signUpdateChannel, verifyUpdateChannel } from './update-channel.mjs';
import { validateBackendIdentity } from './backend-update-identity.mjs';

const REPOSITORY = 'yohn-jp/codexia';
const compatibility = JSON.parse(await readFile(new URL('../deploy/update-compatibility.json', import.meta.url), 'utf8'));
const digestImage = /^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u;
const records = [
  {
    tag: 'backend-v0.1.236', version: '0.1.236', sourceSha: 'bd8d4820b7b466de8990f96405c3d207a7d98b42',
    core: 'ghcr.io/yohn-jp/codexia-backend@sha256:24d6ff850a67bdf53fff008d0d3a08693d5b1c407959f9db6c86ab71423bad19',
    full: 'ghcr.io/yohn-jp/codexia-backend@sha256:2cc76a3f9497d1ddfd035f3be8e05818a2851454a0bfb671cb6b2dbdfcd7b36d',
  },
  {
    tag: 'backend-v0.1.245', version: '0.1.245', sourceSha: '51c843382d740679020e6de9fc1fbd487fd022d3',
    core: 'ghcr.io/yohn-jp/codexia-backend@sha256:e48b5d650eb8f80a79e863fed0ee6ed6e6a3f7922ae67b98edb25e9ac8f62a79',
    full: 'ghcr.io/yohn-jp/codexia-backend@sha256:64aa555bce0c22f680e7b717678b161e2f5ed503bcc454ba01d37e74ea340f50',
  },
  {
    tag: 'backend-v0.1.254', version: '0.1.254', sourceSha: '5eb1fc14f8344b7d8e8ecc87626b637041465fcf',
    core: 'ghcr.io/yohn-jp/codexia-backend@sha256:387c5952dae671c73d0147fee7faa47d98dfa11de68759078910dd621c83acbc',
    full: 'ghcr.io/yohn-jp/codexia-backend@sha256:0140e204470757e048ebe4130ca3ae80a156724d497b5904099ac9884694280f',
  },
];

const fingerprintProbe = 'import { packagedMigrationFingerprint } from "@codexia/api"; console.log(await packagedMigrationFingerprint());';

function parseFencedMetadata(body) {
  assert.equal(typeof body, 'string', 'Published release metadata is unavailable');
  const matches = [...body.matchAll(/```json\s*\n([\s\S]*?)\n```/gu)];
  assert.equal(matches.length, 1, 'Expected exactly one certified release metadata block');
  return JSON.parse(matches[0][1]);
}

/** Parse the published release record; image identity is bound separately from the pulled artifact. */
export function parseComponentRelease(apiRelease, expectedVersion, expectedSourceSha, expectedCoreImage, expectedFullImage, expectedCompatibility = compatibility) {
  assert.equal(apiRelease?.tag_name, 'backend-v' + expectedVersion, 'Unexpected backend release tag');
  assert.equal(apiRelease?.draft, false, 'Backend release must be published');
  assert.equal(apiRelease?.prerelease, false, 'Backend release must not be a prerelease');
  assert.match(expectedSourceSha, /^[a-f0-9]{40}$/u);
  assert.match(expectedCoreImage, digestImage);
  assert.match(expectedFullImage, digestImage);
  const metadata = parseFencedMetadata(apiRelease.body);
  assert.deepEqual(Object.keys(metadata).sort(), ['component', 'images', 'persistenceFormat', 'providedApiEpoch', 'sourceSha', 'version']);
  assert.equal(metadata.component, 'backend');
  assert.equal(metadata.version, expectedVersion, 'Backend release version differs from its certified record');
  assert.equal(metadata.sourceSha, expectedSourceSha, 'Backend release source differs from its certified record');
  assert.equal(metadata.providedApiEpoch, expectedCompatibility.apiEpoch, 'Backend release API epoch differs from this host contract');
  assert.equal(metadata.persistenceFormat, expectedCompatibility.persistenceFormat, 'Backend release persistence format differs from this host contract');
  assert.deepEqual(Object.keys(metadata.images).sort(), ['core', 'full']);
  assert.equal(metadata.images.core, expectedCoreImage, 'Published release digest differs from the fixed certified input');
  assert.equal(metadata.images.full, expectedFullImage, 'Published Full image digest differs from the fixed certified input');
  return metadata;
}

/** Bind the published record to the artifact-derived identity using the production publisher helper. */
export function bindCertifiedImage(identityValue, metadata, image, expectedCompatibility = compatibility) {
  const identity = validateBackendIdentity(identityValue);
  assert.equal(metadata.images.core, image);
  assert.equal(metadata.sourceSha, identity.sourceSha);
  assert.equal(metadata.version, identity.version);
  assert.equal(metadata.providedApiEpoch, identity.apiEpoch);
  assert.equal(metadata.persistenceFormat, identity.persistenceFormat);
  return releaseFromIdentity(identity, image, metadata.sourceSha, metadata.version, expectedCompatibility, 'core');
}

/** Generate two signed test snapshots; the private key exists only in memory in this CI process. */
export function createSignedTestChannels(releaseValues, { now = Date.now() } = {}) {
  assert.equal(releaseValues.length, 3, 'Three certified identities are required for update, rollback, and interrupted-update coverage');
  const releases = releaseValues.map(validateUpdateRelease);
  assert.equal(new Set(releases.map(value => value.image)).size, releases.length, 'Fixture releases must use distinct immutable images');
  assertCompatibleUpdate(releases[0], releases[1], releases[0].apiEpoch);
  assertCompatibleUpdate(releases[1], releases[2], releases[1].apiEpoch);
  const pair = generateKeyPairSync('ed25519');
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const snapshot = (sequence, selected) => ({
    format: 'codexia-update-channel/v1', sequence,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 11 * 60 * 60 * 1000).toISOString(),
    releases: selected,
  });
  const firstEnvelope = signUpdateChannel(snapshot(1, releases.slice(0, 2)), privateKeyPem, now);
  const first = verifyUpdateChannel(firstEnvelope, publicKeyPem, null, now);
  assert.equal(selectUpdateCandidate(first, releases[0], releases[0].apiEpoch).image, releases[1].image);
  const secondEnvelope = signUpdateChannel(snapshot(2, releases), privateKeyPem, now);
  const second = verifyUpdateChannel(secondEnvelope, publicKeyPem, first.checkpoint, now);
  assert.equal(selectUpdateCandidate(second, releases[1], releases[1].apiEpoch).image, releases[2].image);
  return {
    publicKeyPem,
    releases,
    first: { envelope: firstEnvelope, verified: first, candidate: releases[1] },
    second: { envelope: secondEnvelope, verified: second, candidate: releases[2] },
  };
}

async function githubJson(resource, token) {
  const response = await fetch('https://api.github.com/repos/' + REPOSITORY + '/' + resource, {
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('Read-only release provenance lookup failed (HTTP ' + response.status + ')');
  return response.json();
}

async function githubPages(resource, key, token) {
  const separator = resource.includes('?') ? '&' : '?';
  return collectGitHubPages(async (page, perPage) => githubJson(resource + separator + 'per_page=' + perPage + '&page=' + page, token), key);
}

async function verifySourceCertification(record, releaseApiRecord, token) {
  const tagRef = await githubJson('git/ref/tags/' + encodeURIComponent(record.tag), token);
  assert.equal(tagRef?.object?.type, 'commit', 'Certified backend tag must directly name its source commit');
  assert.equal(tagRef.object.sha, record.sourceSha, 'Certified backend tag/source mismatch');
  const runs = await githubPages('actions/workflows/verify.yml/runs?head_sha=' + record.sourceSha + '&branch=main&event=push&status=success', 'workflow_runs', token);
  const sourceRun = verifiedSourceRun(runs, record.sourceSha);
  const sourceJobs = await githubPages('actions/runs/' + sourceRun.id + '/jobs?filter=latest', 'jobs', token);
  assertVerificationJobs(sourceJobs);
  const backendRuns = await githubPages('actions/workflows/backend-release.yml/runs?head_sha=' + record.sourceSha + '&branch=main&event=push&status=completed', 'workflow_runs', token);
  const backendRun = backendRuns.find(run => run?.head_sha === record.sourceSha && run?.head_branch === 'main' &&
    run?.event === 'push' && run?.status === 'completed' && run?.conclusion === 'success');
  assert.ok(backendRun, 'Source has no successful main backend release workflow');
  const backendJobs = await githubPages('actions/runs/' + backendRun.id + '/jobs?filter=latest', 'jobs', token);
  for (const name of [
    'Build and test backend OCI image (core)',
    'Build and test backend OCI image (full)',
    'Publish immutable GHCR image',
  ]) {
    const matches = backendJobs.filter(job => job?.name === name);
    assert.equal(matches.length, 1, 'Expected one certified backend workflow job: ' + name);
    assert.equal(matches[0].status, 'completed', 'Backend job was not completed: ' + name);
    assert.equal(matches[0].conclusion, 'success', 'Backend job did not pass: ' + name);
  }
  if (releaseApiRecord.created_at && backendRun.updated_at) {
    assert.ok(Date.parse(releaseApiRecord.created_at) <= Date.parse(backendRun.updated_at), 'Backend release record was created after its successful publication workflow completed');
  }
  return { verificationRunId: sourceRun.id, backendReleaseRunId: backendRun.id };
}

function podmanJson(args) {
  return execFileSync('podman', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function verifyPulledImage(record) {
  execFileSync('podman', ['pull', '--arch', 'amd64', '--quiet', record.core], { stdio: 'inherit', timeout: 300_000 });
  const image = JSON.parse(podmanJson(['image', 'inspect', record.core]))[0];
  assert.ok(image.RepoDigests?.includes(record.core), 'Pulled backend image does not bind the exact certified digest');
  assert.equal(image.Os + '/' + image.Architecture, 'linux/amd64');
  const revision = image.Labels?.['org.opencontainers.image.revision'] ?? image.Config?.Labels?.['org.opencontainers.image.revision'];
  assert.equal(revision, record.sourceSha, 'OCI revision label differs from the certified source');
  const identity = JSON.parse(podmanJson(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'all',
    '--security-opt', 'no-new-privileges', '--entrypoint', 'cat', record.core, '/app/update-identity.json']));
  assert.equal(identity.sourceSha, record.sourceSha);
  assert.equal(identity.version, record.version);
  assert.equal(identity.profile, 'core');
  assert.equal(identity.platform, 'linux/amd64');
  assert.equal(identity.apiEpoch, compatibility.apiEpoch);
  assert.equal(identity.persistenceFormat, compatibility.persistenceFormat);
  const fingerprint = podmanJson(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'all',
    '--security-opt', 'no-new-privileges', '--entrypoint', 'node', record.core,
    '--input-type=module', '-e', fingerprintProbe]);
  assert.equal(fingerprint, identity.migrationFingerprint, 'Packaged migration fingerprint differs from the embedded identity');
  return identity;
}

async function main() {
  const args = process.argv.slice(2);
  assert.equal(args[0], '--out', 'Usage: phase-f-test-channel.mjs --out /absolute/output/directory');
  assert.ok(path.isAbsolute(args[1]), 'Output path must be absolute');
  const out = args[1];
  await mkdir(out, { recursive: true, mode: 0o755 });
  const token = process.env.GH_TOKEN;
  assert.ok(token, 'Actions read-only token required to verify source certification');
  const verifiedRecords = [];
  for (const record of records) {
    const apiRelease = await githubJson('releases/tags/' + encodeURIComponent(record.tag), token);
    const metadata = parseComponentRelease(apiRelease, record.version, record.sourceSha, record.core, record.full, compatibility);
    const certification = await verifySourceCertification(record, apiRelease, token);
    verifiedRecords.push({ record, metadata, certification });
  }
  // Do not pass the read-only Actions token to Podman or any image process.
  delete process.env.GH_TOKEN;
  const identities = [];
  const releases = [];
  for (const { record, metadata, certification } of verifiedRecords) {
    const identity = verifyPulledImage(record);
    const release = bindCertifiedImage(identity, metadata, record.core, compatibility);
    releases.push(release);
    identities.push({ ...record, metadata, identity, certification, release });
    await writeFile(path.join(out, 'release-' + record.version + '.json'), JSON.stringify(release, null, 2) + '\n', { mode: 0o644 });
  }
  const channels = createSignedTestChannels(releases);
  await writeFile(path.join(out, 'test-channel-public.pem'), channels.publicKeyPem, { mode: 0o644 });
  await writeFile(path.join(out, 'channel-sequence-1.json'), JSON.stringify(channels.first.envelope) + '\n', { mode: 0o644 });
  await writeFile(path.join(out, 'channel-sequence-2.json'), JSON.stringify(channels.second.envelope) + '\n', { mode: 0o644 });
  const frontendIdentity = {
    format: 'codexia-frontend-identity/v1', version: releases[0].version, sourceSha: releases[0].sourceSha,
    profile: releases[0].profile, apiEpoch: releases[0].apiEpoch,
  };
  await writeFile(path.join(out, 'simulated-frontend-identity.json'), JSON.stringify(frontendIdentity) + '\n', { mode: 0o644 });
  await writeFile(path.join(out, 'release-identities.json'), JSON.stringify({
    format: 'codexia-phase-f-release-identity-evidence/v1',
    source: 'Published backend release records; exact release tag, successful main verification/backend-release jobs, immutable GHCR digest, OCI revision label, embedded identity, and packaged migration fingerprint checked in this workflow.',
    channelSigning: 'Fresh ephemeral Ed25519 test key; mechanics only, not production publisher authority.',
    releases: identities,
  }, null, 2) + '\n', { mode: 0o644 });
  console.log('Verified three published Core release images and generated two ephemeral-key signed test channel sequences.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Phase F disposable channel preparation failed');
    process.exitCode = 1;
  });
}
