import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegularFile } from '../shared/read-regular-file.mjs';
import { stripSourceComments } from './strip-source-comments.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '../..');

async function walkFiles(root, relative, skipDirectory) {
  const absolute = path.join(root, relative);
  let entries;
  try { entries = await readdir(absolute, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirectory?.(file, entry.name)) files.push(...await walkFiles(root, file, skipDirectory));
    } else if (entry.isFile()) files.push(file);
  }
  return files;
}

function operationSurfaces(admitted, file) {
  const surfaces = [];
  const entries = [...(admitted.current ?? []).map((id) => [id, 'current']), ...(admitted.target ?? []).map((id) => [id, 'target'])];
  for (const [id, classification] of entries) {
    surfaces.push({ kind: 'httpOperation', id, classification, source: { path: file }, provenance: 'Operation from the admitted HTTP route inventory, checked against the TypeSpec/OpenAPI contract by the existing AST route test.' });
  }
  for (const pathname of admitted.betterAuthExternal?.metadataPaths ?? []) {
    surfaces.push({ kind: 'httpExternalOperation', id: `GET ${pathname}`, classification: 'approved-external-exception', source: { path: 'packages/http-contract/test/fixtures/admitted-routes.json' }, provenance: 'Explicit Better Auth external metadata route exception recorded in the existing HTTP route inventory.' });
  }
  return surfaces;
}

export function discoverMcpToolRegistrations(source) {
  const code = stripSourceComments(source);
  return [...code.matchAll(/\bserver\.(?:tool|registerTool)\s*\(/gu)].map(match => {
    const argument = code.slice(match.index + match[0].length);
    const name = /^\s*(["'])([A-Za-z][A-Za-z0-9_.-]*)\1\s*(?=[,)])/u.exec(argument)?.[2] ?? null;
    return { name, line: code.slice(0, match.index).split('\n').length };
  });
}

function mcpToolSurfaces(source, file) {
  const registrations = discoverMcpToolRegistrations(source);
  const surfaces = registrations.filter(({ name }) => name).map(({ name, line }) => ({
    kind: 'mcpTool', id: name, source: { path: file, line },
    provenance: 'Literal server.tool or server.registerTool registration in MCP source; dynamic registrations are outside this scan.',
  }));
  if (registrations.some(({ name }) => !name)) {
    surfaces.push({ kind: 'mcpRegistration', id: `dynamic:${file}`, source: { path: file }, provenance: 'A non-literal tool registration was observed; name and effect require runtime/catalog resolution.' });
  }
  return surfaces;
}

function sqlObjects(source, file) {
  const out = [];
  const pattern = /^\s*(?:CREATE\s+(?:(?:OR\s+REPLACE)\s+)?(?:UNIQUE\s+)?(?:TABLE|FUNCTION|TRIGGER|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?|ALTER\s+TABLE\s+\S+\s+ADD\s+CONSTRAINT\s+)([A-Za-z_][A-Za-z0-9_$]*)/gimu;
  for (const match of source.matchAll(pattern)) out.push({ kind: 'databaseObject', id: match[1], source: { path: file, line: source.slice(0, match.index).split('\n').length }, provenance: 'Named DDL declaration in a committed migration; not a live pg_catalog observation.' });
  return out;
}

function controlSurfaces(source, file) {
  const surfaces = [];
  for (const match of source.matchAll(/\b(?:CTRL-[A-Z0-9]+-[A-Z0-9-]+|[A-Z]{2,}-\d{2}\.[A-Z])\b/gu)) {
    surfaces.push({ kind: 'uiControl', id: match[0], source: { path: file, line: source.slice(0, match.index).split('\n').length }, provenance: 'Control ID in the normative UI control catalog or state atlas; implementation binding remains separately evidenced.' });
  }
  return surfaces;
}

function implementationControlReferences(source, file) {
  return [...source.matchAll(/\b(?:CTRL-[A-Z0-9]+-[A-Z0-9-]+|[A-Z]{2,}-\d{2}\.[A-Z])\b/gu)]
    .map((match) => ({ kind: 'uiControlBindingReference', id: match[0], source: { path: file, line: source.slice(0, match.index).split('\n').length }, provenance: 'Literal control identifier reference in application source; this is a code link only, not proof of rendered behavior or acceptance.' }));
}

function nativeIosViews(source, file) {
  const surfaces = [];
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, comment => comment.replace(/[^\r\n]/gu, ' ')).replace(/^[\t ]*\/\/.*$/gmu, '');
  const pattern = /^[\t ]*(?:public\s+|internal\s+|private\s+|fileprivate\s+)?(?:struct|class)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:[^\n{]*\bView\b/gmu;
  for (const match of code.matchAll(pattern)) {
    surfaces.push({
      kind: 'nativeIosView', id: match[1], source: { path: file, line: code.slice(0, match.index).split('\n').length },
      provenance: 'SwiftUI type declaration conforming to View; declaration presence is not physical-device or behavior acceptance.',
    });
  }
  return surfaces;
}

function terraformResources(source, file) {
  const surfaces = [];
  source = source.replace(/\/\*[\s\S]*?\*\//gu, comment => comment.replace(/[^\r\n]/gu, ' ')).replace(/^[\t ]*(?:#|\/\/).*$/gmu, '');
  const pattern = /^[\t ]*resource\s+"([A-Za-z_][A-Za-z0-9_]*)"\s+"([A-Za-z_][A-Za-z0-9_-]*)"\s*\{/gmu;
  for (const match of source.matchAll(pattern)) {
    surfaces.push({
      kind: 'iacResource', id: `${match[1]}.${match[2]}`, source: { path: file, line: source.slice(0, match.index).split('\n').length },
      provenance: 'Terraform resource declaration in the canonical Cloudflare IaC tree; source declaration does not prove applied infrastructure state.',
    });
  }
  return surfaces;
}

export async function discoverPlatformSurfaces({
  repositoryRoot = DEFAULT_ROOT,
  nativeIosRoot = 'ios',
  iacRoot = 'deploy/cloudflare/terraform',
  ansibleRoot = 'deploy/ansible',
} = {}) {
  const root = path.resolve(repositoryRoot);
  const surfaces = [];
  const limitations = [];
  const iosFiles = (await walkFiles(root, nativeIosRoot, (file, name) =>
    name === '.build' || file.endsWith('/Sources/CodexiaAPI/Generated'))).filter(file => file.includes('/Sources/') && file.endsWith('.swift'));
  for (const file of iosFiles) surfaces.push(...nativeIosViews(await readRegularFile(path.join(root, file)), file));
  if (iosFiles.length === 0) limitations.push({ area: 'native-ios', reason: `Canonical Native iOS source tree is empty: ${nativeIosRoot}` });
  limitations.push({ area: 'native-ios-runtime', reason: 'SwiftUI source declarations do not prove iOS build, physical-device behavior, IME, or acceptance execution.' });

  const terraformFiles = (await walkFiles(root, iacRoot)).filter(file => file.endsWith('.tf'));
  for (const file of terraformFiles) surfaces.push(...terraformResources(await readRegularFile(path.join(root, file)), file));
  if (terraformFiles.length === 0) limitations.push({ area: 'iac', reason: `Canonical Terraform source tree is empty: ${iacRoot}` });
  limitations.push({ area: 'iac-runtime', reason: 'Terraform declarations do not prove a plan, applied provider state, or live routing configuration.' });
  const ansibleFiles = (await walkFiles(root, ansibleRoot)).filter(file => /\.ya?ml$/u.test(file));
  for (const file of ansibleFiles) surfaces.push({
    kind: 'ansibleSource', id: file, source: { path: file },
    provenance: 'Canonical Ansible playbook or inventory source under the repository IaC tree; source presence does not prove host execution or desired-state convergence.',
  });
  if (ansibleFiles.length === 0) limitations.push({ area: 'ansible', reason: `Canonical Ansible source tree is empty: ${ansibleRoot}` });
  limitations.push({ area: 'ansible-runtime', reason: 'Ansible playbook declarations do not prove execution against a host or resulting system state.' });
  return { surfaces, limitations };
}

/** Discover source-declared surfaces from domain authorities. The output is an inventory, never a certification. */
export async function discoverReverseSurfaces({ repositoryRoot = DEFAULT_ROOT, boundedDiscovery } = {}) {
  const root = path.resolve(repositoryRoot);
  const surfaces = [];
  const limitations = [];
  const openapiPath = 'packages/http-contract/openapi/codexia.openapi.yaml';
  const admittedPath = 'packages/http-contract/test/fixtures/admitted-routes.json';
  try {
    const admitted = JSON.parse(await readRegularFile(path.join(root, admittedPath)));
    await readRegularFile(path.join(root, openapiPath));
    surfaces.push(...operationSurfaces(admitted, admittedPath));
  } catch {
    limitations.push({ area: 'http', reason: 'Generated OpenAPI/admitted route inventory is missing; no contract operations inferred.' });
  }

  const generatedContractPath = 'packages/api/src/generated/http-contract.json';
  try {
    const generated = JSON.parse(await readRegularFile(path.join(root, generatedContractPath)));
    for (const route of generated.routes ?? []) {
      const id = `${route.method} ${route.url.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, '{$1}')}`;
      if (route.contractStatus === 'target') continue;
      surfaces.push({ kind: 'httpRuntimeRoute', id, operationId: route.operationId, contractStatus: route.contractStatus, source: { path: 'packages/api/src/http-contract.ts' }, provenance: `Generated Fastify registration (${generatedContractPath}) with operationId ${route.operationId}; server registration resolves handlers by operationId and fails closed when a handler is missing.` });
    }
  } catch {
    limitations.push({ area: 'http', reason: `Generated Fastify HTTP contract is missing or invalid: ${generatedContractPath}` });
  }
  if (boundedDiscovery?.routes) {
    for (const id of boundedDiscovery.routes) {
      const deniedBoundary = id === 'ANY /api/auth/token';
      const delegatedMetadata = id === 'GET /.well-known/oauth-authorization-server/api/auth' || id === 'GET /.well-known/openid-configuration/api/auth';
      const classification = deniedBoundary ? 'explicitly-rejected-boundary' : delegatedMetadata ? 'delegated-better-auth-metadata' : 'bounded-source-discovery';
      const reason = deniedBoundary ? 'Server explicitly rejects generic Better Auth token issuance at /api/auth/token.' : delegatedMetadata ? 'Route is listed under the admitted HTTP inventory Better Auth external metadata paths.' : 'Existing bounded StrictDoc source discovery; parser scope is partial and this is not a complete runtime route inventory.';
      surfaces.push({ kind: 'httpBoundedRoute', id, classification, source: { path: 'scripts/strictdoc/surface-inventory.json' }, provenance: reason });
    }
    limitations.push({ area: 'http-bounded', reason: 'Existing bounded route scan includes static literal families only; dynamically supplied module contribution registrations remain unexpanded.' });
  }

  const mcpFiles = (await walkFiles(root, 'modules/mcp/src')).filter((file) => /\.tsx?$/u.test(file));
  for (const file of mcpFiles) surfaces.push(...mcpToolSurfaces(await readRegularFile(path.join(root, file)), file));
  if (mcpFiles.length === 0) limitations.push({ area: 'mcp', reason: 'MCP source tree is unavailable.' });
  else limitations.push({ area: 'mcp-effect', reason: 'Per-tool effects and transport registration are not completely available as an authoritative static manifest; source tool names and existing effect tests do not certify the full action catalog.' });

  const migrationFiles = (await walkFiles(root, 'packages/persistence-postgres/migrations')).filter((file) => file.endsWith('.sql'));
  for (const file of migrationFiles) surfaces.push(...sqlObjects(await readRegularFile(path.join(root, file)), file));
  if (migrationFiles.length === 0) limitations.push({ area: 'database', reason: 'Migration source directory is unavailable.' });
  try {
    const catalogPath = 'packages/persistence-postgres/tests/db-contract/catalog-contract.json';
    const catalog = JSON.parse(await readRegularFile(path.join(root, catalogPath)));
    for (const relation of catalog.relations ?? []) surfaces.push({ kind: 'databaseCatalogObject', id: `${relation.schema}.${relation.name}`, source: { path: catalogPath }, provenance: 'Committed observed catalog contract consumed by database contract checks; not a live database observation in this run.' });
  } catch {
    limitations.push({ area: 'database', reason: 'Committed db-contract catalog snapshot is unavailable.' });
  }
  limitations.push({ area: 'database-live', reason: 'No live pg_catalog observation is available in this source-only trace; committed catalog contract is a comparison baseline, not runtime proof.' });

  for (const file of ['docs/design/SCREEN-CONTROL-CATALOG.md', 'docs/design/SCREEN-STATE-ATLAS.md']) {
    try { surfaces.push(...controlSurfaces(await readRegularFile(path.join(root, file)), file)); }
    catch { limitations.push({ area: 'ui', reason: `${file} is missing.` }); }
  }
  const appFiles = (await walkFiles(root, 'app/src', file =>
    file === 'app/src/generated/http' || file === 'app/src/generated/auth-methods')).filter((file) => /\.(tsx|jsx|ts|js)$/u.test(file) && !/\.test\./u.test(file));
  for (const file of appFiles) surfaces.push(...implementationControlReferences(await readRegularFile(path.join(root, file)), file));
  limitations.push({ area: 'ui-runtime', reason: 'A source control-ID reference does not prove rendered UI behavior; browser acceptance and explicit control bindings are required for runtime UI evidence.' });

  const workflowFiles = (await walkFiles(root, '.github/workflows')).filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'));
  for (const file of workflowFiles) surfaces.push({ kind: 'ciWorkflow', id: file, source: { path: file }, provenance: 'Checked-in GitHub Actions workflow definition; source presence does not prove a job ran, passed, or certified an obligation.' });
  if (workflowFiles.length === 0) limitations.push({ area: 'ci', reason: 'GitHub Actions workflow directory is unavailable.' });
  else limitations.push({ area: 'ci-runtime', reason: 'Workflow source is not a run result. The exact-source task, job, attempt, and artifact certification remain in the existing execution evidence.' });

  const platform = await discoverPlatformSurfaces({ repositoryRoot: root });
  surfaces.push(...platform.surfaces);
  limitations.push(...platform.limitations);

  const operationalFiles = ['deploy/backup/backup.sh', 'deploy/backup/s3_transfer.py'];
  for (const file of operationalFiles) {
    try {
      await readRegularFile(path.join(root, file));
      surfaces.push({ kind: file.startsWith('deploy/backup/') || file.includes('backup') || file.includes('restore') ? 'backupInterface' : 'deploymentInterface', id: file, source: { path: file }, provenance: 'Canonical protected deployment/backup entrypoint; file presence does not prove execution, host state, or restore evidence.' });
    } catch {
      limitations.push({ area: 'operations', reason: `Canonical operational entrypoint is missing: ${file}` });
    }
  }
  limitations.push({ area: 'deployment-runtime', reason: 'Repository workflow/Ansible sources do not prove host execution, deployment state, OCI identity, or operator acceptance.' });
  limitations.push({ area: 'backup-receipt', reason: 'S3 transfer sources do not provide a run-bound independent backup receipt or isolated restore result for this trace.' });
  if (operationalFiles.length === 0) limitations.push({ area: 'operations', reason: 'Deployment and backup entrypoint directories are unavailable.' });

  if (boundedDiscovery) {
    for (const [bucket, kind] of [['tools', 'mcpRuntimeTool'], ['databaseObjects', 'databaseMigrationObject']]) {
      for (const id of boundedDiscovery[bucket] ?? []) surfaces.push({ kind, id, source: { path: 'scripts/strictdoc/surface-inventory.json' }, provenance: 'Existing bounded source discovery from StrictDoc verifier; its declared scope remains partial.' });
    }
  }
  const unique = new Map();
  for (const surface of surfaces) unique.set(`${surface.kind}\0${surface.id}\0${surface.source.path}\0${surface.source.line ?? ''}`, surface);
  return { surfaces: [...unique.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id) || a.source.path.localeCompare(b.source.path)), limitations };
}

function surfaceKindMatches(referenceKind, surfaceKind) {
  if (referenceKind === 'httpOperation') return surfaceKind === 'httpOperation';
  if (referenceKind === 'routeId') return ['httpOperation', 'httpRuntimeRoute', 'httpBoundedRoute'].includes(surfaceKind);
  if (referenceKind === 'toolName') return ['mcpTool', 'mcpRuntimeTool'].includes(surfaceKind);
  if (referenceKind === 'objectId') return ['databaseObject', 'databaseCatalogObject', 'databaseMigrationObject'].includes(surfaceKind);
  if (referenceKind === 'controlId') return ['uiControl', 'uiControlBindingReference'].includes(surfaceKind);
  if (referenceKind === 'nativeIosView') return surfaceKind === 'nativeIosView';
  if (referenceKind === 'iacResource') return surfaceKind === 'iacResource';
  if (referenceKind === 'ansibleSource') return surfaceKind === 'ansibleSource';
  if (referenceKind === 'ciWorkflow') return surfaceKind === 'ciWorkflow';
  if (referenceKind === 'surfaceId') return true;
  if (referenceKind === 'identifier') return true;
  return false;
}

function isExactSurfaceReference(value, surface) {
  if (typeof value === 'string') return value.trim() === surface.id;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.id === surface.id && surfaceKindMatches(value.kind, surface.kind)) return true;
  const surfaceIds = Array.isArray(value.surfaceIdentifiers) ? value.surfaceIdentifiers : [];
  if (surfaceIds.some((item) => item && item.id === surface.id && surfaceKindMatches(item.kind, surface.kind))) return true;
  const typedKeys = [
    ['routeId', 'routeId'], ['toolName', 'toolName'],
    ['objectId', 'objectId'], ['controlId', 'controlId'], ['surfaceId', 'surfaceId'],
  ];
  return typedKeys.some(([key, kind]) => value[key] === surface.id && surfaceKindMatches(kind, surface.kind));
}

function inventoryKindMatches(surfaceKind, inventoryKind) {
  if (['httpOperation', 'httpRuntimeRoute', 'httpBoundedRoute', 'httpExternalOperation'].includes(surfaceKind)) return inventoryKind === 'route';
  if (['mcpTool', 'mcpRuntimeTool'].includes(surfaceKind)) return inventoryKind === 'tool';
  if (['databaseObject', 'databaseCatalogObject', 'databaseMigrationObject'].includes(surfaceKind)) return inventoryKind === 'databaseObject';
  if (surfaceKind === 'nativeIosView') return inventoryKind === 'nativeIosView';
  if (surfaceKind === 'iacResource') return inventoryKind === 'iacResource';
  if (surfaceKind === 'ansibleSource') return inventoryKind === 'ansibleSource';
  return false;
}

/** Relate discovered runtime/design surfaces to registered obligations without promoting conformance. */
export function buildReverseTrace({ discovered = [], inventory = [], obligations = [], limitations = [] } = {}) {
  const surfaces = Array.isArray(discovered) ? discovered : discovered.surfaces ?? [];
  const reportedLimitations = Array.isArray(discovered) ? limitations : discovered.limitations ?? limitations;
  const rows = [];
  const gaps = [];
  const violations = [];
  const inventoryEntries = Array.isArray(inventory) ? inventory : inventory.classifications ?? [];
  const registered = [...obligations];
  const admittedHttpOperations = new Set(surfaces.filter(surface =>
    (surface.kind === 'httpOperation' && surface.classification === 'current') ||
    surface.kind === 'httpExternalOperation'
  ).map(surface => surface.id));

  for (const surface of surfaces) {
    const references = registered.filter((obligation) => {
      // File paths/ranges are provenance, not semantic surface mappings.
      return [...(obligation.designRefs ?? []), ...(obligation.sourceRefs ?? []), ...(obligation.surfaceIdentifiers ?? [])]
        .some((reference) => isExactSurfaceReference(reference, surface));
    });
    const kindMatches = inventoryEntries.filter((entry) => inventoryKindMatches(surface.kind, entry.kind) && (entry.id === surface.id || entry.id === `${surface.kind} ${surface.id}`));
    const inventoryClassification = kindMatches[0]?.classification;
    const candidateRequirementIds = [...new Set((inventoryClassification?.match(/REQ-[A-Z]+-\d{3}/gu) ?? []))];
    const classificationFields = {
      ...(inventoryClassification ? { inventoryClassification } : {}),
      ...(candidateRequirementIds.length ? { candidateRequirementIds } : {}),
    };
    const provenance = surface.provenance ?? 'Source discovery provided without provenance.';
    if (surface.kind === 'httpRuntimeRoute' && (surface.classification === 'unadmitted' || !admittedHttpOperations.has(surface.id))) {
      violations.push(`Runtime HTTP operation is absent from the admitted HTTP inventory: ${surface.id} (${surface.source?.path ?? 'source unknown'})`);
      gaps.push({ kind: 'DEVIATION', surface: { kind: surface.kind, id: surface.id }, provenance, source: surface.source, reason: 'Runtime HTTP operation is absent from the admitted HTTP inventory.' });
    }
    if (surface.kind === 'httpBoundedRoute' && !admittedHttpOperations.has(surface.id) && !['delegated-better-auth-metadata', 'explicitly-rejected-boundary'].includes(surface.classification)) {
      gaps.push({ kind: 'UNMAPPED', surface: { kind: surface.kind, id: surface.id }, provenance, source: surface.source, reason: 'Bounded scan result lacks an exact admitted HTTP operation match; treated as partial discovery.' });
    }
    if (['unadmitted', 'missing-from-contract', 'missing-from-openapi'].includes(surface.classification)) {
      gaps.push({ kind: 'DEVIATION', surface: { kind: surface.kind, id: surface.id }, provenance, source: surface.source, reason: `Contract inventory classification is ${surface.classification}.` });
    }
    if (references.length === 0) {
      const state = surface.classification === 'target' || surface.classification?.startsWith('missing-from-') ? 'BLOCKED' : 'UNMAPPED';
      const gap = { kind: state, surface: { kind: surface.kind, id: surface.id }, provenance, source: surface.source, ...classificationFields, classification: surface.classification };
      gaps.push(gap);
      rows.push({ ...gap, ...classificationFields, ...(surface.operationId ? { operationId: surface.operationId } : {}), ...(surface.contractStatus ? { contractStatus: surface.contractStatus } : {}), obligationIds: [], status: state });
      continue;
    }
    for (const obligation of references) {
      const ids = obligation.testIds ?? [];
      const exactRuns = obligation.exactRuns ?? [];
      const status = surface.classification === 'target' ? 'BLOCKED' : ids.length === 0 ? 'UNVERIFIED' : 'MAPPED_UNVERIFIED';
      rows.push({ surface: { kind: surface.kind, id: surface.id }, obligationId: obligation.obligationId, requirementId: obligation.requirementId, provenance, source: surface.source, ...classificationFields, ...(surface.operationId ? { operationId: surface.operationId } : {}), ...(surface.contractStatus ? { contractStatus: surface.contractStatus } : {}), testIds: ids, exactRuns, status });
      if (surface.classification === 'target') gaps.push({ kind: 'BLOCKED', surface: { kind: surface.kind, id: surface.id }, obligationId: obligation.obligationId, provenance, source: surface.source, reason: 'Contract marks this operation as a target, not a current runtime obligation.' });
      if (ids.length === 0) gaps.push({ kind: 'UNVERIFIED', surface: { kind: surface.kind, id: surface.id }, obligationId: obligation.obligationId, provenance, source: surface.source, reason: 'No verification scenario is registered for this linked obligation.' });
      const inventoryGap = kindMatches.find((item) => /\b(?:DEVIATION|UNMAPPED|BLOCKED)\b/iu.test(item.classification ?? ''));
      if (inventoryGap) {
        const classification = inventoryGap.classification;
        const kind = /\bDEVIATION\b/iu.test(classification) ? 'DEVIATION' : /\bBLOCKED\b/iu.test(classification) ? 'BLOCKED' : 'UNMAPPED';
        const reason = kind === 'DEVIATION'
          ? 'Source inventory explicitly classifies this relation as a specification deviation.'
          : kind === 'BLOCKED'
            ? 'Source inventory explicitly classifies this relation as blocked.'
            : 'Source inventory records that the detailed obligation mapping remains unassigned.';
        gaps.push({ kind, surface: { kind: surface.kind, id: surface.id }, obligationId: obligation.obligationId, provenance, classification, reason });
      }
    }
  }
  for (const limitation of reportedLimitations) gaps.push({ kind: 'BLOCKED', provenance: 'Discovery limitation', ...limitation });
  for (const obligation of registered) {
    if (!obligation.requirementId || !obligation.obligationId) violations.push(`Obligation row lacks requirementId or obligationId: ${JSON.stringify(obligation)}`);
    for (const reference of obligation.surfaceIdentifiers ?? []) {
      if (!surfaces.some(surface => surface.id === reference.id && surfaceKindMatches(reference.kind, surface.kind))) {
        violations.push(`Obligation surface identifier has no discovered source: ${reference.kind} ${reference.id}`);
      }
    }
  }
  if (rows.some((row) => row.status === 'VERIFIED')) violations.push('Reverse trace cannot certify VERIFIED; only the project certifier may assign that status.');
  return { rows, gaps, violations };
}
