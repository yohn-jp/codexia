import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  deterministicMid,
  discoverSourceInventory,
  normalizeHtml,
  normalizeSearchIndexJavascript,
  resolveRunIdentity,
  validateScenarioNodes,
  validateInventory,
  validateObligationDesignRefs,
  validateRequirementNodes,
  validateRelations,
} from './verify.mjs';

const stableMid = (uid) => createHash('sha256').update(uid).digest('hex').slice(0, 32);

test('rejects duplicate requirement UIDs and unstable MIDs', () => {
  assert.equal(deterministicMid('REQ-DATA-001'), stableMid('REQ-DATA-001'));
  const violations = validateRequirementNodes([
    { UID: 'REQ-DATA-001', MID: stableMid('REQ-DATA-001'), TITLE: 'First' },
    { UID: 'REQ-DATA-001', MID: stableMid('REQ-DATA-001'), TITLE: 'Duplicate' },
    { UID: 'REQ-DATA-002', MID: 'not-a-stable-mid', TITLE: 'Malformed MID' },
  ]);

  assert.match(violations.join('\n'), /duplicate UID REQ-DATA-001/i);
  assert.match(violations.join('\n'), /MID.*REQ-DATA-002/i);
});

test('rejects authored VERIFIED status without authenticated product evidence', () => {
  const uid = 'REQ-DATA-001';
  const violations = validateRequirementNodes([{
    UID: uid, MID: stableMid(uid), TITLE: 'Authoritative data', STATEMENT: 'Use PostgreSQL.',
    'Decision status': 'ACCEPTED', 'Conformance status': 'VERIFIED', Applicability: 'CURRENT',
  }]);
  assert.deepEqual(violations, [`${uid} cannot be VERIFIED without authenticated product obligation evidence`]);
});

test('rejects missing normative design links in obligation nodes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strictdoc-design-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs/requirements'), { recursive: true });
  await writeFile(path.join(root, 'docs/requirements/authority.md'), '# Authority\n');
  const violations = await validateObligationDesignRefs([{
    UID: 'OBL-REQ-DATA-001-O01',
    'Design reference': '[Authority](authority.md)、[Missing](../architecture/missing.md); docs/requirements/authority.md',
  }], 'docs/requirements/REQUIREMENT-REGISTER.md', root);
  assert.deepEqual(violations, ['OBL-REQ-DATA-001-O01: File relation target is missing: docs/architecture/missing.md']);
});

test('rejects missing files and ranges beyond the referenced source', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strictdoc-trace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'tiny.ts'), 'line one\nline two\n');
  const violations = await validateRelations([
    { UID: 'REQ-DATA-001', RELATIONS: [{ TYPE: 'File', VALUE: 'missing.ts', LINE_RANGE: '1, 2' }] },
    { UID: 'REQ-DATA-002', RELATIONS: [{ TYPE: 'File', VALUE: 'tiny.ts', LINE_RANGE: '1, 8' }] },
  ], root);

  assert.match(violations.join('\n'), /missing\.ts/i);
  assert.match(violations.join('\n'), /tiny\.ts.*line range/i);
});

test('accepts ranged relations through repository-local links and rejects other file targets', async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'strictdoc-relation-targets-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, 'repo');
  await mkdir(path.join(root, 'directory'), { recursive: true });
  await writeFile(path.join(root, 'source.ts'), 'line one\nline two\n');
  await writeFile(path.join(scratch, 'outside.ts'), 'outside\n');
  await symlink('source.ts', path.join(root, 'inside-link.ts'));
  await symlink('../outside.ts', path.join(root, 'outside-link.ts'));

  const violations = await validateRelations([
    { UID: 'REQ-DATA-001', RELATIONS: [{ TYPE: 'File', VALUE: 'inside-link.ts', LINE_RANGE: '1, 2' }] },
    { UID: 'REQ-DATA-002', RELATIONS: [{ TYPE: 'File', VALUE: 'outside-link.ts', LINE_RANGE: '1, 1' }] },
    { UID: 'REQ-DATA-003', RELATIONS: [{ TYPE: 'File', VALUE: 'directory', LINE_RANGE: '1, 1' }] },
  ], root);

  assert.deepEqual(violations, [
    'REQ-DATA-002: File relation resolves outside repository: outside-link.ts',
    'REQ-DATA-003: File relation target is not a file: directory',
  ]);
});

test('identifies invalid reverse-inventory source paths by their inventory kind', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strictdoc-inventory-targets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'directory'));
  await assert.rejects(discoverSourceInventory(root, { routes: ['missing.ts'] }), /Inventory route source.*missing\.ts/u);
  await assert.rejects(discoverSourceInventory(root, { routes: ['directory'] }), /Inventory route source.*directory/u);
});

test('rejects FIFO relations and inventory paths without blocking', { skip: process.platform === 'win32', timeout: 5000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strictdoc-fifo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fifo = path.join(root, 'named.pipe');
  const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const violations = await validateRelations([
    { UID: 'REQ-FIFO-001', RELATIONS: [{ TYPE: 'File', VALUE: 'named.pipe', LINE_RANGE: '1, 1' }] },
  ], root);
  assert.deepEqual(violations, ['REQ-FIFO-001: File relation target is not a file: named.pipe']);
  await assert.rejects(discoverSourceInventory(root, { routes: ['named.pipe'] }), /Inventory route source.*named.pipe/u);
});

test('reports discovered runtime surfaces that lack an explicit classification', () => {
  const violations = validateInventory({
    routes: ['GET /api/v1/projects', 'DELETE /api/v1/projects/:id'],
    tools: ['project_read'],
    databaseObjects: ['public.project', 'public.document_revision'],
  }, [
    { kind: 'route', id: 'GET /api/v1/projects', classification: 'REQ-DATA-001' },
    { kind: 'tool', id: 'project_read', classification: 'REQ-CORE-001' },
    { kind: 'databaseObject', id: 'public.project', classification: 'REQ-DATA-001' },
  ]);

  assert.match(violations.join('\n'), /DELETE \/api\/v1\/projects/);
  assert.match(violations.join('\n'), /public\.document_revision/);
});

test('requires explicit inventory classifications for native iOS and IaC surfaces', () => {
  const discovered = {
    routes: [], tools: [], databaseObjects: [],
    nativeIosViews: ['AuthoringView'],
    iacResources: ['cloudflare_workers_route.frontend'],
    ansibleFiles: ['deploy/ansible/site.yml'],
  };
  const missing = validateInventory(discovered, []);
  assert.ok(missing.some(item => item === 'Unclassified nativeIosView AuthoringView'));
  assert.ok(missing.some(item => item === 'Unclassified iacResource cloudflare_workers_route.frontend'));
  assert.ok(missing.some(item => item === 'Unclassified ansibleSource deploy/ansible/site.yml'));
  const complete = validateInventory(discovered, [
    { kind: 'nativeIosView', id: 'AuthoringView', classification: 'candidate REQ-UI-001; behavior unverified' },
    { kind: 'iacResource', id: 'cloudflare_workers_route.frontend', classification: 'candidate REQ-EXT-001; applied state unverified' },
    { kind: 'ansibleSource', id: 'deploy/ansible/site.yml', classification: 'candidate REQ-OPS-001; host execution unverified' },
  ]);
  assert.deepEqual(complete, []);
});

test('discovers an unclassified SQL object from source instead of trusting cached inventory data', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strictdoc-inventory-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packages', 'persistence-postgres', 'migrations'), { recursive: true });
  await mkdir(path.join(root, 'packages', 'api', 'src', 'generated'), { recursive: true });
  await mkdir(path.join(root, 'modules', 'mcp', 'src'), { recursive: true });
  await writeFile(path.join(root, 'packages', 'api', 'src', 'generated', 'http-contract.json'), JSON.stringify({
    routes: [
      { method: 'GET', url: '/api/projects', operationId: 'projects_list_get' },
      { method: 'POST', url: '/api/spec01-inventory-fixture', operationId: 'spec01_inventory_fixture_post' },
    ],
  }));
  await writeFile(path.join(root, 'modules', 'mcp', 'src', 'tools.ts'), [
    'server.tool("list_projects", "existing tool", {});',
    'server.registerTool("spec01_inventory_fixture", { description: "unclassified tool", inputSchema: {} }, async () => {});',
  ].join('\n'));
  await writeFile(path.join(root, 'packages', 'persistence-postgres', 'migrations', '0001-initial.sql'), [
    'CREATE TABLE project (id integer PRIMARY KEY);',
    'CREATE FUNCTION fixture_guard() RETURNS void AS $$',
    'CREATE TABLE hidden_inside_function_body (id integer PRIMARY KEY);',
    '$$ LANGUAGE plpgsql;',
    'CREATE TABLE spec01_inventory_review_fixture (id integer PRIMARY KEY);',
  ].join('\n'));

  const verifier = await import('./verify.mjs');
  assert.equal(typeof verifier.verifySourceInventory, 'function', 'the verifier must expose the same source-bound inventory check used by runVerifier');
  const result = await verifier.verifySourceInventory(root, {
    scope: {
      routes: ['packages/api/src/generated/http-contract.json'],
      tools: ['modules/mcp/src/tools.ts'],
      databaseObjects: ['packages/persistence-postgres/migrations/0001-initial.sql'],
    },
    classifications: [
      { kind: 'route', id: 'GET /api/projects', classification: 'reviewed baseline' },
      { kind: 'tool', id: 'list_projects', classification: 'reviewed baseline' },
      { kind: 'databaseObject', id: 'public.project', classification: 'reviewed baseline' },
    ],
  });

  assert.ok(result.discovered.databaseObjects.includes('public.spec01_inventory_review_fixture'));
  assert.ok(!result.discovered.databaseObjects.includes('public.hidden_inside_function_body'));
  assert.ok(result.discovered.routes.includes('POST /api/spec01-inventory-fixture'));
  assert.ok(result.discovered.tools.includes('spec01_inventory_fixture'));
  assert.match(result.violations.join('\n'), /Unclassified databaseObject public\.spec01_inventory_review_fixture/);
  assert.match(result.violations.join('\n'), /Unclassified route POST \/api\/spec01-inventory-fixture/);
  assert.match(result.violations.join('\n'), /Unclassified tool spec01_inventory_fixture/);
});

test('requires each TEST-ID to resolve to a declared requirement and a real test case', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strictdoc-scenarios-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'case.test.mjs'), "test('rejects a damaged identifier', () => {});\n");
  const parent = {
    UID: 'REQ-TRACE-001',
    'Test IDs': 'TEST-TRC-06-001, NOT_ASSIGNED (no standalone TEST-ID exists)',
  };
  const scenarios = [{
    UID: 'TEST-TRC-06-001',
    MID: stableMid('TEST-TRC-06-001'),
    'Case name': 'rejects a damaged identifier',
    'Exact-run reference': 'NOT_RUN',
    RELATIONS: [
      { TYPE: 'Parent', VALUE: 'REQ-TRACE-001' },
      { TYPE: 'File', VALUE: 'case.test.mjs' },
    ],
  }];

  assert.deepEqual(await validateScenarioNodes(scenarios, [parent], root), []);
  const broken = [{
    ...scenarios[0],
    'Case name': 'does not exist in the source file',
    RELATIONS: [{ TYPE: 'File', VALUE: 'case.test.mjs' }],
  }];
  const violations = await validateScenarioNodes(broken, [parent], root);
  assert.match(violations.join('\n'), /missing a parent requirement/i);
  assert.match(violations.join('\n'), /case name.*not found/i);
});

test('requires complete exact GitHub run identity when running in Actions', () => {
  const result = resolveRunIdentity({
    GITHUB_ACTIONS: 'true',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'yohn-jp/codexia',
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_JOB: 'verify-strictdoc',
    GITHUB_SHA: 'd'.repeat(40),
    CODEXIA_CI_SOURCE_SHA: 'c'.repeat(40),
    CODEXIA_CI_TASK: 'requirements-trace',
  });

  assert.deepEqual(result, {
    status: 'IN_PROGRESS',
    repository: 'yohn-jp/codexia',
    sourceSha: 'c'.repeat(40),
    eventSha: 'd'.repeat(40),
    runId: '12345',
    runAttempt: 2,
    job: 'verify-strictdoc',
    task: 'requirements-trace',
    runUrl: 'https://github.com/yohn-jp/codexia/actions/runs/12345',
  });

  assert.throws(
    () => resolveRunIdentity({ GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '12345' }),
    /incomplete.*GitHub Actions/i,
  );
});

test('keeps local execution as NOT_RUN instead of inventing a CI link', () => {
  assert.deepEqual(resolveRunIdentity({}), { status: 'NOT_RUN' });
});

test('normalizes only the observed StrictDoc HTML volatility', () => {
  const html = [
    '<meta name="strictdoc-search-index-timestamp" content="1795413779.221949">',
    '<turbo-frame id="article-b9e6dedfa4674cb9af824ccffd19b566">',
    '<turbo-frame id="article-9d4f2545b24a45dd9c81ae42f0d167d1">',
    '<sdoc-node data-uid="REQ-DATA-001" data-nodeid="11111111111111111111111111111111">',
    'https://example.test/1795413779.221949',
  ].join('\n');

  const normalized = normalizeHtml(html, { stableMids: [stableMid('REQ-DATA-001')] });
  assert.match(normalized, /strictdoc-search-index-timestamp" content="<TIMESTAMP>"/);
  assert.equal((normalized.match(/article-<SHELL-MID>/gu) ?? []).length, 2);
  assert.match(normalized, /data-nodeid="11111111111111111111111111111111"/);
  assert.match(normalized, /https:\/\/example\.test\/1795413779\.221949/);
});

test('canonicalizes only StrictDoc search index object keys and set membership order', () => {
  const first = 'window.StrictDoc.search.index = {"z":[2,1],"a":[2,1]};\nwindow.other = {"b":2,"a":1};';
  const second = 'window.StrictDoc.search.index = {"a":[1,2],"z":[1,2]};\nwindow.other = {"b":2,"a":1};';
  const expected = 'window.StrictDoc.search.index = {"a":[1,2],"z":[1,2]};\nwindow.other = {"b":2,"a":1};';
  assert.equal(normalizeSearchIndexJavascript(first), expected);
  assert.equal(normalizeSearchIndexJavascript(second), expected);
});
