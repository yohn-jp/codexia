import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCompatibleUpdate, validateUpdateRelease } from './update-release-policy.mjs';

const hash = character => `sha256:${character.repeat(64)}`;
const image = character => `ghcr.io/yohn-jp/codexia-backend@${hash(character)}`;
const installed = {
  format: 'codexia-update-release/v1', channel: 'stable', state: 'published',
  version: '0.1.0', sourceSha: 'a'.repeat(40), image: image('a'), platform: 'linux/amd64',
  profile: 'core', migrationFingerprint: hash('c'), persistenceFormat: 1, apiEpoch: 1,
};
const candidate = { ...installed, version: '0.1.1', sourceSha: 'b'.repeat(40), image: image('b') };

test('valid metadata returns an isolated immutable record', () => {
  const release = validateUpdateRelease(candidate);
  assert.deepEqual(release, candidate);
  assert.notEqual(release, candidate);
  assert.ok(Object.isFrozen(release));
});

test('rejects malformed, extra, missing or non-stable metadata', () => {
  const { apiEpoch, ...missing } = candidate;
  for (const value of [null, [], missing, { ...candidate, unexpected: true },
    ...[
      { format: 'codexia-update-release/v2' }, { channel: 'preview' }, { state: 'draft' },
      { version: 'v0.1.1' }, { version: '0.1.01' }, { version: '0.1.1-rc.1' },
      { version: '0.1.1+build' }, { version: '9007199254740992.1.1' },
      { sourceSha: 'main' }, { image: 'ghcr.io/yohn-jp/codexia-backend:latest' },
      { image: `ghcr.io/another/codexia-backend@${hash('b')}` },
      { image: [candidate.image] }, { platform: 'linux/arm64' }, { profile: 'unknown' },
      { migrationFingerprint: 'unknown' }, { persistenceFormat: 0 }, { apiEpoch: '1' },
    ].map(change => ({ ...candidate, ...change })),
  ]) assert.throws(() => validateUpdateRelease(value));
});

test('permits patch updates for 0.x and numeric minor/patch advances within stable majors', () => {
  assert.deepEqual(assertCompatibleUpdate(installed, candidate, 1), candidate);
  for (const [from, to] of [['1.9.9', '1.10.0'], ['1.2.9', '1.2.10'], ['0.1.9', '0.1.10']]) {
    assert.doesNotThrow(() => assertCompatibleUpdate({ ...installed, version: from }, { ...candidate, version: to }, 1));
  }
});

test('rejects downgrade, replay, breaking version, withdrawal and changed immutable identity', () => {
  for (const change of [
    { version: '0.1.0' }, { version: '0.0.9' }, { version: '0.2.0' }, { version: '1.0.0' },
    { state: 'withdrawn' }, { image: installed.image }, { sourceSha: installed.sourceSha },
  ]) assert.throws(() => assertCompatibleUpdate(installed, { ...candidate, ...change }, 1));
  assert.throws(() => assertCompatibleUpdate({ ...installed, version: '1.10.0' }, { ...candidate, version: '1.9.99' }, 1));
});

test('rejects schema, persistence, profile and frontend/API incompatibility', () => {
  for (const change of [
    { migrationFingerprint: hash('d') }, { persistenceFormat: 2 }, { apiEpoch: 2 }, { profile: 'full' },
  ]) assert.throws(() => assertCompatibleUpdate(installed, { ...candidate, ...change }, 1));
  assert.throws(() => assertCompatibleUpdate(installed, candidate, 2));
  assert.throws(() => assertCompatibleUpdate(installed, candidate, undefined));
  assert.throws(() => assertCompatibleUpdate({ ...installed, apiEpoch: 2 }, candidate, 1));
});
