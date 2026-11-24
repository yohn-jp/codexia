import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFunctionalAcceptance, assertPairedObservation, digestEvidence } from './coordinator.mjs';

const sha = 'a'.repeat(40);
const hex = 'b'.repeat(64);
const digest = 'sha256:' + hex;
const image = 'ghcr.io/yohn-jp/codexia-backend@' + digest;
const frontend = { format: 'codexia-frontend-identity/v1', version: '1.0.0', sourceSha: sha, profile: 'full', apiEpoch: 2 };
const identity = { format: 'codexia-backend-identity/v1', platform: 'linux/amd64', migrationFingerprint: digest, persistenceFormat: 2, version: '1.0.0', sourceSha: sha, profile: 'full', apiEpoch: 2 };
const pinned = { image, identity, frontend, workerVersion: '123' };
const environment = {
  origin: 'https://fixture.example.com', hostId: hex, clusterId: '12345',
  ownerBindingSha256: digest, ingressDigest: digest,
};
const observedAt = '2026-11-23T12:00:00.000Z';
const now = new Date(observedAt);
const edge = {
  origin: environment.origin, observedAt, backend: { name: 'codexia', ...identity, auth: ['oauth-owner', 'oauth-mcp'] },
  frontend, deployment: { versionId: '123' }, ingressDigest: digest,
};
const host = {
  observedAt, hostId: hex, writer: { image, identity, authMode: 'better-auth', ownerBindingSha256: digest },
  database: { clusterId: '12345', migrationLedgerSha256: digest },
  tunnel: { unitState: 'active', containerRunning: true },
};

test('paired observation binds both live identities and the writer to the reviewed target', () => {
  assert.doesNotThrow(() => assertPairedObservation({ edge, host, pinned, environment, now }));
  for (const [badEdge, badHost] of [
    [{ ...edge, frontend: { ...frontend, sourceSha: 'c'.repeat(40) } }, host],
    [{ ...edge, backend: { ...identity, apiEpoch: 1 } }, host],
    [{ ...edge, observedAt: '2026-11-22T12:00:00.000Z' }, host],
    [edge, { ...host, database: { ...host.database, clusterId: '999' } }],
    [edge, { ...host, writer: { ...host.writer, ownerBindingSha256: null } }],
  ]) assert.throws(() => assertPairedObservation({ edge: badEdge, host: badHost, pinned, environment, now }));
});

test('acceptance rejects missing, stale and foreign protected evidence', () => {
  const expected = { planSha256: hex, outcome: 'candidate', origin: environment.origin, image, workerVersion: '123' };
  const checks = Object.fromEntries(['ownerLogin', 'passkey', 'oauth', 'manuscript', 'history', 'permissionDenial', 'accessBoundary'].map(key => [key, hex]));
  const evidence = {
    format: 'codexia-cutover-functional-acceptance/v1', ...expected, verifiedAt: observedAt, checks,
  };
  const options = { since: '2026-11-23T11:59:00.000Z', now };
  assert.doesNotThrow(() => assertFunctionalAcceptance(evidence, expected, options));
  assert.throws(() => assertFunctionalAcceptance({ ...evidence, workerVersion: '124' }, expected, options));
  assert.throws(() => assertFunctionalAcceptance({ ...evidence, checks: { ...checks, passkey: false } }, expected, options));
  assert.throws(() => assertFunctionalAcceptance(evidence, expected, { ...options, since: '2026-11-23T12:00:01.000Z' }));
  assert.equal(digestEvidence({ x: 1, y: { b: 2, a: 3 } }), digestEvidence({ y: { a: 3, b: 2 }, x: 1 }));
});
