import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { selectUpdateCandidate, signUpdateChannel, verifyUpdateChannel } from './update-channel.mjs';

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { public: publicKey.export({ type: 'spki', format: 'pem' }), private: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
};
const key = pair();
const now = Date.parse('2026-11-12T12:00:00.000Z');
const digest = c => `sha256:${c.repeat(64)}`;
const installed = { format: 'codexia-update-release/v1', channel: 'stable', state: 'published', version: '0.1.0', sourceSha: 'a'.repeat(40), image: `ghcr.io/yohn-jp/codexia-backend@${digest('a')}`, platform: 'linux/amd64', profile: 'core', migrationFingerprint: digest('c'), persistenceFormat: 1, apiEpoch: 1 };
const release = (version, char, extra = {}) => ({ ...installed, version, sourceSha: char.repeat(40), image: `ghcr.io/yohn-jp/codexia-backend@${digest(char)}`, ...extra });
const payload = (sequence = 1, releases = [release('0.1.1', 'b')], extra = {}) => ({ format: 'codexia-update-channel/v1', sequence, issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString(), releases, ...extra });
const signed = value => signUpdateChannel(value, key.private, now);
const verified = (value, previous = null) => verifyUpdateChannel(signed(value), key.public, previous, now);

test('signed stable channel selects the newest numeric version for the installed profile', () => {
  const value = verified(payload(1, [release('0.1.9', 'b'), release('0.1.10', 'd'), release('0.1.11', 'e', { state: 'withdrawn' }), release('0.2.0', 'f', { profile: 'full' })]));
  assert.equal(selectUpdateCandidate(value, installed, 1).version, '0.1.10');
  assert.equal(selectUpdateCandidate(verified(payload(1, [installed])), installed, 1), null);
  assert.ok(Object.isFrozen(value.payload.releases));
  assert.throws(() => selectUpdateCandidate({ ...value }, installed, 1), /authenticated/);
});

test('rejects tampered bytes, wrong key, malformed signature and envelope', () => {
  const envelope = signed(payload());
  assert.throws(() => verifyUpdateChannel(envelope, pair().public, null, now), /signature/);
  assert.throws(() => verifyUpdateChannel({ ...envelope, payload: Buffer.from(JSON.stringify(payload(2))).toString('base64') }, key.public, null, now), /signature/);
  assert.throws(() => verifyUpdateChannel({ ...envelope, signature: 'AAAA' }, key.public, null, now), /signature/);
  assert.throws(() => verifyUpdateChannel({ ...envelope, extra: true }, key.public, null, now), /envelope/);
  assert.throws(() => verifyUpdateChannel({ ...envelope, payload: 'A'.repeat(1500000) }, key.public, null, now), /encoding/);
});

test('freshness is checked at verification time and invalid validity windows are rejected', () => {
  const envelope = signed(payload());
  assert.throws(() => verifyUpdateChannel(envelope, key.public, null, now + 60000), /expired/);
  assert.throws(() => signed(payload(1, [], { issuedAt: new Date(now + 1000).toISOString() })), /validity/);
  assert.throws(() => signed(payload(1, [], { expiresAt: new Date(now + 86400000).toISOString() })), /validity/);
  assert.throws(() => signed(payload(1, [], { issuedAt: '2026-02-30T00:00:00.000Z' })), /timestamp/);
});

test('checkpoint rejects rollback and equivocation but permits identical polls and forward revisions', () => {
  const current = verified(payload(2));
  assert.deepEqual(verified(payload(2), current.checkpoint).checkpoint, current.checkpoint);
  assert.throws(() => verified(payload(1), current.checkpoint), /rollback/);
  assert.throws(() => verified(payload(2, [release('0.1.2', 'd')]), current.checkpoint), /equivocation/);
  assert.equal(verified(payload(3), current.checkpoint).checkpoint.sequence, 3);
  assert.throws(() => verified(payload(3), { sequence: 2, sha256: 'invalid' }), /checkpoint/);
});

test('rejects duplicate version, image, source or malformed release entries', () => {
  const a = release('0.1.1', 'b');
  assert.throws(() => signed(payload(1, [a, release('0.1.1', 'd')])), /Duplicate/);
  assert.throws(() => signed(payload(1, [a, { ...release('0.1.2', 'd'), image: a.image }])), /Duplicate/);
  assert.throws(() => signed(payload(1, [a, { ...release('0.1.2', 'd'), sourceSha: a.sourceSha }])), /Duplicate/);
  assert.throws(() => signed(payload(1, [{ ...a, image: 'latest' }])), /immutable/);
});

test('incompatible newest release is blocked rather than silently selecting an older version', () => {
  const value = verified(payload(1, [release('0.1.1', 'b'), release('0.1.2', 'd', { migrationFingerprint: digest('e') })]));
  assert.throws(() => selectUpdateCandidate(value, installed, 1), /migration/);
});
