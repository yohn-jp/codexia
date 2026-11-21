import assert from 'node:assert/strict';
import { createHash, scryptSync, timingSafeEqual } from 'node:crypto';

// Durable updater rotation markers use a per-operation UUID as the KDF salt.
// This is a fingerprint for state/rollback verification, not a login password hash.
// The SHA-256 read path is temporarily required for already persisted v1 markers;
// new captures are always salted scrypt fingerprints, pending updater retirement (#430).
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const digestFormat = /^[a-f0-9]{64}$/u;
const cost = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

export function rotationCredentialDigest(secret, operationId) {
  assert.ok(typeof secret === 'string' && Buffer.byteLength(secret) <= 8192,
    'Rotation credential must be bounded private text');
  assert.match(operationId, uuid, 'Invalid rotation operation ID');
  return scryptSync(secret, 'codexia-rotation-credential/v2:' + operationId, 32, cost).toString('hex');
}

export function matchesRotationCredential(secret, operationId, expectedDigest) {
  if (typeof expectedDigest !== 'string' || !digestFormat.test(expectedDigest)) return false;
  assert.ok(typeof secret === 'string' && Buffer.byteLength(secret) <= 8192,
    'Rotation credential must be bounded private text');
  assert.match(operationId, uuid, 'Invalid rotation operation ID');
  const expected = Buffer.from(expectedDigest, 'hex');
  // Read-only legacy compatibility: existing on-disk v1 rotation markers
  // contain unsalted SHA-256. Do not issue any new markers using that scheme.
  const legacy = createHash('sha256').update(secret).digest();
  if (timingSafeEqual(legacy, expected)) return true;
  return timingSafeEqual(Buffer.from(rotationCredentialDigest(secret, operationId), 'hex'), expected);
}
