import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildReverseTrace, discoverReverseSurfaces } from './reverse-trace.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('reverse discovery records authority and provenance for HTTP, MCP, DB, UI and operational surfaces', async () => {
  const { surfaces, limitations } = await discoverReverseSurfaces({ repositoryRoot });
  assert.ok(surfaces.some((item) => item.kind === 'httpOperation' && item.id === 'GET /api/projects'));
  assert.ok(surfaces.some((item) => item.kind === 'mcpTool' && item.id === 'list_projects'));
  assert.ok(surfaces.some((item) => item.kind === 'databaseCatalogObject' && item.id === 'public.project'));
  assert.ok(surfaces.some((item) => item.kind === 'uiControl' && item.id === 'WRT-01.A'));
  assert.ok(surfaces.some((item) => item.kind === 'backupInterface' && item.id === 'deploy/backup/backup.sh'));
  assert.ok(surfaces.every((item) => item.provenance && item.source?.path));
  assert.deepEqual(new Set(limitations.map((item) => item.area)), new Set(['mcp-effect', 'database-live', 'ui-runtime', 'deployment-runtime', 'backup-receipt']));
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
