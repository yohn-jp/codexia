import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import reportCases, { associateTraceCases } from './case-results.mjs';

test('reports actual Node case outcomes without treating skips or TODOs as passing', async () => {
  const file = path.resolve('scripts/strictdoc/verify.test.mjs');
  const events = [
    { type: 'test:pass', data: { file, name: 'exact pass', line: 4 } },
    { type: 'test:pass', data: { file, name: 'skipped', line: 7, skip: 'not applicable' } },
    { type: 'test:fail', data: { file, name: 'todo', line: 10, todo: true } },
    { type: 'test:fail', data: { file, name: 'failure', line: 12 } },
    { type: 'test:pass', data: { file, name: file, line: 1, details: { type: 'test' } } },
    { type: 'test:diagnostic', data: { file, name: 'not a result' } },
  ];
  const outcomes = [];
  for await (const line of reportCases(events)) outcomes.push(JSON.parse(line));
  assert.deepEqual(outcomes.map(({ name, result }) => [name, result]), [
    ['exact pass', 'PASSED'], ['skipped', 'SKIPPED'], ['todo', 'TODO'], ['failure', 'FAILED'],
  ]);
});

test('matches a TEST ID only to one execution of the exact case in its declared source range', () => {
  const makeScenario = (uid, name) => ({
    UID: uid,
    'Case name': name,
    RELATIONS: [{ TYPE: 'File', VALUE: 'scripts/check.test.mjs', LINE_RANGE: '5, 10' }],
  });
  const cases = ['pass', 'skip', 'duplicate', 'duplicate', 'wrong line', 'wrong file'].map((name, i) => ({
    name, file: i === 5 ? 'scripts/other.test.mjs' : 'scripts/check.test.mjs',
    line: i === 4 ? 11 : 8, result: i === 1 ? 'SKIPPED' : 'PASSED',
  }));
  const scenarios = ['pass', 'skip', 'duplicate', 'wrong line', 'wrong file', 'absent']
    .map((name, i) => makeScenario(`TEST-${i}`, name));
  assert.deepEqual(associateTraceCases(scenarios, cases).map(({ testId, result }) => [testId, result]), [
    ['TEST-0', 'PASSED'], ['TEST-1', 'SKIPPED'], ['TEST-2', 'AMBIGUOUS'],
    ['TEST-3', 'NOT_RUN'], ['TEST-4', 'NOT_RUN'], ['TEST-5', 'NOT_RUN'],
  ]);
});
