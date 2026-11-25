import assert from 'node:assert/strict';
import test from 'node:test';
import transition from '../../../scripts/deployment/cutover/migrations/mcp-v2-api-2-to-3.mjs';
import { assertBreakingComparison, assertCandidateManifestEpoch, assertEpochTransitionEvidence } from '../scripts/breaking-policy.mjs';

const baseAuth = { mode: 'better-auth', schemas: ['sha256:1', 'sha256:2'] };
const api = (epoch, persistenceFormat = 2) => ({ apiEpoch: epoch, persistenceFormat });
const front = apiEpoch => ({ apiEpoch });
const spec = apiEpoch => ({ 'x-codexia-api-epoch': apiEpoch });
const base = { baseSpec: spec(2), baseUpdate: api(2), baseFrontend: front(2), baseAuth };
const candidate = { candidateSpec: spec(3), candidateUpdate: api(3), candidateFrontend: front(3), candidateAuth: baseAuth };

const expectedBreakages = [
  { id: 'response-success-status-removed', method: 'GET', operationId: 'mcp_root_get', path: '/mcp' },
  { id: 'response-success-status-removed', method: 'DELETE', operationId: 'mcp_root_delete', path: '/mcp' },
  {
    id: 'response-success-status-removed',
    method: 'GET',
    operationId: 'project_mcp_stream_get',
    path: '/api/projects/{projectId}/modules/mcp/streamable',
  },
  {
    id: 'response-success-status-removed',
    method: 'DELETE',
    operationId: 'project_mcp_stream_delete',
    path: '/api/projects/{projectId}/modules/mcp/streamable',
  },
];
const issue = item => ({ ...item, text: 'removed the success response with the status `200`', operation: item.method, level: 3 });

test('only the registered 2-to-3 MCP API transition is accepted with persistence and auth unchanged', () => {
  assert.deepEqual(
    assertEpochTransitionEvidence({
      ...base,
      ...candidate,
      transition,
      baseMigrationFingerprint: 'sha256:1',
      candidateMigrationFingerprint: 'sha256:1',
    }),
    { changed: true, baseEpoch: 2, candidateEpoch: 3 },
  );
  assert.throws(
    () => assertEpochTransitionEvidence({ ...base, ...candidate, candidateUpdate: api(3, 3), transition }),
    /persistence format/u,
  );
  assert.throws(
    () => assertEpochTransitionEvidence({ ...base, ...candidate, candidateAuth: { ...baseAuth, mode: 'other-auth' }, transition }),
    /preserve authentication/u,
  );
  assert.throws(
    () =>
      assertEpochTransitionEvidence({
        ...base,
        ...candidate,
        transition,
        baseMigrationFingerprint: 'sha256:1',
        candidateMigrationFingerprint: 'sha256:2',
      }),
    /SQL migration identity/u,
  );
  assert.throws(
    () =>
      assertEpochTransitionEvidence({
        ...base,
        ...candidate,
        candidateFrontend: front(2),
        transition,
        baseMigrationFingerprint: 'sha256:1',
        candidateMigrationFingerprint: 'sha256:1',
      }),
    /differs from frontend/u,
  );
  assert.throws(
    () =>
      assertEpochTransitionEvidence({
        ...base,
        ...candidate,
        candidateSpec: spec(4),
        candidateUpdate: api(4),
        candidateFrontend: front(4),
        transition,
      }),
    /target/u,
  );
  assert.throws(
    () =>
      assertEpochTransitionEvidence({
        ...base,
        ...candidate,
        transition: { ...transition, id: 'other-transition' },
        baseMigrationFingerprint: 'sha256:1',
        candidateMigrationFingerprint: 'sha256:1',
      }),
    /without the registered MCP/u,
  );
  assert.throws(
    () =>
      assertEpochTransitionEvidence({
        ...base,
        ...candidate,
        baseUpdate: api(4),
        baseFrontend: front(4),
        baseSpec: spec(4),
        transition,
        baseMigrationFingerprint: 'sha256:1',
        candidateMigrationFingerprint: 'sha256:1',
      }),
    /source/u,
  );
});

test('candidate manifest validation remains active before any approved base exists', () => {
  assert.equal(assertCandidateManifestEpoch(spec(3), api(3), front(3)), 3);
  assert.throws(() => assertCandidateManifestEpoch(spec(3), api(2), front(3)), /differs from backend/u);
});

test('same-epoch comparison keeps the ordinary zero-ERR policy', () => {
  const result = assertEpochTransitionEvidence({
    ...base,
    candidateSpec: spec(2),
    candidateUpdate: api(2),
    candidateFrontend: front(2),
    candidateAuth: baseAuth,
    transition,
  });
  assert.equal(result.changed, false);
  assert.doesNotThrow(() => assertBreakingComparison({ stdout: '[]', status: 0, epochChanged: false }));
  assert.throws(
    () => assertBreakingComparison({ stdout: JSON.stringify([issue(expectedBreakages[0])]), status: 1, epochChanged: false }),
    /breaking changes/u,
  );
});

test('epoch change accepts exactly the four documented MCP method 200 removals', () => {
  const issues = expectedBreakages.map(issue).concat([{ level: 2, id: 'request-parameter-removed' }]);
  assert.doesNotThrow(() => assertBreakingComparison({ stdout: JSON.stringify(issues), status: 1, epochChanged: true }));
  for (const mutated of [
    [...issues, issue({ id: 'other', method: 'POST', operationId: 'unknown', path: '/api/other' })],
    issues.slice(1),
    [...issues.slice(0, 3), issue({ ...expectedBreakages[3], path: '/wrong' })],
  ])
    assert.throws(
      () => assertBreakingComparison({ stdout: JSON.stringify(mutated), status: 1, epochChanged: true }),
      /exactly the four documented/u,
    );
  assert.throws(() => assertBreakingComparison({ stdout: JSON.stringify(issues), status: 0, epochChanged: true }), /return failure/u);
  const wrongStatusCode = [...expectedBreakages.map(issue)];
  wrongStatusCode[0] = { ...wrongStatusCode[0], text: 'removed the success response with the status `204`' };
  assert.throws(
    () => assertBreakingComparison({ stdout: JSON.stringify(wrongStatusCode), status: 1, epochChanged: true }),
    /exactly the four documented/u,
  );
  assert.throws(
    () => assertBreakingComparison({ stdout: 'not json', status: 1, epochChanged: true }),
    /JSON comparison output is invalid/u,
  );
});
