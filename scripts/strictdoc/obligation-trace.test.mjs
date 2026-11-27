import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { buildObligationTrace } from './obligation-trace.mjs';

const requirement = { UID: 'REQ-API-002', 'Test IDs': 'TEST-API-001' };
const scenario = { UID: 'TEST-API-001', RELATIONS: [{ TYPE: 'Parent', VALUE: 'REQ-API-002' }] };
const obligation = {
  UID: 'OBL-REQ-API-002-O01',
  MID: createHash('sha256').update('OBL-REQ-API-002-O01', 'utf8').digest('hex').slice(0, 32),
  STATEMENT: '競合時に成功として扱わない',
  'Design reference': 'docs/architecture/API-CONTRACT.md#optimistic-concurrency',
  'Surface identifiers': 'httpOperation=PATCH /api/v1/persistence/projects/{projectId}/documents/{documentId}',
  'Test IDs': 'TEST-API-001',
  'Implementation identifiers': 'API-PERSIST-007',
  'Exact-run reference': 'NOT_RUN',
  RELATIONS: [
    { TYPE: 'Parent', VALUE: 'REQ-API-002' },
    { TYPE: 'File', VALUE: 'packages/api/src/persistence-routes.ts' },
  ],
};
const candidate = {
  testId: 'TEST-API-001', url: 'https://github.com/yohn-jp/codexia/actions/runs/12345',
  repository: 'yohn-jp/codexia', sourceSha: 'a'.repeat(40), runId: '12345', attempt: 1,
  job: 'verify-strictdoc', task: 'requirements-trace', result: 'PASS',
};

test('projects explicit obligation links and retains missing trace stages as gaps', () => {
  const result = buildObligationTrace({ requirements: [requirement], obligations: [obligation], scenarios: [scenario] });
  assert.deepEqual(result.violations, []);
  assert.equal(result.rows[0].requirementId, 'REQ-API-002');
  assert.equal(result.rows[0].sourceRefs[0].path, 'packages/api/src/persistence-routes.ts');
  assert.deepEqual(result.rows[0].implementationIdentifiers, ['API-PERSIST-007']);
  assert.deepEqual(result.rows[0].surfaceIdentifiers, [{ kind: 'httpOperation', id: 'PATCH /api/v1/persistence/projects/{projectId}/documents/{documentId}' }]);
  assert.equal(result.rows[0].status, 'MAPPED_UNVERIFIED');
  assert.match(result.gaps.join('\n'), /no exact-source run evidence/);
});

test('accepts an explicit CI workflow surface identifier without implying execution', () => {
  const result = buildObligationTrace({
    requirements: [requirement], scenarios: [scenario], obligations: [{
      ...obligation, 'Surface identifiers': 'ciWorkflow=.github/workflows/verify.yml',
    }],
  });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.rows[0].surfaceIdentifiers, [{ kind: 'ciWorkflow', id: '.github/workflows/verify.yml' }]);
  assert.deepEqual(result.rows[0].exactRuns, []);
});

test('retains requirement-level implementation declarations without changing conformance', () => {
  const result = buildObligationTrace({
    requirements: [{ ...requirement, 'Conformance status': 'UNMAPPED', 'Implementation identifiers': 'XState actor 未導入; transition registry', Comment: '目標・未実装' }],
    scenarios: [scenario], obligations: [obligation],
  });
  assert.equal(result.rows[0].conformanceStatus, 'UNMAPPED');
  assert.deepEqual(result.rows[0].requirementImplementationIdentifiers, ['XState actor 未導入', 'transition registry']);
  assert.equal(result.rows[0].requirementComment, '目標・未実装');
});

test('attaches exact-source candidate data without certifying conformance', () => {
  const result = buildObligationTrace({
    requirements: [requirement], obligations: [obligation], scenarios: [scenario], runEvidence: [candidate],
    expectedRepository: 'yohn-jp/codexia', expectedSourceSha: 'a'.repeat(40),
  });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.rows[0].exactRuns, [candidate]);
  assert.equal(result.rows[0].status, 'MAPPED_UNVERIFIED');
});

test('fault injection rejects duplicate obligation IDs and dangling TEST IDs', () => {
  const broken = { ...obligation, 'Test IDs': 'TEST-API-999' };
  const result = buildObligationTrace({
    requirements: [requirement], obligations: [obligation, broken], scenarios: [scenario],
  });
  assert.match(result.violations.join('\n'), /Duplicate obligation UID/);
  assert.match(result.violations.join('\n'), /refers to missing TEST-ID TEST-API-999/);
});

test('fault injection rejects malformed exact-source evidence and unsafe source paths', () => {
  const result = buildObligationTrace({
    requirements: [requirement], obligations: [{
      ...obligation,
      'Exact-run reference': 'https://github.com/foreign/repo/actions/runs/1',
      RELATIONS: [
        { TYPE: 'Parent', VALUE: 'REQ-API-002' },
        { TYPE: 'File', VALUE: '../outside.ts' },
      ],
    }], scenarios: [scenario], repositoryRoot: '/repo',
    runEvidence: [{ ...candidate, repository: 'attacker/repo' }], expectedRepository: 'yohn-jp/codexia',
    expectedSourceSha: 'a'.repeat(40),
  });
  assert.match(result.violations.join('\n'), /incomplete or invalid exact-source run evidence/);
  assert.match(result.violations.join('\n'), /repository-relative/);
  assert.match(result.violations.join('\n'), /authored Exact-run reference/);
});

test('fault injection rejects stale, foreign, duplicated, and unrelated run evidence', () => {
  const result = buildObligationTrace({
    requirements: [requirement], obligations: [obligation], scenarios: [scenario],
    runEvidence: [candidate, candidate, { ...candidate, testId: 'TEST-API-404' }, { ...candidate, sourceSha: 'b'.repeat(40) }],
    expectedRepository: 'yohn-jp/codexia', expectedSourceSha: 'a'.repeat(40),
  });
  const violations = result.violations.join('\n');
  assert.match(violations, /Duplicate exact-source run evidence/);
  assert.match(violations, /unknown TEST-ID TEST-API-404/);
  assert.match(violations, /incomplete or invalid exact-source run evidence/);
});

test('[TEST-TRC-06-001] passing observed UI case cannot promote an explicitly unimplemented requirement', () => {
  const unimplemented = {
    ...requirement, UID: 'REQ-UI-006', 'Test IDs': 'TEST-UI-006-001',
    'Conformance status': 'UNMAPPED', Applicability: 'FUTURE_TARGET',
    'Implementation identifiers': 'state machine未導入',
  };
  const uiScenario = {
    ...scenario, UID: 'TEST-UI-006-001',
    RELATIONS: [{ TYPE: 'Parent', VALUE: 'REQ-UI-006' }],
  };
  const uiObligation = {
    ...obligation, UID: 'OBL-REQ-UI-006-O01',
    MID: createHash('sha256').update('OBL-REQ-UI-006-O01', 'utf8').digest('hex').slice(0, 32),
    'Test IDs': 'TEST-UI-006-001',
    RELATIONS: [{ TYPE: 'Parent', VALUE: 'REQ-UI-006' }, { TYPE: 'File', VALUE: 'app/src/state.test.ts' }],
  };
  const result = buildObligationTrace({
    requirements: [unimplemented], obligations: [uiObligation], scenarios: [uiScenario],
    runEvidence: [{ ...candidate, testId: 'TEST-UI-006-001' }],
    expectedRepository: 'yohn-jp/codexia', expectedSourceSha: 'a'.repeat(40),
  });
  assert.deepEqual(result.violations, []);
  assert.equal(result.rows[0].exactRuns.length, 1);
  assert.equal(result.rows[0].status, 'MAPPED_UNVERIFIED');
  assert.equal(result.rows[0].conformanceStatus, 'UNMAPPED');
  assert.deepEqual(result.rows[0].requirementImplementationIdentifiers, ['state machine未導入']);
});

test('reports missing exact-source evidence for each TEST-ID even when another case passed', () => {
  const missing = { ...scenario, UID: 'TEST-API-002' };
  const result = buildObligationTrace({
    requirements: [{ ...requirement, 'Test IDs': 'TEST-API-001 TEST-API-002' }],
    obligations: [{ ...obligation, 'Test IDs': 'TEST-API-001 TEST-API-002' }],
    scenarios: [scenario, missing], runEvidence: [candidate],
    expectedRepository: 'yohn-jp/codexia', expectedSourceSha: 'a'.repeat(40),
  });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.rows[0].exactRuns, [candidate]);
  assert.deepEqual(result.gaps, ['OBL-REQ-API-002-O01: no exact-source run evidence for TEST-API-002']);
  assert.equal(result.rows[0].status, 'MAPPED_UNVERIFIED');
});
