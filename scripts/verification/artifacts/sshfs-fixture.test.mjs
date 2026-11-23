import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertFixtureManifest, verifyFixtureArtifact } from './sshfs-fixture.mjs';

const sourceSha = 'a'.repeat(40);
const identity = { sha: sourceSha, runId: 42, attempt: 1 };
const hash = data => createHash('sha256').update(data).digest('hex');

test('only a complete exact-run, digest-bound prebuilt fixture is accepted', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sshfs-fixture-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'artifact');
  const sources = path.join(root, 'deploy/fixtures/sshfs-server');
  await mkdir(sources, { recursive: true });
  await mkdir(dir);
  const dockerfile = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n';
  const entrypoint = '#!/bin/sh\nexit 0\n';
  const archive = Buffer.from('sample OCI archive bytes');
  await writeFile(path.join(sources, 'Dockerfile'), dockerfile);
  await writeFile(path.join(sources, 'entrypoint.sh'), entrypoint);
  await writeFile(path.join(dir, 'sshfs-fixture.tar'), archive);
  const manifest = { schemaVersion: 1, sourceSha, runId: 42, runAttempt: 1,
    platform: 'linux/amd64', image: `codexia-sshfs-fixture:ci-${sourceSha}`,
    imageId: `sha256:${'b'.repeat(64)}`, baseImage: `docker.io/library/debian@sha256:${'c'.repeat(64)}`,
    dockerfileSha256: hash(dockerfile), entrypointSha256: hash(entrypoint),
    archiveSha256: hash(archive), archiveBytes: archive.length };
  const manifestPath = path.join(dir, 'manifest.json');
  const save = async value => writeFile(manifestPath, JSON.stringify(value));
  await save(manifest);
  assert.deepEqual(await verifyFixtureArtifact(dir, identity, { root }), manifest);
  assert.throws(() => assertFixtureManifest({ ...manifest, runId: 123 }, identity), /run ID mismatch/);
  assert.throws(() => assertFixtureManifest({ ...manifest, unexpected: 1 }, identity), /manifest fields/);
  assert.throws(() => assertFixtureManifest({ ...manifest, image: 'latest' }, identity), /image tag mismatch/);
  assert.throws(() => assertFixtureManifest({ ...manifest, baseImage: 'debian:stable-slim' }, identity), /Unpinned/);
  await save({ ...manifest, archiveSha256: 'd'.repeat(64) });
  await assert.rejects(verifyFixtureArtifact(dir, identity, { root }), /checksum mismatch/);
  await save(manifest);
  await writeFile(path.join(dir, 'sshfs-fixture.tar'), Buffer.from('altered'));
  await assert.rejects(verifyFixtureArtifact(dir, identity, { root }), /byte count mismatch/);
  await rm(path.join(dir, 'sshfs-fixture.tar'));
  await symlink(path.join(sources, 'Dockerfile'), path.join(dir, 'sshfs-fixture.tar'));
  await assert.rejects(verifyFixtureArtifact(dir, identity, { root }), /regular files/);
});
