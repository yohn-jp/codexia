#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = /^[a-f0-9]{64}$/u;
const sourceSha = /^[a-f0-9]{40}$/u;
const imageId = /^sha256:[a-f0-9]{64}$/u;
const baseImage = /^docker\.io\/library\/debian@sha256:[a-f0-9]{64}$/u;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_ARCHIVE = 512 * 1024 * 1024;
const keys = ['schemaVersion', 'sourceSha', 'runId', 'runAttempt', 'platform',
  'image', 'imageId', 'baseImage', 'dockerfileSha256', 'entrypointSha256',
  'archiveSha256', 'archiveBytes'].sort();

export function assertFixtureManifest(manifest, { sha, runId, attempt }) {
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Missing fixture manifest');
  assert.deepEqual(Object.keys(manifest).sort(), keys, 'Unknown or missing fixture manifest fields');
  assert.equal(manifest.schemaVersion, 1);
  assert.match(sha ?? '', sourceSha, 'Invalid expected source SHA');
  assert.equal(manifest.sourceSha, sha, 'Fixture source SHA mismatch');
  assert.equal(manifest.runId, runId, 'Fixture run ID mismatch');
  assert.equal(manifest.runAttempt, attempt, 'Fixture attempt mismatch');
  assert.ok(Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(attempt) && attempt > 0);
  assert.equal(manifest.platform, 'linux/amd64', 'Unexpected fixture platform');
  assert.equal(manifest.image, `codexia-sshfs-fixture:ci-${sha}`, 'Fixture image tag mismatch');
  assert.match(manifest.imageId, imageId, 'Invalid producer image ID');
  assert.match(manifest.baseImage, baseImage, 'Unpinned fixture base image');
  for (const field of ['dockerfileSha256', 'entrypointSha256', 'archiveSha256'])
    assert.match(manifest[field], sha256, `Invalid fixture ${field}`);
  assert.ok(Number.isSafeInteger(manifest.archiveBytes) && manifest.archiveBytes > 0 &&
    manifest.archiveBytes <= MAX_ARCHIVE, 'Invalid fixture archive size');
  return manifest;
}

async function regularFile(filename) {
  const stat = await lstat(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Fixture inputs must be regular files');
  return stat;
}

async function fileHash(filename) {
  await regularFile(filename);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyFixtureArtifact(folder, identity, { root = ROOT } = {}) {
  const manifestPath = path.join(folder, 'manifest.json');
  const archive = path.join(folder, 'sshfs-fixture.tar');
  const manifest = assertFixtureManifest(JSON.parse(await readFile(manifestPath, 'utf8')), identity);
  await regularFile(manifestPath);
  const stat = await regularFile(archive);
  assert.equal(stat.size, manifest.archiveBytes, 'Fixture archive byte count mismatch');
  for (const [relative, field] of [
    ['deploy/fixtures/sshfs-server/Dockerfile', 'dockerfileSha256'],
    ['deploy/fixtures/sshfs-server/entrypoint.sh', 'entrypointSha256'],
  ]) assert.equal(await fileHash(path.join(root, relative)), manifest[field], 'Fixture source hash mismatch: ' + relative);
  assert.equal(await fileHash(archive), manifest.archiveSha256, 'Fixture archive checksum mismatch');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Usage: verify-sshfs-fixture-artifact.mjs DIR');
  const identity = { sha: process.env.CODEXIA_LIFECYCLE_SOURCE_SHA || process.env.GITHUB_SHA,
    runId: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT) };
  try {
    const manifest = await verifyFixtureArtifact(path.resolve(process.argv[2]), identity);
    console.log(`Verified exact-run SSHFS fixture ${manifest.image} (${manifest.imageId})`);
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
