import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverTestSources, testIdsFromName } from './test-sources.mjs';
import { isTraceTestSource } from './test-source-path.mjs';

test('recognizes repository test, spec, and browser source paths', () => {
  assert.equal(isTraceTestSource('tests/e2e/core.acceptance.spec.ts'), true);
  assert.equal(isTraceTestSource('scripts/strictdoc/verify.browser.mjs'), true);
  assert.equal(isTraceTestSource('packages/api/src/server.test.ts'), true);
  assert.equal(isTraceTestSource('scripts/strictdoc/verify.mjs'), false);
  assert.equal(isTraceTestSource('node_modules/example/example.test.js'), true);
});

test('discovers prefixed tests through imported runner bindings and returns current source lines', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'strictdoc-test-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'scripts', 'node.test.mjs'), `
    import { test as check } from 'node:test';
    const alias = check;
    alias('[TEST-TRACE-001] [TEST-TRACE-004] rejects invalid input', () => {});
    {
      const alias = () => {};
      alias('[TEST-TRACE-005] shadowed runner is ignored', () => {});
    }
  `);
  await writeFile(path.join(root, 'scripts', 'playwright-fixture.ts'), `
    import { test as base } from '@playwright/test';
    export const test = base.extend({});
  `);
  await writeFile(path.join(root, 'scripts', 'playwright.spec.ts'), `
    import { test } from './playwright-fixture';
    test('[TEST-TRACE-002] renders the selected state', async () => {});
    test.extend('[TEST-TRACE-027] extension construction is not a test', () => {});
  `);
  await writeFile(path.join(root, 'scripts', 'browser.mjs'), `
    const { test: verify } = require('node:test');
    verify('[TEST-TRACE-003] observes a browser result', () => {});
  `);

  const result = await discoverTestSources(root);
  assert.deepEqual(result.violations, []);
  assert.deepEqual([...result.sources.entries()].map(([id, { file, line, name, runner }]) => [id, file, line, name, runner]), [
    ['TEST-TRACE-001', 'scripts/node.test.mjs', 4, '[TEST-TRACE-001] [TEST-TRACE-004] rejects invalid input', 'node'],
    ['TEST-TRACE-002', 'scripts/playwright.spec.ts', 3, '[TEST-TRACE-002] renders the selected state', 'playwright'],
    ['TEST-TRACE-003', 'scripts/browser.mjs', 3, '[TEST-TRACE-003] observes a browser result', 'node'],
    ['TEST-TRACE-004', 'scripts/node.test.mjs', 4, '[TEST-TRACE-001] [TEST-TRACE-004] rejects invalid input', 'node'],
  ]);
});

test('ignores comments and unrelated title text while rejecting malformed, dynamic, and duplicate IDs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'strictdoc-test-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'cases.test.mjs'), `
    import { test } from 'node:test';
    // test('[TEST-TRACE-010] comment is not a case', () => {});
    const sample = "test('[TEST-TRACE-011] string is not a case')";
    test('[TEST-TRACE-004] first registration', () => {});
    test('[TEST-TRACE-004] duplicate registration', () => {});
    test('[TEST-TRACE_BAD] malformed identifier', () => {});
    test('[TEST-TRACE-005] ' + suffix, () => {});
  `);

  const result = await discoverTestSources(root);
  assert.deepEqual([...result.sources.keys()], []);
  assert.match(result.violations.join('\n'), /Duplicate TEST-ID TEST-TRACE-004/u);
  assert.match(result.violations.join('\n'), /canonical contiguous \[TEST-ID\] prefixes/u);
  assert.match(result.violations.join('\n'), /static string literal/u);
  assert.deepEqual(testIdsFromName('[TEST-TRACE-001] [TEST-TRACE-002] companion'), [
    'TEST-TRACE-001', 'TEST-TRACE-002',
  ]);
});

test('rejects unsupported Playwright default imports and ignores type-only, reassigned, and shadowed bindings', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'strictdoc-test-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'playwright-default.test.ts'), `
    import test from '@playwright/test';
    test('[TEST-TRACE-020] noncanonical Playwright import', () => {});
  `);
  await writeFile(path.join(root, 'bindings.test.ts'), `
    import { test as imported } from 'node:test';
    import type { test as typeOnly } from 'node:test';
    let reassigned = imported;
    reassigned = () => {};
    reassigned('[TEST-TRACE-021] reassigned import', () => {});
    function local(require) {
      const { test } = require('node:test');
      test('[TEST-TRACE-022] shadowed require', () => {});
    }
    typeOnly('[TEST-TRACE-023] type only import', () => {});
    imported.skip('[TEST-TRACE-024] skipped case', () => {});
    imported.todo('[TEST-TRACE-025] todo case', () => {});
    imported.only('[TEST-TRACE-026] focused case', () => {});
  `);

  const result = await discoverTestSources(root);
  assert.deepEqual([...result.sources.keys()], ['TEST-TRACE-024', 'TEST-TRACE-025', 'TEST-TRACE-026']);
  assert.match(result.violations.join('\n'), /Playwright TEST-ID registration must use a named test import/u);
});

test('parses TypeScript generic arrows without mistaking them for JSX while preserving TSX', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'strictdoc-test-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'generic.test.ts'), `
    import { test } from 'node:test';
    const identity = async <T>(value: T): Promise<T> => value;
    test('[TEST-TRACE-030] admits TypeScript generic arrows', () => { identity('fixture'); });
  `);
  await writeFile(path.join(root, 'element.test.tsx'), `
    import { test } from 'node:test';
    const element = <span>fixture</span>;
    test('[TEST-TRACE-031] admits TSX syntax', () => { void element; });
  `);
  const result = await discoverTestSources(root);
  assert.deepEqual(result.violations, []);
  assert.deepEqual([...result.sources.keys()], ['TEST-TRACE-030', 'TEST-TRACE-031']);
});
