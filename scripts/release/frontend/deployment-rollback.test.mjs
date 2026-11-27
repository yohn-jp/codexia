import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSingleDeployment, selectRollback } from './deployment-rollback.mjs';

const previous = { deploymentId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  versionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };
const candidate = { deploymentId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  versionId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' };
const expectedTag = 'frontend-' + 'e'.repeat(64);

test('frontend rollback accepts only a version proven to belong to this exact archive', () => {
  assert.equal(selectRollback(previous, candidate, expectedTag, expectedTag), 'rollback');
  assert.throws(() => selectRollback(previous, candidate, 'frontend-' + 'f'.repeat(64), expectedTag),
    /different Worker version/u);
  assert.equal(selectRollback(previous, previous, null, expectedTag), 'unchanged');
});

test('frontend rollback refuses ambiguous traffic, missing identities, and external changes', () => {
  assert.deepEqual(assertSingleDeployment({
    id: candidate.deploymentId, strategy: 'percentage',
    versions: [{ version_id: candidate.versionId, percentage: 100 }],
  }), candidate);
  assert.throws(() => assertSingleDeployment({
    id: candidate.deploymentId, strategy: 'percentage',
    versions: [{ version_id: candidate.versionId, percentage: 50 },
      { version_id: previous.versionId, percentage: 50 }],
  }), /one pinned version/u);
  assert.throws(() => selectRollback(previous,
    { ...candidate, versionId: previous.versionId }, expectedTag, expectedTag), /without a new version/u);
});
