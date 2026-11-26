import assert from 'node:assert/strict';

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

// The approved initial-install correction is bound to the reviewed base.
// Every later same-epoch comparison still requires zero breaking issues.
export function approvedEpochTransition(baseSha, baseEpoch, candidateEpoch) {
  if (baseSha === 'ed11a58d1c92f749d67e2d0db2c3d251c0bc5c87' && baseEpoch === 3 && candidateEpoch === 4) return { from: 3, to: 4 };
  return undefined;
}

export function assertComparisonManifestEpoch({
  baseSpec,
  candidateSpec,
  baseUpdate,
  baseFrontend,
  candidateUpdate,
  candidateFrontend,
  baseSha,
}) {
  const baseEpoch = validateManifestEpoch(baseSpec, baseUpdate, baseFrontend, 'Approved base');
  const candidateEpoch = validateManifestEpoch(candidateSpec, candidateUpdate, candidateFrontend, 'Candidate');

  if (candidateEpoch !== baseEpoch) {
    assert.ok(
      approvedEpochTransition(baseSha, baseEpoch, candidateEpoch),
      'API epoch changed without an approved OpenAPI compatibility policy',
    );
  }
  return candidateEpoch;
}

export function assertBreakingComparison({ stdout, status, transition }) {
  let issues;
  try {
    issues = JSON.parse(stdout);
  } catch (error) {
    throw new Error('oasdiff JSON comparison output is invalid', { cause: error });
  }
  assert.ok(Array.isArray(issues), 'oasdiff JSON comparison output must be an array');
  const errors = issues.filter(issue => issue?.level === 3 || issue?.level === 'ERR');

  if (transition) {
    assert.deepEqual(transition, { from: 3, to: 4 });
    const outside = errors.filter(issue => {
      const path = issue?.path ?? '';
      const id = issue?.id ?? '';
      // Limit approval to persistence wire constraints and MCP POST responses.
      if (/^\/api\/v1\/persistence(?:\/|$)/u.test(path)) {
        return !/^(?:request-(?:body|property|parameter|header|additional-properties)|new-required-request-property|response-property-pattern|response-property-format|response-property-max|response-property-min)/u.test(
          id,
        );
      }
      return !(
        issue.operation === 'POST' &&
        (path === '/mcp' || path === '/api/projects/{projectId}/modules/mcp/streamable') &&
        /^response-(?:body|property|schema|header)/u.test(id)
      );
    });
    assert.equal(outside.length, 0, `oasdiff reported breaking changes outside approved epoch transition: ${JSON.stringify(outside)}`);
    assert.equal(status, errors.length ? 1 : 0, 'oasdiff exit does not match reported ERR issues');
    return;
  }
  assert.equal(errors.length, 0, `oasdiff reported breaking changes: ${JSON.stringify(errors)}`);
  assert.equal(status, 0, 'oasdiff failed despite reporting no ERR issues');
}
