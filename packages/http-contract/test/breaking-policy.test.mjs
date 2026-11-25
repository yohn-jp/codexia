import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBreakingComparison, assertCandidateManifestEpoch, assertComparisonManifestEpoch } from '../scripts/breaking-policy.mjs';

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
