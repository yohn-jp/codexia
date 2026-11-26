import assert from 'node:assert/strict';
import test from 'node:test';
import { approvedEpochTransition, assertBreakingComparison, assertCandidateManifestEpoch, assertComparisonManifestEpoch } from '../scripts/breaking-policy.mjs';

const spec = apiEpoch => ({ 'x-codexia-api-epoch': apiEpoch });
const manifest = apiEpoch => ({ apiEpoch, persistenceFormat: 2 });
const comparison = (baseEpoch, candidateEpoch) => ({
  baseSpec: spec(baseEpoch),
  baseUpdate: manifest(baseEpoch),
  baseFrontend: manifest(baseEpoch),
  candidateSpec: spec(candidateEpoch),
  candidateUpdate: manifest(candidateEpoch),
  candidateFrontend: manifest(candidateEpoch),
});

test('the comparison binds both specifications to their manifests and rejects epoch changes', () => {
  assert.equal(assertComparisonManifestEpoch(comparison(3, 3)), 3);
  assert.throws(() => assertComparisonManifestEpoch(comparison(2, 3)), /API epoch changed/u);
  assert.throws(
    () =>
      assertComparisonManifestEpoch({
        ...comparison(3, 3),
        baseFrontend: manifest(2),
      }),
    /differs from frontend/u,
  );
});

test('candidate manifest validation remains active before any approved base exists', () => {
  assert.equal(assertCandidateManifestEpoch(spec(3), manifest(3), manifest(3)), 3);
  assert.throws(() => assertCandidateManifestEpoch(spec(3), manifest(2), manifest(3)), /differs from backend/u);
});

test('OpenAPI comparison requires valid JSON, zero breaking issues and successful exit', () => {
  assert.doesNotThrow(() => assertBreakingComparison({ stdout: '[]', status: 0 }));
  assert.throws(() => assertBreakingComparison({ stdout: '[{"level":3}]', status: 1 }), /breaking changes/u);
  assert.throws(() => assertBreakingComparison({ stdout: '[]', status: 1 }), /oasdiff failed/u);
  assert.throws(() => assertBreakingComparison({ stdout: 'not json', status: 1 }), /JSON comparison output is invalid/u);
});


test('only the reviewed initial-install epoch transition permits scoped breaking changes', () => {
  const baseSha = 'ed11a58d1c92f749d67e2d0db2c3d251c0bc5c87';
  const transition = approvedEpochTransition(baseSha, 3, 4);
  assert.equal(assertComparisonManifestEpoch({ ...comparison(3, 4), baseSha }), 4);
  assert.equal(approvedEpochTransition('f'.repeat(40), 3, 4), undefined);
  assert.equal(approvedEpochTransition(baseSha, 4, 5), undefined);
  assert.throws(() => assertComparisonManifestEpoch({ ...comparison(3, 4), baseSha: 'f'.repeat(40) }), /API epoch changed/u);
  const issue = { level: 3, id: 'request-property-became-required', operation: 'DELETE', path: '/api/v1/persistence/projects/{projectId}/documents/{documentId}' };
  const check = (item, status = 1) => assertBreakingComparison({ stdout: JSON.stringify([item]), status, transition });
  assert.doesNotThrow(() => check(issue));
  assert.throws(() => check({ ...issue, path: '/api/auth/codexia/setup/complete' }), /outside approved/u);
  assert.throws(() => check({ ...issue, id: 'api-security-removed' }), /outside approved/u);
  assert.throws(() => check(issue, 2), /exit does not match/u);
  assert.throws(() => assertBreakingComparison({ stdout: JSON.stringify([issue]), status: 1 }), /breaking changes/u);
});
