#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { readRegularFile } from '../../shared/read-regular-file.mjs';
import { assertReleaseIdentity, assertRemoteReleaseTag } from './policy.mjs';

const repository = 'yohn-jp/codexia';
const [owner, repo] = repository.split('/');
const binaryName = 'codexiactl-linux-amd64';
const checksumName = `${binaryName}.sha256`;

function requireReleaseAssets(release, tag, assets) {
  const correctRelease = release?.tag_name === tag && release?.immutable === true && release?.draft === false &&
    typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)) && Array.isArray(release.assets);
  const correctAssets = correctRelease && assets.every(expected => {
    const matches = release.assets.filter(asset => asset?.name === expected.name);
    return matches.length === 1 && matches[0].state === 'uploaded' &&
      matches[0].digest === expected.digest && matches[0].size === expected.size;
  });
  if (!correctAssets) {
    throw new Error('Release is mutable, incomplete, or does not match the verified artifacts. Use a new verified version tag.');
  }
}

export async function reconcileCodexiactlRelease({ tag, assets, readRelease, verifySource, verifyBuildProvenance,
  verifyReleaseAsset, createRelease }) {
  let release = await readRelease();
  const existing = release !== null;
  if (existing) requireReleaseAssets(release, tag, assets);
  await verifySource();
  await verifyBuildProvenance();
  if (!existing) {
    await createRelease();
    release = await readRelease();
    requireReleaseAssets(release, tag, assets);
    await verifySource();
  }
  for (const asset of assets) await verifyReleaseAsset(asset);
  return existing ? 'verified-existing' : 'published';
}

const httpSuffix = error => Number.isSafeInteger(error?.status) ? ` (HTTP ${error.status})` : '';

export async function readTaggedRelease(github, tag) {
  const matching = [];
  try {
    // The by-tag REST endpoint omits drafts. Inspect the complete authenticated inventory.
    for await (const { data } of github.paginate.iterator(github.rest.repos.listReleases, { owner, repo, per_page: 100 })) {
      if (!Array.isArray(data) || data.some(release => typeof release?.tag_name !== 'string')) {
        throw new Error('Unexpected Release API response');
      }
      matching.push(...data.filter(release => release.tag_name === tag));
    }
  } catch (error) {
    throw new Error(`Could not read the Release inventory${httpSuffix(error)}`);
  }
  if (matching.length > 1) throw new Error('Release inventory is ambiguous for the reviewed tag. Inspect the Release before retrying.');
  return matching[0] ?? null;
}

async function stagedAssets(directory) {
  const files = [binaryName, checksumName].map(name => ({ name, file: path.join(directory, name) }));
  const [binary, checksum] = await Promise.all(files.map(asset => readRegularFile(asset.file, { encoding: null })));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const binaryDigest = digest(binary);
  if (binary.length === 0 || !checksum.equals(Buffer.from(`${binaryDigest}  ${binaryName}\n`))) {
    throw new Error('Staged codexiactl binary and SHA-256 manifest do not match');
  }
  return [
    { ...files[0], size: binary.length, digest: `sha256:${binaryDigest}` },
    { ...files[1], size: checksum.length, digest: `sha256:${digest(checksum)}` },
  ];
}

function githubCLI(message, args) {
  const env = process.env;
  try {
    execFileSync('gh', [...args, '--repo', repository], {
      env: { ...env, GH_HOST: 'github.com' }, timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(message);
  }
}

async function main() {
  const env = process.env;
  const tag = env.GITHUB_REF_NAME;
  const sha = env.GITHUB_SHA;
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== `refs/tags/${tag}`) {
    throw new Error('CLI release is limited to the canonical repository tag publisher');
  }
  assertReleaseIdentity(tag, sha, sha);
  if (process.argv[2] !== 'reconcile' || !env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP)) {
    throw new Error('CLI release requires a trusted workflow artifact directory');
  }

  const github = createGitHubOctokit({ token: env.GH_TOKEN, repository, repositoryId: env.GITHUB_REPOSITORY_ID });
  const assets = await stagedAssets(path.join(env.RUNNER_TEMP, 'codexiactl-release'));
  const result = await reconcileCodexiactlRelease({
    tag,
    assets,
    readRelease: () => readTaggedRelease(github, tag),
    verifySource: async () => {
      try {
        await assertRemoteReleaseTag(github, { owner, repo, tag, sha });
      } catch (error) {
        throw new Error(`Could not verify the exact release tag source${httpSuffix(error)}`);
      }
    },
    verifyBuildProvenance: () => githubCLI('CLI build provenance verification failed', [
      'attestation', 'verify', assets[0].file, '--signer-workflow', `${repository}/.github/workflows/publish-codexiactl.yml`,
      '--source-ref', env.GITHUB_REF, '--source-digest', sha, '--deny-self-hosted-runners',
    ]),
    verifyReleaseAsset: asset => githubCLI(`Immutable Release attestation could not verify ${asset.name}`, [
      'release', 'verify-asset', tag, asset.file,
    ]),
    createRelease: () => githubCLI('Release creation was not confirmed. Inspect the tag and Release before retrying.', [
      'release', 'create', tag, ...assets.map(asset => asset.file),
      '--verify-tag', '--target', sha, '--generate-notes', '--title', tag,
    ]),
  });
  console.log(`${result === 'published' ? 'Published' : 'Verified existing'} CLI Release https://github.com/${repository}/releases/tag/${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'CLI Release verification failed');
    process.exitCode = 1;
  });
}
