import assert from 'node:assert/strict';

export const MCP_API_EPOCH_TRANSITION_ID = 'mcp-v2-api-2-to-3';

const expectedMcpBreakages = Object.freeze([
  {
    id: 'response-success-status-removed',
    text: 'removed the success response with the status `200`',
    method: 'GET',
    operationId: 'mcp_root_get',
    path: '/mcp',
  },
  {
    id: 'response-success-status-removed',
    text: 'removed the success response with the status `200`',
    method: 'DELETE',
    operationId: 'mcp_root_delete',
    path: '/mcp',
  },
  {
    id: 'response-success-status-removed',
    text: 'removed the success response with the status `200`',
    method: 'GET',
    operationId: 'project_mcp_stream_get',
    path: '/api/projects/{projectId}/modules/mcp/streamable',
  },
  {
    id: 'response-success-status-removed',
    text: 'removed the success response with the status `200`',
    method: 'DELETE',
    operationId: 'project_mcp_stream_delete',
    path: '/api/projects/{projectId}/modules/mcp/streamable',
  },
]);

function positiveEpoch(value, label) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `${label} is missing a positive API epoch`);
  return value;
}

export function assertCandidateManifestEpoch(spec, update, frontend) {
  return validateManifestEpoch(spec, update, frontend, 'Candidate');
}

function validateManifestEpoch(spec, update, frontend, label) {
  const epoch = positiveEpoch(spec['x-codexia-api-epoch'], `${label} OpenAPI`);
  assert.equal(
    epoch,
    positiveEpoch(update.apiEpoch, `${label} backend compatibility manifest`),
    `${label} OpenAPI epoch differs from backend manifest`,
  );
  assert.equal(
    epoch,
    positiveEpoch(frontend.apiEpoch, `${label} frontend compatibility manifest`),
    `${label} OpenAPI epoch differs from frontend manifest`,
  );
  assert.equal(update.apiEpoch, frontend.apiEpoch, `${label} backend and frontend API epochs differ`);
  assert.ok(Number.isSafeInteger(update.persistenceFormat) && update.persistenceFormat > 0, `${label} persistence format is invalid`);
  return epoch;
}

export function assertEpochTransitionEvidence({
  baseSpec,
  candidateSpec,
  baseUpdate,
  baseFrontend,
  candidateUpdate,
  candidateFrontend,
  transition,
  baseAuth,
  candidateAuth,
  baseMigrationFingerprint,
  candidateMigrationFingerprint,
}) {
  const baseEpoch = validateManifestEpoch(baseSpec, baseUpdate, baseFrontend, 'Approved base');
  const candidateEpoch = validateManifestEpoch(candidateSpec, candidateUpdate, candidateFrontend, 'Candidate');

  if (baseEpoch === candidateEpoch) return { changed: false, baseEpoch, candidateEpoch };

  assert.equal(transition?.id, MCP_API_EPOCH_TRANSITION_ID, 'API epoch changed without the registered MCP v2 transition');
  assert.deepEqual(
    transition.source,
    { apiEpoch: 2, persistenceFormat: 2 },
    'Registered MCP transition source is not the documented epoch 2 contract',
  );
  assert.deepEqual(
    transition.target,
    { apiEpoch: 3, persistenceFormat: 2 },
    'Registered MCP transition target is not the documented epoch 3 contract',
  );
  assert.deepEqual(transition.requiredAxes, ['api-epoch'], 'Registered MCP transition must change only the API epoch');
  assert.deepEqual(transition.optionalAxes, [], 'Registered MCP transition does not allow optional compatibility changes');
  assert.equal(transition.handler, null, 'Registered MCP transition must not convert persisted data');
  assert.equal(baseEpoch, transition.source.apiEpoch, 'Approved base API epoch does not match the registered transition source');
  assert.equal(candidateEpoch, transition.target.apiEpoch, 'Candidate API epoch does not match the registered transition target');
  assert.equal(
    baseUpdate.persistenceFormat,
    transition.source.persistenceFormat,
    'Approved base persistence format does not match the registered transition source',
  );
  assert.equal(
    candidateUpdate.persistenceFormat,
    transition.target.persistenceFormat,
    'Candidate persistence format does not match the registered transition target',
  );
  assert.equal(
    candidateUpdate.persistenceFormat,
    baseUpdate.persistenceFormat,
    'MCP API epoch transition must preserve persistence format',
  );
  assert.deepEqual(candidateAuth, baseAuth, 'MCP API epoch transition must preserve authentication mode and schema');
  assert.equal(
    candidateMigrationFingerprint,
    baseMigrationFingerprint,
    'MCP API epoch transition must preserve the deployed SQL migration identity',
  );
  return { changed: true, baseEpoch, candidateEpoch };
}

export function assertBreakingComparison({ stdout, status, epochChanged }) {
  let issues;
  try {
    issues = JSON.parse(stdout);
  } catch (error) {
    throw new Error('oasdiff JSON comparison output is invalid', { cause: error });
  }
  assert.ok(Array.isArray(issues), 'oasdiff JSON comparison output must be an array');
  const errors = issues.filter(issue => issue?.level === 3 || issue?.level === 'ERR');

  if (!epochChanged) {
    assert.equal(errors.length, 0, `oasdiff reported breaking changes: ${JSON.stringify(errors)}`);
    assert.equal(status, 0, 'oasdiff failed despite reporting no ERR issues');
    return;
  }

  const actual = errors
    .map(({ id, text, operation, operationId, path }) => ({ id, text, method: operation, operationId, path }))
    .sort((left, right) => `${left.path} ${left.method}`.localeCompare(`${right.path} ${right.method}`));
  const expected = [...expectedMcpBreakages].sort((left, right) =>
    `${left.path} ${left.method}`.localeCompare(`${right.path} ${right.method}`),
  );
  assert.deepEqual(actual, expected, 'MCP API epoch transition must have exactly the four documented method 200 removals as ERR');
  assert.equal(status, 1, 'oasdiff must return failure for the four documented breaking response removals');
}
