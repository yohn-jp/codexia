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

export function assertComparisonManifestEpoch({ baseSpec, candidateSpec, baseUpdate, baseFrontend, candidateUpdate, candidateFrontend }) {
  const baseEpoch = validateManifestEpoch(baseSpec, baseUpdate, baseFrontend, 'Approved base');
  const candidateEpoch = validateManifestEpoch(candidateSpec, candidateUpdate, candidateFrontend, 'Candidate');

  assert.equal(candidateEpoch, baseEpoch, 'API epoch changed without an approved OpenAPI compatibility policy');
  return candidateEpoch;
}

export function assertBreakingComparison({ stdout, status }) {
  let issues;
  try {
    issues = JSON.parse(stdout);
  } catch (error) {
    throw new Error('oasdiff JSON comparison output is invalid', { cause: error });
  }
  assert.ok(Array.isArray(issues), 'oasdiff JSON comparison output must be an array');
  const errors = issues.filter(issue => issue?.level === 3 || issue?.level === 'ERR');

  assert.equal(errors.length, 0, `oasdiff reported breaking changes: ${JSON.stringify(errors)}`);
  assert.equal(status, 0, 'oasdiff failed despite reporting no ERR issues');
}
