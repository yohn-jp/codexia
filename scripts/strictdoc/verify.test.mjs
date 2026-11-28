import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  collectTraceNodes,
  deterministicMid,
  discoverSourceInventory,
  findTraceHtmlDocuments,
  normalizeHtml,
  normalizeSearchIndexJavascript,
  resolveRunIdentity,
  validateScenarioNodes,
  validateInventory,
  validateObligationDesignRefs,
  validateBaselineTraceIds,
  validateRequirementNodes,
  validateRelations,
  projectTraceabilityGates,
} from './verify.mjs';
import { discoverAnsibleSourceGraph } from './ansible-source-graph.mjs';

test('projects unauthenticated or incomplete gates as partial and preserves missing case evidence', () => {
  const gates = projectTraceabilityGates({
    requirementNodes: [{ UID: 'REQ-API-001', TEST_IDS: 'TEST-API-001 TEST-API-002' }],
    obligationTrace: { violations: [], gaps: ['OBL-REQ-API-001-O01: no exact-source run evidence'] },
    reverseTrace: { violations: [], gaps: ['surface link missing'] },
    caseExecutions: [{ testId: 'TEST-API-001', result: 'SKIPPED' }],
    run: { status: 'NOT_RUN' },
  });
  assert.equal(gates.G0.status, 'PARTIAL');
  for (const id of ['G1', 'G2', 'G3', 'G4', 'G6']) assert.equal(gates[id].status, 'NOT_RUN');
  assert.equal(gates.G7.status, 'PARTIAL');
  assert.equal(gates.G7.runStatus, 'NOT_RUN');
  assert.deepEqual(gates.G7.unresolvedCases, ['TEST-API-001', 'TEST-API-002']);
  assert.equal(gates.G7.publisherStatus, 'NOT_PUBLISHED');
  assert.equal(gates.G7.gapCount, 2);
});

test('blocks the trace gate when relation validation finds injected defects', () => {
  const gates = projectTraceabilityGates({
    requirementNodes: [],
    obligationTrace: { violations: ['duplicate UID'], gaps: [] },
    reverseTrace: { violations: [], gaps: [] },
    caseExecutions: [], run: { status: 'NOT_RUN' },
  });
  assert.equal(gates.G7.status, 'BLOCKED');
});

test('compares trace IDs and MIDs across standard JSON document boundaries', () => {
  const requirement = { _NODE_TYPE: 'REQUIREMENT', UID: 'REQ-UI-001', MID: 'requirement-mid' };
  const obligation = { _NODE_TYPE: 'OBLIGATION', UID: 'OBL-REQ-UI-001-O01', MID: 'obligation-mid' };
  const scenario = { _NODE_TYPE: 'TEST', UID: 'TEST-UI-001-001', MID: 'scenario-mid' };
  const baseline = collectTraceNodes({ DOCUMENTS: [{ NODES: [requirement, obligation, scenario] }] });
  const current = collectTraceNodes({ DOCUMENTS: [
    { NODES: [requirement] },
    { NODES: [{ _NODE_TYPE: 'SECTION', NODES: [scenario, obligation] }] },
  ] });
  assert.deepEqual(validateBaselineTraceIds(baseline, current), []);
  assert.deepEqual(validateBaselineTraceIds(baseline, [
    { ...requirement, MID: 'changed' },
    { ...obligation, _NODE_TYPE: 'REQUIREMENT' },
  ]), [
    'Baseline MID changed: REQ-UI-001',
    'Baseline node type changed: OBL-REQ-UI-001-O01',
    'Baseline TEST UID removed: TEST-UI-001-001',
  ]);
});

test('requires each trace UID to have an actual anchor in one native document', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codexia-trace-html-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'html/requirements'), { recursive: true });
  await writeFile(path.join(root, 'html/requirements/requirements.sdoc.html'),
    '<sdoc-anchor id="REQ-UI-001"></sdoc-anchor> <a href="verification.sdoc.html#TEST-UI-001-001">TEST-UI-001-001</a>');
  const ids = ['REQ-UI-001', 'TEST-UI-001-001'];
  await assert.rejects(findTraceHtmlDocuments(root, ids), /missing UID anchors: TEST-UI-001-001/u);
  const verification = path.join(root, 'html/requirements/verification.sdoc.html');
  await writeFile(verification, '<sdoc-anchor id="TEST-UI-001-001"></sdoc-anchor>');
  assert.deepEqual(await findTraceHtmlDocuments(root, ids), new Map([
    ['html/requirements/requirements.sdoc.html', ['REQ-UI-001']],
    ['html/requirements/verification.sdoc.html', ['TEST-UI-001-001']],
  ]));
  await writeFile(verification, '<sdoc-anchor id="REQ-UI-001"></sdoc-anchor>');
  await assert.rejects(findTraceHtmlDocuments(root, ids), /repeats UID anchor REQ-UI-001/u);
});

test('[TEST-TRC-04-003] fault injection rejects stale route, tool, and database classifications removed from source inventory', () => {
  const violations = validateInventory({ routes: [], tools: [], databaseObjects: [] }, [
    { kind: 'route', id: 'GET /api/removed', classification: 'REQ-API-001' },
    { kind: 'tool', id: 'removed_tool', classification: 'REQ-MCP-001' },
    { kind: 'databaseObject', id: 'public.removed_table', classification: 'REQ-DATA-001' },
  ]);
  assert.deepEqual(violations, [
    'Stale inventory classification for route GET /api/removed',
    'Stale inventory classification for tool removed_tool',
    'Stale inventory classification for databaseObject public.removed_table',
  ]);
});

test('[TEST-TRC-06-002] missing S3 receipt remains a blocked trace limitation and G5 remains NOT_RUN', () => {
  const gates = projectTraceabilityGates({
    requirementNodes: [], obligationTrace: { violations: [], gaps: [] },
    reverseTrace: { violations: [], gaps: [{ kind: 'BLOCKED', provenance: 'Discovery limitation', area: 'backup-receipt', reason: 'No run-bound S3 receipt or isolated restore result.' }] },
    caseExecutions: [], run: { status: 'NOT_RUN' },
  });
  assert.equal(gates.G4.status, 'NOT_RUN');
  assert.equal(gates.G5.status, 'NOT_RUN');
  assert.equal(gates.G7.status, 'PARTIAL');
  assert.match(JSON.stringify(gates.G7.blockers), /backup-receipt/u);
  assert.match(JSON.stringify(gates.G7.blockers), /No run-bound S3 receipt/u);
});

const stableMid = (uid) => createHash('sha256').update(uid).digest('hex').slice(0, 32);

test('[TEST-TRC-01-001] rejects duplicate requirement UIDs and unstable MIDs', () => {
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
    DECISION_STATUS: 'ACCEPTED', CONFORMANCE_STATUS: 'VERIFIED', APPLICABILITY: 'CURRENT',
  }]);
  assert.deepEqual(violations, [`${uid} cannot be VERIFIED without authenticated product obligation evidence`]);
});

test('rejects missing normative design links in obligation nodes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strictdoc-design-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs/requirements'), { recursive: true });
  await writeFile(path.join(root, 'docs/requirements/authority.sdoc'), '[DOCUMENT]\nTITLE: Authority\n');
  const violations = await validateObligationDesignRefs([{
    UID: 'OBL-REQ-DATA-001-O01',
    DESIGN_REFERENCE: '[Authority](authority.sdoc)、[Missing](../architecture/missing.sdoc); docs/requirements/authority.sdoc',
  }], 'docs/requirements/REQUIREMENT-REGISTER.sdoc', root);
  assert.deepEqual(violations, ['OBL-REQ-DATA-001-O01: File relation target is missing: docs/architecture/missing.sdoc']);
});

test('[TEST-TRC-03-001] rejects missing files and authored source ranges', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strictdoc-trace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'tiny.ts'), 'line one\nline two\n');
  const violations = await validateRelations([
    { UID: 'REQ-DATA-001', RELATIONS: [{ TYPE: 'File', VALUE: 'missing.ts' }] },
    { UID: 'REQ-DATA-002', RELATIONS: [{ TYPE: 'File', VALUE: 'tiny.ts', LINE_RANGE: '1, 8' }] },
  ], root);

  assert.match(violations.join('\n'), /missing\.ts/i);
  assert.match(violations.join('\n'), /line range.*tiny\.ts/i);
});

test('accepts file relations through repository-local links and rejects other file targets', async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'strictdoc-relation-targets-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, 'repo');
  await mkdir(path.join(root, 'directory'), { recursive: true });
  await writeFile(path.join(root, 'source.ts'), 'line one\nline two\n');
  await writeFile(path.join(scratch, 'outside.ts'), 'outside\n');
  await symlink('source.ts', path.join(root, 'inside-link.ts'));
  await symlink('../outside.ts', path.join(root, 'outside-link.ts'));

  const violations = await validateRelations([
    { UID: 'REQ-DATA-001', RELATIONS: [{ TYPE: 'File', VALUE: 'inside-link.ts' }] },
    { UID: 'REQ-DATA-002', RELATIONS: [{ TYPE: 'File', VALUE: 'outside-link.ts' }] },
    { UID: 'REQ-DATA-003', RELATIONS: [{ TYPE: 'File', VALUE: 'directory' }] },
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
    { UID: 'REQ-FIFO-001', RELATIONS: [{ TYPE: 'File', VALUE: 'named.pipe' }] },
  ], root);
  assert.deepEqual(violations, ['REQ-FIFO-001: File relation target is not a file: named.pipe']);
  await assert.rejects(discoverSourceInventory(root, { routes: ['named.pipe'] }), /Inventory route source.*named.pipe/u);
});

test('[TEST-TRC-04-001] reports discovered runtime surfaces that lack an explicit classification', () => {
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
    iacResources: ['cloudflareRoute.static:/*'],
    ansibleFiles: ['deploy/ansible/site.yml'],
  };
  const missing = validateInventory(discovered, []);
  assert.ok(missing.some(item => item === 'Unclassified nativeIosView AuthoringView'));
  assert.ok(missing.some(item => item === 'Unclassified iacResource cloudflareRoute.static:/*'));
  assert.ok(missing.some(item => item === 'Unclassified ansibleSource deploy/ansible/site.yml'));
  const complete = validateInventory(discovered, [
    { kind: 'nativeIosView', id: 'AuthoringView', classification: 'candidate REQ-UI-001; behavior unverified' },
    { kind: 'iacResource', id: 'cloudflareRoute.static:/*', classification: 'candidate REQ-EXT-001; applied state unverified' },
  ], { surfaces: [{ id: 'deploy/ansible/site.yml' }], violations: [] });
  assert.deepEqual(complete, []);
});

test('Ansible projection follows parsed literal include graphs and rejects orphan YAML', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strictdoc-ansible-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (relative, source) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), source);
  };
  await write('deploy/ansible/site.yml', [
    '- name: Site stage', '  hosts: all', '  vars_files: [repository-vars.yml]', '  tasks:',
    '    - name: Include base tasks', '      ansible.builtin.include_tasks:',
    '        file: tasks/base.yml',
  ].join('\n'));
  await write('deploy/ansible/repository-vars.yml', 'deployment_repository: fixture/codexia\n');
  await write('deploy/ansible/tasks/base.yml', [
    '- name: Import nested tasks', '  ansible.builtin.import_tasks: nested/runtime.yml',
  ].join('\n'));
  await write('deploy/ansible/tasks/nested/runtime.yml', '- name: Runtime task\n  ansible.builtin.debug:\n    msg: ready\n');
  await write('deploy/ansible/prepare-owner-activation.yml', '- name: Owner handoff\n  hosts: codexia\n  tasks: []\n');
  await write('deploy/ansible/inventory.example.yml', 'all:\n  hosts: {}\n');
  await write('deploy/ansible/roles/new-role/tasks/main.yml', '- name: Unreferenced role task\n  ansible.builtin.debug:\n    msg: orphan\n');

  const projection = await discoverAnsibleSourceGraph({
    repositoryRoot: root,
    groups: [
      { id: 'site', entrypoint: 'deploy/ansible/site.yml', mappingBasis: 'derivable', classification: 'Candidate REQ-OPS-001 / REQ-OPS-002' },
      { id: 'owner-handoff', entrypoint: 'deploy/ansible/prepare-owner-activation.yml', mappingBasis: 'derivable', classification: 'Candidate REQ-OPS-001 / REQ-OPS-002' },
    ],
    overrides: [{
      id: 'example-inventory', path: 'deploy/ansible/inventory.example.yml', mappingBasis: 'semantic',
      classification: 'Candidate REQ-OPS-001 / REQ-OPS-002; example only',
    }],
  });
  assert.ok(projection.surfaces.find(item => item.id === 'deploy/ansible/tasks/nested/runtime.yml')?.inventoryGroups.includes('site'));
  assert.ok(projection.surfaces.find(item => item.id === 'deploy/ansible/repository-vars.yml')?.inventoryGroups.includes('site'));
  assert.ok(projection.surfaces.find(item => item.id === 'deploy/ansible/inventory.example.yml')?.mappingBasis === 'semantic');
  assert.ok(projection.violations.some(item => item.includes('not reachable') && item.endsWith('deploy/ansible/roles/new-role/tasks/main.yml')));

  await write('deploy/ansible/dynamic.yml', '- name: Dynamic include\n  ansible.builtin.include_tasks: "{{ task_path }}"\n');
  const dynamicProjection = await discoverAnsibleSourceGraph({
    repositoryRoot: root,
    groups: [{ id: 'site', entrypoint: 'deploy/ansible/site.yml', mappingBasis: 'derivable', classification: 'candidate REQ-OPS-001' }],
  });
  assert.ok(dynamicProjection.violations.some(item => item.includes('Unresolved ansible.builtin.include_tasks')));
});

test('[TEST-TRC-04-002] discovers an unclassified SQL object from source instead of trusting cached inventory data', async (t) => {
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

test('[TEST-TRC-05-003] requires each TEST-ID to resolve to a declared requirement and a real test case', () => {
  const id = 'TEST-TRC-06-001';
  const parent = {
    UID: 'REQ-TRACE-001',
    TEST_IDS: 'TEST-TRC-06-001, NOT_ASSIGNED (no standalone TEST-ID exists)',
  };
  const scenario = {
    UID: id,
    MID: stableMid(id),
    EXACT_RUN_REFERENCE: 'NOT_RUN',
    EXECUTION_SCOPE: 'TRACE_NODE',
    RELATIONS: [{ TYPE: 'Parent', VALUE: parent.UID }],
  };
  const sources = new Map([[id, { file: 'case.test.mjs', line: 3, name: `[${id}] case`, runner: 'node' }]]);
  assert.deepEqual(validateScenarioNodes([scenario], [parent], sources), []);
  assert.match(validateScenarioNodes([{
    ...scenario, EXACT_RUN_REFERENCE: 'https://github.com/yohn-jp/codexia/actions/runs/7',
  }], [parent], sources).join('\n'), /authored Exact-run reference must be NOT_RUN/u);
  assert.match(validateScenarioNodes([{
    ...scenario, EXECUTION_SCOPE: 'unknown', RELATIONS: [{ TYPE: 'File', VALUE: 'case.test.mjs' }],
  }], [parent], new Map()).join('\n'), /invalid Execution scope[\s\S]*missing a parent[\s\S]*must be derived[\s\S]*no native test registration/iu);
  assert.match(validateScenarioNodes([], [parent], sources).join('\n'), /missing test scenario/u);
  assert.match(validateScenarioNodes([scenario, scenario], [parent], sources).join('\n'), /Duplicate test scenario UID/u);
  assert.match(validateScenarioNodes([scenario], [{ ...parent, TEST_IDS: `${id} ${id} TEST-INVALID` }], sources).join('\n'),
    /duplicate TEST-ID references[\s\S]*invalid TEST-ID TEST-INVALID/u);
  assert.match(validateScenarioNodes([scenario], [parent, { ...parent, UID: 'REQ-TRACE-002' }], sources).join('\n'),
    /REQ-TRACE-002 declares TEST-TRC-06-001 parented by REQ-TRACE-001/u);
  const unknownSources = new Map([...sources, ['TEST-TRC-99-999', { file: 'other.test.mjs', line: 1 }]]);
  assert.match(validateScenarioNodes([scenario], [parent], unknownSources).join('\n'), /unknown TEST-ID TEST-TRC-99-999/u);
});

test('[TEST-TRC-05-001] requires complete exact GitHub run identity when running in Actions', () => {
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

test('[TEST-TRC-05-002] keeps local execution as NOT_RUN instead of inventing a CI link', () => {
  assert.deepEqual(resolveRunIdentity({}), { status: 'NOT_RUN' });
});

test('[TEST-TRC-02-001] normalizes only the observed StrictDoc HTML volatility', () => {
  const html = [
    '<meta name="strictdoc-search-index-timestamp" content="1795413779.221949">',
    '<turbo-frame id="article-b9e6dedfa4674cb9af824ccffd19b566">',
    '<turbo-frame id="article-9d4f2545b24a45dd9c81ae42f0d167d1">',
    '<sdoc-node data-uid="REQ-DATA-001" data-nodeid="11111111111111111111111111111111">',
    'https://example.test/1795413779.221949',
  ].join('\n');

  const normalized = normalizeHtml(html);
  assert.match(normalized, /strictdoc-search-index-timestamp" content="<TIMESTAMP>"/);
  assert.match(normalized, /article-b9e6dedfa4674cb9af824ccffd19b566/);
  assert.match(normalized, /article-9d4f2545b24a45dd9c81ae42f0d167d1/);
  assert.match(normalized, /data-nodeid="11111111111111111111111111111111"/);
  assert.match(normalized, /https:\/\/example\.test\/1795413779\.221949/);
});

test('[TEST-TRC-02-002] canonicalizes only StrictDoc search index object keys and set membership order', () => {
  const first = 'window.StrictDoc.search.index = {"z":[2,1],"a":[2,1]};\nwindow.other = {"b":2,"a":1};';
  const second = 'window.StrictDoc.search.index = {"a":[1,2],"z":[1,2]};\nwindow.other = {"b":2,"a":1};';
  const expected = 'window.StrictDoc.search.index = {"a":[1,2],"z":[1,2]};\nwindow.other = {"b":2,"a":1};';
  assert.equal(normalizeSearchIndexJavascript(first), expected);
  assert.equal(normalizeSearchIndexJavascript(second), expected);
});
