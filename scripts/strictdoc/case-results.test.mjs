import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import reportCases, { associateTraceCases } from './case-results.mjs';

test('reports actual Node case outcomes without treating skips or TODOs as passing', async () => {
  const file = path.resolve('scripts/strictdoc/verify.test.mjs');
  const events = [
    { type: 'test:pass', data: { file, name: 'exact pass', line: 4, details: { type: 'test' } } },
    { type: 'test:pass', data: { file, name: 'skipped', line: 7, details: { type: 'test' }, skip: 'not applicable' } },
    { type: 'test:fail', data: { file, name: 'todo', line: 10, details: { type: 'test' }, todo: true } },
    { type: 'test:fail', data: { file, name: 'failure', line: 12, details: { type: 'test' } } },
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

test('preserves declared test source details when execution is absent or ambiguous', () => {
  const scenarios = [
    { UID: 'TEST-ABSENT-001', 'Case name': 'not run case', RELATIONS: [{ TYPE: 'File', VALUE: 'tests/not-run.test.mjs', LINE_RANGE: '15, 21' }] },
    { UID: 'TEST-AMBIGUOUS-001', 'Case name': 'duplicate case', RELATIONS: [{ TYPE: 'File', PATH: 'tests/duplicate.test.mjs', LINE_RANGE: '30, 38' }] },
  ];
  const result = associateTraceCases(scenarios, [
    { name: 'duplicate case', file: 'tests/duplicate.test.mjs', line: 32, result: 'PASSED' },
    { name: 'duplicate case', file: 'tests/duplicate.test.mjs', line: 36, result: 'PASSED' },
  ]);

  assert.deepEqual(result.map(({ testId, name, sourceRefs, result: status }) => ({ testId, name, sourceRefs, result: status })), [
    { testId: 'TEST-ABSENT-001', name: 'not run case', sourceRefs: [{ path: 'tests/not-run.test.mjs', range: '15, 21' }], result: 'NOT_RUN' },
    { testId: 'TEST-AMBIGUOUS-001', name: 'duplicate case', sourceRefs: [{ path: 'tests/duplicate.test.mjs', range: '30, 38' }], result: 'AMBIGUOUS' },
  ]);
});

test('does not observe an empty Node suite as a passing test case', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codexia-case-results-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, 'fixture.mjs');
  await writeFile(fixture, `
    import { describe, test } from 'node:test';
    describe('empty suite', () => {});
    test('skipped case', { skip: true }, () => {});
    test('todo case', { todo: true }, () => {});
    test('passing case', () => {});
  `);
  const reporter = fileURLToPath(new URL('./case-results.mjs', import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, ['--test', `--test-reporter=${reporter}`, fixture], { encoding: 'utf8', env });
  assert.deepEqual(output.trim().split('\n').map(line => {
    const { name, result } = JSON.parse(line);
    return [name, result];
  }), [['skipped case', 'SKIPPED'], ['todo case', 'TODO'], ['passing case', 'PASSED']]);
});
