import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildReverseTrace, discoverReverseSurfaces } from './reverse-trace.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('reverse discovery records authority and provenance for HTTP, MCP, DB, UI and operational surfaces', async () => {
  const { surfaces, limitations } = await discoverReverseSurfaces({ repositoryRoot });
  assert.ok(surfaces.some((item) => item.kind === 'httpOperation' && item.id === 'GET /api/projects' && item.source.path === 'packages/http-contract/test/fixtures/admitted-routes.json'));
  assert.ok(surfaces.some((item) => item.kind === 'httpRuntimeRoute' && item.id === 'GET /api/projects' && item.operationId === 'projects_list_get' && item.source.path === 'packages/api/src/http-contract.ts'));
  assert.ok(surfaces.some((item) => item.kind === 'mcpTool' && item.id === 'list_projects'));
  const publicMcpTools = surfaces.filter((item) => item.kind === 'mcpTool');
  assert.equal(publicMcpTools.length, 53, 'all public MCP tools remain discoverable across SDK v1/v2 registration shapes');
  assert.equal(new Set(publicMcpTools.map((item) => item.id)).size, 53, 'every public MCP tool has one unique reverse mapping');
  assert.ok(surfaces.some((item) => item.kind === 'databaseCatalogObject' && item.id === 'public.project'));
  assert.ok(surfaces.some((item) => item.kind === 'uiControl' && item.id === 'WRT-01.A'));
  assert.ok(surfaces.some((item) => item.kind === 'backupInterface' && item.id === 'deploy/backup/backup.sh'));
  assert.ok(surfaces.some((item) => item.kind === 'ciWorkflow' && item.id === '.github/workflows/repository-audit.yml'));
  assert.ok(surfaces.every((item) => item.provenance && item.source?.path));
  assert.deepEqual(new Set(limitations.map((item) => item.area)), new Set(['mcp-effect', 'database-live', 'ui-runtime', 'ci-runtime', 'native-ios-runtime', 'iac-runtime', 'ansible-runtime', 'deployment-runtime', 'backup-receipt']));
});

test('reverse discovery inventories SDK v2 registerTool names with source coordinates', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codexia-mcp-v2-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const toolPath = 'modules/mcp/src/tools/project.ts';
  await mkdir(path.dirname(path.join(root, toolPath)), { recursive: true });
  const literal = [
    'server.registerTool(',
    '  "list_projects", { description: "List", inputSchema: {} }, async () => {});',
  ];
  await writeFile(path.join(root, toolPath), literal.join('\n'));

  const staticOnly = await discoverReverseSurfaces({ repositoryRoot: root });
  assert.ok(staticOnly.surfaces.every(item => item.kind !== 'mcpRegistration'),
    'whitespace before a literal name must not create a dynamic-registration gap');

  await writeFile(path.join(root, toolPath), [...literal,
    '// server.registerTool("unregistered", config, handler);',
    'server.registerTool(dynamicToolName, { description: "Dynamic", inputSchema: {} }, handler);',
  ].join('\n'));

  const { surfaces } = await discoverReverseSurfaces({ repositoryRoot: root });
  assert.deepEqual(surfaces.filter(item => item.kind === 'mcpTool').map(item => [item.id, item.source]),
    [['list_projects', { path: toolPath, line: 1 }]]);
  assert.ok(surfaces.some(item => item.kind === 'mcpRegistration' && item.id === `dynamic:${toolPath}`));

  const { discoverSourceInventory } = await import('./verify.mjs');
  await writeFile(path.join(root, 'routes.json'), '{"routes":[]}');
  await writeFile(path.join(root, 'migration.sql'), 'CREATE TABLE project (id integer);');
  await assert.rejects(discoverSourceInventory(root, {
    routes: ['routes.json'], tools: [toolPath], databaseObjects: ['migration.sql'],
  }), /MCP tool registration must use a literal tool name/u);
});

test('reverse discovery inventories native iOS views and declared IaC resources', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codexia-platform-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'ios/CodexiaApp/Sources'), { recursive: true });
  await mkdir(path.join(root, 'ios/CodexiaEditor/Sources'), { recursive: true });
  await mkdir(path.join(root, 'deploy/cloudflare/terraform'), { recursive: true });
  await mkdir(path.join(root, 'deploy/ansible'), { recursive: true });
  await writeFile(path.join(root, 'ios/CodexiaApp/Sources/EditorScreen.swift'), `import SwiftUI\nstruct EditorScreen: View { var body: some View { Text("Editor") } }\n`);
  await writeFile(path.join(root, 'ios/CodexiaEditor/Sources/AuthoringView.swift'), `import SwiftUI\npublic struct AuthoringView: View { public var body: some View { Text("Authoring") } }\n`);
  for (const directory of ['ios/CodexiaTransport/.build/checkouts/vendor/Sources', 'ios/CodexiaTransport/Sources/CodexiaAPI/Generated']) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, 'BuildProduct.swift'), 'struct BuildProduct: View {}');
  }
  await mkdir(path.join(root, 'app/src/generated/http'), { recursive: true });
  await writeFile(path.join(root, 'app/src/generated/http/client.ts'), '// CTRL-PRJ-GENERATED');
  await writeFile(path.join(root, 'app/src/generated/browser-modules.ts'), '// CTRL-PRJ-SOURCE');
  await writeFile(path.join(root, 'deploy/cloudflare/terraform/main.tf'), `resource "cloudflare_workers_route" "frontend" {\n  pattern = "example.com/*"\n}\n`);
  await writeFile(path.join(root, 'deploy/ansible/site.yml'), `- name: Configure Codexia\n  hosts: codexia\n  tasks: []\n`);

  const result = await discoverReverseSurfaces({ repositoryRoot: root });
  assert.ok(!result.surfaces.some(item => item.id === 'BuildProduct' || item.id === 'CTRL-PRJ-GENERATED'));
  assert.ok(result.surfaces.some(item => item.kind === 'uiControlBindingReference' && item.id === 'CTRL-PRJ-SOURCE'));
  assert.ok(result.surfaces.some(item => item.kind === 'nativeIosView' && item.id === 'EditorScreen' && item.source.path.endsWith('EditorScreen.swift')));
  assert.ok(result.surfaces.some(item => item.kind === 'nativeIosView' && item.id === 'AuthoringView' && item.source.path.endsWith('AuthoringView.swift')));
  assert.ok(result.surfaces.some(item => item.kind === 'iacResource' && item.id === 'cloudflare_workers_route.frontend' && item.source.path.endsWith('main.tf')));
  assert.ok(result.surfaces.some(item => item.kind === 'ansibleSource' && item.id === 'deploy/ansible/site.yml'));
  assert.ok(result.limitations.some(item => item.area === 'native-ios-runtime'));
  assert.ok(result.limitations.some(item => item.area === 'iac-runtime'));
});

test('platform source coordinates survive comments and blank lines', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codexia-platform-coordinates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const swiftPath = 'ios/CodexiaApp/Sources/EditorScreen.swift';
  const terraformPath = 'deploy/cloudflare/terraform/main.tf';
  await mkdir(path.dirname(path.join(root, swiftPath)), { recursive: true });
  await mkdir(path.dirname(path.join(root, terraformPath)), { recursive: true });
  const swift = ['import SwiftUI', '/*', 'struct CommentedView: View {}', '*/', '// struct CommentedLineView: View {}', '', '  struct EditorScreen: View {}', '', 'public struct SecondView: View {}'];
  const terraform = ['/*', 'resource "cloudflare_workers_route" "commented" {}', '*/', '# resource "cloudflare_workers_route" "commented_line" {}', '', '  resource "cloudflare_workers_route" "frontend" {', '  pattern = "example.com/*"', '}', '', 'resource "cloudflare_workers_route" "origin" {}'];
  for (const newline of ['\n', '\r\n']) {
    await writeFile(path.join(root, swiftPath), swift.join(newline) + newline);
    await writeFile(path.join(root, terraformPath), terraform.join(newline) + newline);
    const { surfaces } = await discoverReverseSurfaces({ repositoryRoot: root });
    assert.deepEqual(surfaces.filter(item => item.kind === 'nativeIosView').map(item => [item.id, item.source]), [
      ['EditorScreen', { path: swiftPath, line: 7 }],
      ['SecondView', { path: swiftPath, line: 9 }],
    ]);
    assert.deepEqual(surfaces.filter(item => item.kind === 'iacResource').map(item => [item.id, item.source]), [
      ['cloudflare_workers_route.frontend', { path: terraformPath, line: 6 }],
      ['cloudflare_workers_route.origin', { path: terraformPath, line: 10 }],
    ]);
  }
});

test('typed iOS and IaC identifiers reverse-map without certifying implementation or execution', () => {
  const source = { path: 'fixture' };
  const result = buildReverseTrace({
    discovered: [
      { kind: 'nativeIosView', id: 'AuthoringView', source, provenance: 'SwiftUI declaration' },
      { kind: 'iacResource', id: 'cloudflare_workers_route.frontend', source, provenance: 'Terraform resource declaration' },
    ],
    obligations: [
      { requirementId: 'REQ-UI-001', obligationId: 'OBL-REQ-UI-001-O01', surfaceIdentifiers: [{ kind: 'nativeIosView', id: 'AuthoringView' }], testIds: [], exactRuns: [] },
      { requirementId: 'REQ-EXT-001', obligationId: 'OBL-REQ-EXT-001-O01', surfaceIdentifiers: [{ kind: 'iacResource', id: 'cloudflare_workers_route.frontend' }], testIds: [], exactRuns: [] },
    ],
  });
  assert.deepEqual(result.rows.map(row => row.status), ['UNVERIFIED', 'UNVERIFIED']);
  assert.equal(result.gaps.filter(gap => gap.kind === 'UNVERIFIED').length, 2);
  assert.ok(result.rows.every(row => row.exactRuns.length === 0));
});

test('derivable Ansible source groups remain navigation metadata, not semantic obligation links', () => {
  const result = buildReverseTrace({
    discovered: [{
      kind: 'ansibleSource', id: 'deploy/ansible/deploy-prepare.yml',
      source: { path: 'deploy/ansible/deploy-prepare.yml' }, provenance: 'Ansible task include',
      inventoryGroups: ['ansible-site'],
      inventoryClassification: 'Candidate REQ-OPS-001 / REQ-OPS-002; derived from the site playbook include graph.',
      candidateRequirementIds: ['REQ-OPS-001', 'REQ-OPS-002'],
      mappingBasis: 'derivable',
    }],
    inventory: { classifications: [] },
  });
  assert.equal(result.rows[0].status, 'UNMAPPED');
  assert.equal(result.rows[0].requirementId, undefined);
  assert.equal(result.rows[0].mappingBasis, 'derivable');
  assert.deepEqual(result.rows[0].inventoryGroups, ['ansible-site']);
  assert.deepEqual(result.rows[0].candidateRequirementIds, ['REQ-OPS-001', 'REQ-OPS-002']);
});

test('rejects a typed implementation reference with no independently discovered surface', () => {
  const result = buildReverseTrace({
    discovered: [],
    obligations: [{
      requirementId: 'REQ-UI-001', obligationId: 'OBL-REQ-UI-001-O01',
      surfaceIdentifiers: [{ kind: 'nativeIosView', id: 'MissingEditorView' }], testIds: [], exactRuns: [],
    }],
  });
  assert.ok(result.violations.some(item => item.includes('Obligation surface identifier has no discovered source: nativeIosView MissingEditorView')));
});

test('reverse trace leaves new runtime surface unmapped and does not infer VERIFIED from test names', () => {
  const result = buildReverseTrace({
    discovered: { surfaces: [
      { kind: 'httpRuntimeRoute', id: 'POST /api/unknown', source: { path: 'packages/api/src/server.ts' }, provenance: 'fault injected' },
      { kind: 'httpOperation', id: 'GET /api/projects', source: { path: 'openapi.yaml' }, provenance: 'fixture' },
    ], limitations: [] },
    inventory: [],
    obligations: [{ requirementId: 'REQ-API-001', obligationId: 'REQ-API-001:O01', obligationText: 'List projects', designRefs: ['GET /api/projects'], sourceRefs: [], testIds: ['TEST-API-001'], exactRuns: [], status: 'VERIFIED' }],
  });
  assert.ok(result.gaps.some((gap) => gap.kind === 'UNMAPPED' && gap.surface.id === 'POST /api/unknown'));
  assert.ok(result.violations.some((violation) => violation.includes('POST /api/unknown')));
  assert.ok(result.rows.some((row) => row.surface.id === 'GET /api/projects' && row.status === 'MAPPED_UNVERIFIED'));
  assert.ok(result.rows.every((row) => row.status !== 'VERIFIED'));
  assert.equal(result.violations.length, 1);
});

test('preserves source inventory classification and candidate requirements without accepting a link', () => {
  const result = buildReverseTrace({
    discovered: [{ kind: 'mcpTool', id: 'draft.export', source: { path: 'modules/mcp/src/tools/draft.ts', line: 18 }, provenance: 'literal tool registration' }],
    inventory: [{ kind: 'tool', id: 'draft.export', classification: 'candidate REQ-MCP-002 / REQ-OPS-003; effect remains unverified' }],
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].status, 'UNMAPPED');
  assert.equal(result.rows[0].requirementId, undefined);
  assert.equal(result.rows[0].obligationIds.length, 0);
  assert.equal(result.rows[0].inventoryClassification, 'candidate REQ-MCP-002 / REQ-OPS-003; effect remains unverified');
  assert.deepEqual(result.rows[0].candidateRequirementIds, ['REQ-MCP-002', 'REQ-OPS-003']);
  assert.equal(result.rows[0].source.line, 18);
});

test('does not borrow classification from a different inventory surface kind', () => {
  const result = buildReverseTrace({
    discovered: [{ kind: 'mcpTool', id: 'same-name', source: { path: 'modules/mcp/src/tools.ts' }, provenance: 'tool registration' }],
    inventory: [{ kind: 'route', id: 'same-name', classification: 'candidate REQ-API-001' }],
  });

  assert.equal(result.rows[0].inventoryClassification, undefined);
  assert.deepEqual(result.rows[0].candidateRequirementIds, undefined);
  assert.equal(result.rows[0].status, 'UNMAPPED');
});

test('keeps an unassigned inventory mapping distinct from an explicit specification deviation', () => {
  const result = buildReverseTrace({
    discovered: [{ kind: 'httpOperation', id: 'PATCH /api/example', classification: 'current', source: { path: 'packages/api/src/routes.ts' }, provenance: 'admitted operation' }],
    inventory: [{ kind: 'route', id: 'PATCH /api/example', classification: 'UNMAPPED: detailed obligation mapping remains unassigned' }],
    obligations: [{
      requirementId: 'REQ-API-001', obligationId: 'OBL-REQ-API-001-O01',
      surfaceIdentifiers: [{ kind: 'httpOperation', id: 'PATCH /api/example' }], testIds: [],
    }],
  });

  assert.equal(result.rows[0].status, 'UNVERIFIED');
  assert.ok(result.gaps.some(gap => gap.kind === 'UNMAPPED' && gap.obligationId === 'OBL-REQ-API-001-O01'));
  assert.ok(!result.gaps.some(gap => gap.kind === 'DEVIATION'));
});

test('generic file provenance does not silently map every discovered surface to an obligation', () => {
  const result = buildReverseTrace({
    discovered: [{ kind: 'mcpTool', id: 'knowledge.propose', source: { path: 'modules/mcp/src/tools/knowledge.ts' }, provenance: 'fixture' }],
    obligations: [{ requirementId: 'REQ-MCP-001', obligationId: 'REQ-MCP-001:O01', designRefs: ['MCP-FIRST.md'], sourceRefs: [{ path: 'modules/mcp/src/tools/knowledge.ts' }], testIds: ['TEST-MCP-001'] }],
  });
  assert.equal(result.rows[0].status, 'UNMAPPED');
  assert.equal(result.gaps[0].kind, 'UNMAPPED');
});

test('typed A1 surface identifiers join exact HTTP, DB and UI surfaces only', async () => {
  const { surfaces } = await discoverReverseSurfaces({ repositoryRoot });
  const exact = [
    ['httpOperation', 'httpOperation', 'PATCH /api/v1/persistence/projects/{projectId}/documents/{documentId}', 'REQ-API-002'],
    ['databaseObject', 'objectId', 'document_revision_immutable', 'REQ-DATA-002'],
    ['uiControl', 'controlId', 'WRT-01.A', 'REQ-UI-002'],
  ];
  const selected = exact.map(([kind, , id]) => surfaces.find((surface) => surface.kind === kind && surface.id === id));
  assert.ok(selected.every(Boolean));
  const result = buildReverseTrace({
    discovered: selected,
    obligations: exact.map(([, identifierKind, id, requirementId], index) => ({
      requirementId,
      obligationId: `OBL-${requirementId}-O0${index + 1}`,
      designRefs: [],
      sourceRefs: [{ identifier: 'packages/api/src/persistence-routes.ts', path: 'packages/api/src/persistence-routes.ts' }],
      surfaceIdentifiers: [{ kind: identifierKind, id }],
      testIds: [`TEST-${requirementId}`],
    })),
  });
  assert.equal(result.rows.filter((row) => row.status === 'MAPPED_UNVERIFIED').length, 3);
  assert.equal(result.gaps.filter((gap) => gap.kind === 'UNMAPPED').length, 0);
  const wrongKind = buildReverseTrace({
    discovered: [selected[0]],
    obligations: [{ requirementId: 'REQ-MCP-001', obligationId: 'OBL-REQ-MCP-001-O01', surfaceIdentifiers: [{ kind: 'toolName', id: selected[0].id }], testIds: ['TEST-MCP-001'] }],
  });
  assert.equal(wrongKind.rows[0].status, 'UNMAPPED');
});

test('CI workflow surface links to the requirement only through an explicit typed identifier', async () => {
  const { surfaces } = await discoverReverseSurfaces({ repositoryRoot });
  const workflow = surfaces.find(item => item.kind === 'ciWorkflow' && item.id === '.github/workflows/verify.yml');
  assert.ok(workflow);
  const result = buildReverseTrace({
    discovered: [workflow],
    obligations: [{ requirementId: 'REQ-QUAL-002', obligationId: 'OBL-REQ-QUAL-002-O01', surfaceIdentifiers: [{ kind: 'ciWorkflow', id: workflow.id }], testIds: [], exactRuns: [] }],
  });
  assert.equal(result.rows[0].requirementId, 'REQ-QUAL-002');
  assert.equal(result.rows[0].status, 'UNVERIFIED');
  assert.equal(result.rows[0].exactRuns.length, 0);
});

test('openAPI deviations and unavailable discovery inputs stay visible', () => {
  const result = buildReverseTrace({
    discovered: {
      surfaces: [{ kind: 'httpOperation', id: 'PATCH /api/unadmitted', classification: 'unadmitted', source: { path: 'openapi.yaml' }, provenance: 'fixture' }],
      limitations: [{ area: 'runtime', reason: 'bounded scan unavailable' }],
    },
    obligations: [{ requirementId: 'REQ-API-001', obligationId: 'REQ-API-001:O02', designRefs: ['PATCH /api/unadmitted'], sourceRefs: [], testIds: [] }],
  });
  assert.ok(result.gaps.some((gap) => gap.kind === 'DEVIATION'));
  assert.ok(result.gaps.some((gap) => gap.kind === 'BLOCKED' && gap.reason === 'bounded scan unavailable'));
  assert.ok(result.gaps.some((gap) => gap.kind === 'UNVERIFIED'));
  assert.ok(!result.rows.some((row) => row.status === 'VERIFIED'));
});

test('a target API does not admit registration as a current route', () => {
  const id = 'GET /api/console/backups/config';
  const source = { path: 'packages/api/src/server.ts' };
  const result = buildReverseTrace({ discovered: [
    { kind: 'httpOperation', id, classification: 'target', source },
    { kind: 'httpRuntimeRoute', id, source },
  ] });
  assert.ok(result.rows.some(row => row.surface.kind === 'httpOperation' && row.status === 'BLOCKED'));
  assert.ok(result.violations.some(violation => violation.includes(id)));
});
