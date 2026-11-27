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

test('matches a TEST ID only to one execution of the registered case', () => {
  const sources = new Map(['pass', 'skip', 'duplicate', 'wrong line', 'wrong file', 'absent'].map((title, i) => {
    const id = `TEST-TRACE-00${i}`;
    return [id, { name: `[${id}] ${title}`, file: 'scripts/check.test.mjs', line: 8 }];
  }));
  const cases = [...sources.values()].slice(0, 5).map(item => ({ ...item, result: 'PASSED' }));
  cases[1].result = 'SKIPPED';
  cases[3].line += 1;
  cases[4].file = 'scripts/other.test.mjs';
  cases.push({ ...cases[2] });
  cases.push({ name: 'absent', file: 'scripts/check.test.mjs', line: 8, result: 'PASSED' });

  assert.deepEqual(associateTraceCases(sources, cases).map(({ testId, result, sourceRefs }) => [testId, result, sourceRefs]), [
    ['TEST-TRACE-000', 'PASSED', [{ path: 'scripts/check.test.mjs', line: 8 }]],
    ['TEST-TRACE-001', 'SKIPPED', [{ path: 'scripts/check.test.mjs', line: 8 }]],
    ['TEST-TRACE-002', 'AMBIGUOUS', [{ path: 'scripts/check.test.mjs', line: 8 }]],
    ['TEST-TRACE-003', 'NOT_RUN', [{ path: 'scripts/check.test.mjs', line: 8 }]],
    ['TEST-TRACE-004', 'NOT_RUN', [{ path: 'scripts/check.test.mjs', line: 8 }]],
    ['TEST-TRACE-005', 'NOT_RUN', [{ path: 'scripts/check.test.mjs', line: 8 }]],
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
