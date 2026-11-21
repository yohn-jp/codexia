import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rotationCredentialDigest, matchesRotationCredential } from './rotation-credential-digest.mjs';

const first = '12345678-1234-4234-8234-123456789abc';
const second = '12345678-1234-4234-8234-123456789abd';

test('credential fingerprints use a unique operation salt and bounded scrypt', () => {
  const secret = 'a'.repeat(64);
  const fingerprint = rotationCredentialDigest(secret, first);
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.notEqual(fingerprint, rotationCredentialDigest(secret, second));
  assert.equal(matchesRotationCredential(secret, first, fingerprint), true);
  assert.equal(matchesRotationCredential('b'.repeat(64), first, fingerprint), false);
  assert.equal(matchesRotationCredential(secret, second, fingerprint), false);
});

test('legacy SHA-256 rotation markers are read for interrupted rollback only', () => {
  // SHA-256 of the fixed synthetic token, recorded by the pre-migration format.
  const expected = '1bc38c974d8fc6bd9ad9697f1c6414cc7a356f10b3f0ac43eceed3bfa060f5c6';
  const secret = 'legacy-synthetic-credential';
  assert.equal(matchesRotationCredential(secret, first, expected), true);
  assert.equal(matchesRotationCredential('invalid-credential', first, expected), false);
});

test('rejects malformed markers without accepting arbitrary digest formats', () => {
  assert.equal(matchesRotationCredential('credential', first, 'short'), false);
  assert.throws(() => rotationCredentialDigest('credential', '../out'), /operation ID/u);
});
