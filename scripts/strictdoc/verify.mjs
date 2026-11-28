import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRegularFile } from '../shared/read-regular-file.mjs';
import { associateTraceCases } from './case-results.mjs';
import { discoverTestSources } from './test-sources.mjs';
import { buildObligationTrace, testIdReferences, TEST_ID } from './obligation-trace.mjs';
import { buildReverseTrace, discoverMcpToolRegistrations, discoverPlatformSurfaces, discoverReverseSurfaces } from './reverse-trace.mjs';
import { discoverAnsibleSourceGraph } from './ansible-source-graph.mjs';
import { stripSourceComments } from './strip-source-comments.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const EXPECTED_STRICTDOC_VERSION = '0.32.1';
const REGISTER_PATH = 'docs/requirements/REQUIREMENT-REGISTER.sdoc';
const CONFIG_PATH = 'scripts/strictdoc/strictdoc_config.py';
const TRACE_NODE_TYPES = new Set(['REQUIREMENT', 'OBLIGATION', 'TEST']);
const DECISION_STATES = new Set(['ACCEPTED', 'PROPOSED', 'RETIRED']);
const CONFORMANCE_STATES = new Set([
  'UNMAPPED', 'MAPPED_UNVERIFIED', 'PARTIAL', 'DEVIATION', 'BLOCKED', 'VERIFIED', 'NOT_APPLICABLE',
]);
const EXECUTION_SCOPES = new Set(['TRACE_NODE', 'TRACE_BROWSER', 'PRODUCT']);
const APPLICABILITY_STATES = new Set(['CURRENT', 'FUTURE_TARGET', 'RETIRED']);

export function deterministicMid(uid) {
  return createHash('sha256').update(uid, 'utf8').digest('hex').slice(0, 32);
}

export function validateRequirementNodes(nodes) {
  const violations = [];
  const uidCounts = new Map();
  const midCounts = new Map();
  for (const node of nodes) {
    const uid = node.UID;
    const mid = node.MID;
    if (typeof uid !== 'string' || !/^REQ-[A-Z]+-\d{3}$/u.test(uid)) {
      violations.push(`Invalid requirement UID: ${String(uid)}`);
      continue;
    }
    uidCounts.set(uid, (uidCounts.get(uid) ?? 0) + 1);
    if (typeof mid !== 'string' || !/^[0-9a-f]{32}$/u.test(mid) || mid !== deterministicMid(uid)) {
      violations.push(`MID for ${uid} is missing, malformed, or not the deterministic SHA-256 prefix`);
    }
    if (typeof mid === 'string') midCounts.set(mid, (midCounts.get(mid) ?? 0) + 1);
    if (typeof node.TITLE !== 'string' || node.TITLE.trim() === '') violations.push(`Missing title for ${uid}`);
    if (!DECISION_STATES.has(node.DECISION_STATUS)) violations.push(`Invalid decision status for ${uid}`);
    if (!CONFORMANCE_STATES.has(node.CONFORMANCE_STATUS)) violations.push(`Invalid conformance status for ${uid}`);
    if (node.CONFORMANCE_STATUS === 'VERIFIED') {
      violations.push(`${uid} cannot be VERIFIED without authenticated product obligation evidence`);
    }
    if (!APPLICABILITY_STATES.has(node.APPLICABILITY)) violations.push(`Invalid applicability for ${uid}`);
    if (typeof node.STATEMENT !== 'string' || node.STATEMENT.trim() === '') violations.push(`Missing statement for ${uid}`);
  }
  for (const [uid, count] of uidCounts) {
    if (count > 1) violations.push(`Duplicate UID ${uid} (${count} nodes)`);
  }
  for (const [mid, count] of midCounts) {
    if (count > 1) violations.push(`Duplicate MID ${mid} (${count} nodes)`);
  }
  return violations;
}

/** Project gate observations without promoting partial evidence to a product verdict. */
export function projectTraceabilityGates({ requirementNodes, obligationTrace, reverseTrace, caseExecutions, run, publisherStatus = 'NOT_PUBLISHED' }) {
  const byId = new Map(caseExecutions.map(item => [item.testId, item]));
  const required = requirementNodes.flatMap(testIdReferences);
  const unresolvedCases = required.filter(id => byId.get(id)?.result !== 'PASSED');
  const hasTraceFailures = obligationTrace.violations.length > 0 || reverseTrace.violations.length > 0;
  const gapCount = obligationTrace.gaps.length + reverseTrace.gaps.length;
  const blockers = reverseTrace.gaps.filter(gap => gap.kind === 'BLOCKED');
  const runStatus = run.status === 'IN_PROGRESS' ? 'OBSERVED_PENDING_ARTIFACT_CERTIFICATION' : 'NOT_RUN';
  return {
    G0: { status: 'PARTIAL', evidence: 'StrictDoc parse, UID/relation validation, and deterministic HTML/JSON export passed. This task does not authenticate the remaining G0 checks.' },
    G1: { status: 'NOT_RUN', evidence: 'No TypeSpec/OpenAPI runtime contract gate is authenticated by this trace task.' },
    G2: { status: 'NOT_RUN', evidence: 'No isolated HTTP/MCP runtime contract execution is authenticated by this trace task.' },
    G3: { status: 'NOT_RUN', evidence: 'No live database catalog or migration execution is authenticated by this trace task.' },
    G4: { status: 'NOT_RUN', evidence: 'No product UI/host acceptance execution is authenticated by this trace task.' },
    G5: { status: 'NOT_RUN', evidence: 'No authenticated LikeC4 validation or Threagile risk analysis is included in this trace producer run.' },
    G6: { status: 'NOT_RUN', evidence: 'No performance execution is authenticated by this trace task.' },
    G7: { status: hasTraceFailures ? 'BLOCKED' : 'PARTIAL',
      runStatus, publisherStatus, unresolvedCases, gapCount, blockers,
      evidence: 'Requirement/source/test relations are projections. Verify certification authenticates the trace artifact. Product cases without matching execution evidence remain NOT_RUN.' },
  };
}

export async function validateRelations(nodes, repositoryRoot) {
  const violations = [];
  const root = await realpath(repositoryRoot);
  for (const node of nodes) {
    for (const relation of node.RELATIONS ?? []) {
      if (relation.TYPE !== 'File') continue;
      const relativePath = relation.VALUE ?? relation.PATH;
      if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
        violations.push(`${node.UID}: File relation must use a repository-relative path`);
        continue;
      }
      const resolved = path.resolve(root, relativePath);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        violations.push(`${node.UID}: File relation escapes repository: ${relativePath}`);
        continue;
      }
      let source;
      try {
        source = await realpath(resolved);
      } catch {
        violations.push(`${node.UID}: File relation target is missing: ${relativePath}`);
        continue;
      }
      if (!source.startsWith(`${root}${path.sep}`)) {
        violations.push(`${node.UID}: File relation resolves outside repository: ${relativePath}`);
        continue;
      }
      if (!(await lstat(source)).isFile()) {
        violations.push(`${node.UID}: File relation target is not a file: ${relativePath}`);
      }
      if (relation.LINE_RANGE !== undefined) {
        violations.push(`${node.UID}: Authored line range is forbidden for ${relativePath}`);
      }
    }
  }
  return violations;
}

export function validateObligationDesignRefs(nodes, registerPath, repositoryRoot) {
  const from = path.posix.dirname(registerPath);
  const withRelations = nodes.map(node => ({
    UID: node.UID,
    RELATIONS: String(node.DESIGN_REFERENCE ?? '').split(/[;、]/u).map(reference => reference.trim()).filter(Boolean).map(reference => {
      const link = /^\[[^\]]+\]\(([^)]+)\)$/u.exec(reference);
      const [, target] = link ?? ['', reference];
      const [file] = target.split('#');
      const value = link && !path.posix.isAbsolute(file) ? path.posix.join(from, file) : file;
      return { TYPE: 'File', VALUE: value };
    }),
  }));
  return validateRelations(withRelations, repositoryRoot);
}

export function validateScenarioNodes(scenarios, requirements, testSources) {
  const violations = [];
  const requirementByUid = new Map(requirements.map((node) => [node.UID, node]));
  const parentsByTest = new Map();
  for (const scenario of scenarios) {
    const uid = scenario.UID;
    if (typeof uid !== 'string' || !TEST_ID.test(uid)) {
      violations.push(`Invalid test scenario UID: ${String(uid)}`);
      continue;
    }
    if (parentsByTest.has(uid)) violations.push(`Duplicate test scenario UID ${uid}`);
    if (scenario.MID !== deterministicMid(uid)) violations.push(`MID for ${uid} is not deterministic`);
    if (!EXECUTION_SCOPES.has(scenario.EXECUTION_SCOPE)) violations.push(`${uid} has invalid Execution scope`);
    if (scenario.EXACT_RUN_REFERENCE !== 'NOT_RUN') {
      violations.push(`${uid} authored Exact-run reference must be NOT_RUN; observed runs are attached in Verify evidence`);
    }
    const parentRelations = (scenario.RELATIONS ?? []).filter((relation) => relation.TYPE === 'Parent');
    parentsByTest.set(uid, parentRelations[0]?.VALUE);
    if (parentRelations.length === 0) violations.push(`${uid} is missing a parent requirement`);
    if (parentRelations.length > 1) violations.push(`${uid} has multiple parent requirements`);
    for (const relation of parentRelations) {
      const parent = requirementByUid.get(relation.VALUE);
      if (!parent) {
        violations.push(`${uid} points to unknown parent requirement ${relation.VALUE}`);
        continue;
      }
      if (!testIdReferences(parent).includes(uid)) violations.push(`${uid} is not declared by parent requirement ${relation.VALUE}`);
    }
    if ((scenario.RELATIONS ?? []).some(relation => relation.TYPE === 'File')) {
      violations.push(`${uid} test File relations must be derived from the native registration`);
    }
    const source = testSources.get(uid);
    if (!source) violations.push(`${uid} has no native test registration`);
    else if (['TRACE_NODE', 'TRACE_BROWSER'].includes(scenario.EXECUTION_SCOPE) && source.runner !== 'node') {
      violations.push(`${uid} must register with node:test in ${scenario.EXECUTION_SCOPE}`);
    }
  }
  for (const requirement of requirements) {
    const ids = testIdReferences(requirement);
    if (new Set(ids).size !== ids.length) violations.push(`${requirement.UID} contains duplicate TEST-ID references`);
    for (const id of ids) {
      if (!TEST_ID.test(id)) violations.push(`${requirement.UID} has invalid TEST-ID ${id}`);
      else if (!parentsByTest.has(id)) violations.push(`${requirement.UID} declares missing test scenario ${id}`);
      else if (parentsByTest.get(id) !== requirement.UID) violations.push(`${requirement.UID} declares ${id} parented by ${parentsByTest.get(id) ?? 'no requirement'}`);
    }
  }
  for (const id of testSources.keys()) {
    if (!parentsByTest.has(id)) violations.push(`Native test registration refers to unknown TEST-ID ${id}`);
  }
  return [...new Set(violations)];
}

export function validateInventory(discovered, classifications, ansibleProjection = { surfaces: [], violations: [] }) {
  const violations = [];
  const classificationByKey = new Map();
  for (const entry of classifications) {
    const key = `${entry.kind}\0${entry.id}`;
    if (classificationByKey.has(key)) violations.push(`Duplicate inventory classification for ${entry.kind} ${entry.id}`);
    classificationByKey.set(key, entry);
    if (typeof entry.classification !== 'string' || entry.classification.trim() === '') {
      violations.push(`Missing classification for ${entry.kind} ${entry.id}`);
    }
  }

  const kindMap = {
    routes: 'route', tools: 'tool', databaseObjects: 'databaseObject',
    nativeIosViews: 'nativeIosView', iacResources: 'iacResource',
  };
  for (const [bucket, kind] of Object.entries(kindMap)) {
    for (const id of discovered[bucket] ?? []) {
      const entry = classificationByKey.get(`${kind}\0${id}`);
      if (!entry || typeof entry.classification !== 'string' || entry.classification.trim() === '') {
        violations.push(`Unclassified ${kind} ${id}`);
      }
    }
  }
  for (const entry of classifications) {
    const hasDiscoveredSurface = Object.entries(kindMap).some(([bucket, kind]) => kind === entry.kind && (discovered[bucket] ?? []).includes(entry.id));
    if (!hasDiscoveredSurface) {
      violations.push(`Stale inventory classification for ${entry.kind} ${entry.id}`);
    }
  }

  const projectedAnsibleFiles = new Set((ansibleProjection.surfaces ?? []).map(surface => surface.id));
  for (const file of discovered.ansibleFiles ?? []) {
    if (!projectedAnsibleFiles.has(file)) violations.push(`Unclassified ansibleSource ${file}`);
  }
  for (const file of projectedAnsibleFiles) {
    if (!(discovered.ansibleFiles ?? []).includes(file)) violations.push(`Stale Ansible source projection ${file}`);
  }
  violations.push(...(ansibleProjection.violations ?? []));
  if (classifications.some(entry => entry.kind === 'ansibleSource')) {
    violations.push('Per-file ansibleSource classifications are not supported; classify Ansible source groups instead.');
  }
  return violations;
}

function discoverGeneratedContractRoutes(source) {
  let contract;
  try {
    contract = JSON.parse(source);
  } catch (error) {
    throw new Error(`Generated Fastify route artifact is not valid JSON: ${error.message}`, { cause: error });
  }
  if (!contract || !Array.isArray(contract.routes)) throw new Error('Generated Fastify route artifact must contain a routes array');
  const routes = [];
  for (const route of contract.routes) {
    if (!route || typeof route.method !== 'string' || typeof route.url !== 'string' || typeof route.operationId !== 'string') {
      throw new Error('Generated Fastify route entry must include method, url, and operationId');
    }
    if (!/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE)$/u.test(route.method)) {
      throw new Error(`Unsupported HTTP method in generated Fastify route artifact: ${route.method}`);
    }
    routes.push(`${route.method} ${route.url.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, '{$1}')}`);
  }
  return routes;
}

function discoverMcpToolNames(source) {
  return discoverMcpToolRegistrations(source).map(({ name }) => {
    if (!name) throw new Error('MCP tool registration must use a literal tool name in the supported inventory scope');
    return name;
  });
}

function qualifySqlObject(identifier) {
  if (!/^(?:[A-Za-z_][A-Za-z0-9_$]*\.)?[A-Za-z_][A-Za-z0-9_$]*$/u.test(identifier)) {
    throw new Error(`Unsupported SQL object identifier in bounded migration: ${identifier}`);
  }
  return identifier.includes('.') ? identifier : `public.${identifier}`;
}

function maskSqlLiterals(source) {
  const characters = source.split('');
  const mask = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' ';
    }
  };
  for (let index = 0; index < source.length;) {
    if (source[index] === "'") {
      const start = index++;
      while (index < source.length) {
        if (source[index] === '\\') index += 2;
        else if (source[index] === "'" && source[index + 1] === "'") index += 2;
        else if (source[index] === "'") { index += 1; break; }
        else index += 1;
      }
      mask(start, Math.min(index, source.length));
      continue;
    }
    if (source[index] === '$' && (index === 0 || !/[A-Za-z0-9_$]/u.test(source[index - 1]))) {
      const delimiter = /^\$[A-Za-z0-9_]*\$/u.exec(source.slice(index))?.[0];
      if (delimiter) {
        const start = index;
        const endDelimiter = source.indexOf(delimiter, index + delimiter.length);
        if (endDelimiter < 0) throw new Error(`Unterminated SQL dollar-quoted body ${delimiter}`);
        index = endDelimiter + delimiter.length;
        mask(start, index);
        continue;
      }
    }
    index += 1;
  }
  return characters.join('');
}

function discoverSqlObjects(source) {
  const objects = [];
  const identifier = '[A-Za-z_][A-Za-z0-9_$]*(?:\\.[A-Za-z_][A-Za-z0-9_$]*)?';
  const createPattern = new RegExp(`^\\s*CREATE\\s+(?:(?:OR\\s+REPLACE)\\s+)?(?:UNIQUE\\s+)?(TABLE|FUNCTION|TRIGGER|INDEX)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})\\b`, 'iu');
  const constraintPattern = new RegExp(`^\\s*ALTER\\s+TABLE\\s+(${identifier})\\s+ADD\\s+CONSTRAINT\\s+(${identifier})\\b`, 'iu');
  const lines = maskSqlLiterals(stripSourceComments(source)).split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (!/^\s*(?:CREATE|ALTER|DROP)\b/iu.test(line)) continue;
    const create = createPattern.exec(line);
    if (create) {
      const objectName = qualifySqlObject(create[2]);
      if (create[1].toUpperCase() === 'FUNCTION') {
        if (!/^\s*\(\s*\)/u.test(line.slice(create[0].length))) {
          throw new Error(`Unsupported SQL function signature in bounded migration at line ${index + 1}`);
        }
        objects.push(`${objectName}()`);
      } else objects.push(objectName);
      continue;
    }
    if (/^\s*ALTER\b/iu.test(line) && !line.includes(';')) {
      while (index + 1 < lines.length && !line.includes(';')) line += `\n${lines[++index]}`;
    }
    const constraint = constraintPattern.exec(line);
    if (constraint) {
      const table = qualifySqlObject(constraint[1]);
      const name = qualifySqlObject(constraint[2]);
      objects.push(`${table}.${name.slice(name.lastIndexOf('.') + 1)}`);
      continue;
    }
    throw new Error(`Unsupported SQL object declaration in bounded migration at line ${index + 1}: ${line.trim()}`);
  }
  return objects;
}

async function readScopedSourceFiles(root, paths, kind) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error(`Inventory scope must list at least one ${kind} source file`);
  const repositoryRoot = await realpath(root);
  const seen = new Set();
  const files = [];
  for (const relativePath of paths) {
    if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
      throw new Error(`Inventory ${kind} source must use a repository-relative path`);
    }
    const normalized = relativePath.split(path.sep).join('/');
    if (seen.has(normalized)) throw new Error(`Duplicate inventory ${kind} source: ${normalized}`);
    seen.add(normalized);
    const absolutePath = path.resolve(repositoryRoot, relativePath);
    if (absolutePath !== repositoryRoot && !absolutePath.startsWith(`${repositoryRoot}${path.sep}`)) {
      throw new Error(`Inventory ${kind} source escapes the repository: ${relativePath}`);
    }
    const message = `Inventory ${kind} source is missing or not a repository file: ${relativePath}`;
    try {
      const sourcePath = await realpath(absolutePath);
      if (!sourcePath.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error(message);
      const source = await readRegularFile(sourcePath, { message });
      files.push({ relativePath: normalized, source });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw new Error(message, { cause: error });
      throw error;
    }
  }
  return files;
}

export async function discoverSourceInventory(root, scope, inventory = {}) {
  const routeFiles = await readScopedSourceFiles(root, scope?.routes, 'route');
  const toolFiles = await readScopedSourceFiles(root, scope?.tools, 'tool');
  const databaseFiles = await readScopedSourceFiles(root, scope?.databaseObjects, 'database object');
  const ansibleProjection = await discoverAnsibleSourceGraph({
    repositoryRoot: root,
    ansibleRoot: scope?.ansible,
    groups: inventory.ansibleGroups ?? [],
    overrides: inventory.ansibleOverrides ?? [],
  });
  const platform = await discoverPlatformSurfaces({
    repositoryRoot: root,
    nativeIosRoot: scope?.nativeIos,
    iacRoot: scope?.iac,
    ansibleRoot: scope?.ansible,
    ansibleProjection,
  });
  const discovered = {
    routes: routeFiles.flatMap(({ source }) => discoverGeneratedContractRoutes(source)),
    tools: toolFiles.flatMap(({ source }) => discoverMcpToolNames(source)),
    databaseObjects: databaseFiles.flatMap(({ source }) => discoverSqlObjects(source)),
    nativeIosViews: platform.surfaces.filter(item => item.kind === 'nativeIosView').map(item => item.id),
    iacResources: platform.surfaces.filter(item => item.kind === 'iacResource').map(item => item.id),
    ansibleFiles: ansibleProjection.surfaces.map(item => item.id),
  };
  for (const [bucket, values] of Object.entries(discovered)) {
    discovered[bucket] = [...new Set(values)].sort();
  }
  return { ...discovered, ansibleProjection };
}

export async function verifySourceInventory(root, inventory) {
  const sourceInventory = await discoverSourceInventory(root, inventory?.scope, inventory);
  const { ansibleProjection, ...discovered } = sourceInventory;
  const violations = validateInventory(discovered, inventory?.classifications ?? [], ansibleProjection);
  return { discovered, ansibleProjection, violations };
}

export function resolveRunIdentity(env) {
  if (env.GITHUB_ACTIONS !== 'true') return { status: 'NOT_RUN' };
  const required = [
    'GITHUB_SERVER_URL', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
    'GITHUB_JOB', 'GITHUB_SHA', 'CODEXIA_CI_SOURCE_SHA', 'CODEXIA_CI_TASK',
  ];
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) throw new Error(`Incomplete GitHub Actions identity: missing ${missing.join(', ')}`);
  if (!/^https:\/\/[A-Za-z0-9.-]+$/u.test(env.GITHUB_SERVER_URL)) throw new Error('Invalid GitHub server URL');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(env.GITHUB_REPOSITORY)) throw new Error('Invalid GitHub repository identity');
  if (!/^\d+$/u.test(env.GITHUB_RUN_ID) || Number(env.GITHUB_RUN_ID) < 1) throw new Error('Invalid GitHub run ID');
  if (!/^\d+$/u.test(env.GITHUB_RUN_ATTEMPT) || Number(env.GITHUB_RUN_ATTEMPT) < 1) throw new Error('Invalid GitHub run attempt');
  if (!/^[0-9a-f]{40}$/iu.test(env.GITHUB_SHA)) throw new Error('Invalid GitHub event SHA');
  if (!/^[0-9a-f]{40}$/iu.test(env.CODEXIA_CI_SOURCE_SHA)) throw new Error('Invalid Codexia exact-source SHA');
  if (/\s/u.test(env.GITHUB_JOB) || /\s/u.test(env.CODEXIA_CI_TASK)) throw new Error('Invalid GitHub job or task ID');
  return {
    status: 'IN_PROGRESS',
    repository: env.GITHUB_REPOSITORY,
    sourceSha: env.CODEXIA_CI_SOURCE_SHA.toLowerCase(),
    eventSha: env.GITHUB_SHA.toLowerCase(),
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    job: env.GITHUB_JOB,
    task: env.CODEXIA_CI_TASK,
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
  };
}

export function normalizeHtml(html) {
  const timestamps = [...html.matchAll(/<meta name="strictdoc-search-index-timestamp" content="([^"]+)">/gu)];
  if (timestamps.length > 1) throw new Error(`Expected at most one StrictDoc search timestamp, found ${timestamps.length}`);
  return html.replace(
    /(<meta name="strictdoc-search-index-timestamp" content=")[^"]+(">)/u,
    '$1<TIMESTAMP>$2',
  );
}

export function normalizeSearchIndexJavascript(script) {
  const assignment = 'window.StrictDoc.search.index = ';
  const marker = script.indexOf(assignment);
  if (marker === -1) throw new Error('StrictDoc search index assignment was not found');
  const start = marker + assignment.length;
  const newLine = script.indexOf('\n', start);
  const end = newLine === -1 ? script.length : newLine;
  const value = script.slice(start, end);
  if (!value.startsWith('{') || !value.endsWith('};')) {
    throw new Error('StrictDoc search index assignment does not contain a JSON object');
  }
  const index = JSON.parse(value.slice(0, -1));
  const sorted = Object.fromEntries(Object.entries(index)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([term, documentNumbers]) => {
      if (!Array.isArray(documentNumbers) || documentNumbers.some(item => !Number.isSafeInteger(item) || item < 1)) {
        throw new Error(`Invalid StrictDoc search index membership for ${term}`);
      }
      return [term, documentNumbers.toSorted((left, right) => left - right)];
    }));
  return `${script.slice(0, start)}${JSON.stringify(sorted)};${script.slice(end)}`;
}

function parseArgs(argv) {
  const args = {
    root: REPO_ROOT,
    source: REGISTER_PATH,
    baseRef: process.env.CODEXIA_TRACE_BASE_REF ?? 'origin/main',
    outputDir: undefined,
    report: undefined,
    strictdoc: process.env.STRICTDOC_BIN ?? 'strictdoc',
    inventory: 'scripts/strictdoc/surface-inventory.json',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--help' || item === '-h') {
      args.help = true;
      continue;
    }
    const key = ({
      '--root': 'root', '--source': 'source', '--base-ref': 'baseRef', '--output-dir': 'outputDir',
      '--report': 'report', '--strictdoc': 'strictdoc', '--inventory': 'inventory',
    })[item];
    if (!key || argv[index + 1] === undefined || argv[index + 1].startsWith('--')) {
      throw new Error(`Unknown or incomplete argument: ${item}`);
    }
    args[key] = argv[index + 1];
    index += 1;
  }
  return args;
}

function printHelp() {
  process.stdout.write([
    'Usage: node scripts/strictdoc/verify.mjs [options]',
    '',
    'Options:',
    '  --root <path>         Repository root (default: this checkout)',
    '  --source <path>       Native requirement register link in the report',
    '  --base-ref <ref>      Git ref used to protect existing trace UIDs and MIDs',
    '  --output-dir <path>   Static HTML/JSON staging directory',
    '  --report <path>       JSON report path',
    '  --strictdoc <path>    StrictDoc executable (default: strictdoc)',
    '  --inventory <path>    Reverse inventory manifest',
  ].join('\n') + '\n');
}

function execute(command, args, { cwd, encoding = 'utf8', env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, encoding, env, maxBuffer: 20 * 1024 * 1024 });
  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);
  return result;
}

export function collectTraceNodes(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (TRACE_NODE_TYPES.has(value._NODE_TYPE)) found.push(value);
  for (const child of Object.values(value)) collectTraceNodes(child, found);
  return found;
}

export function validateBaselineTraceIds(baselineNodes, currentNodes) {
  if (!baselineNodes.some(node => node._NODE_TYPE === 'REQUIREMENT')) return ['Baseline StrictDoc export contains no requirement nodes'];
  const currentByUid = new Map(currentNodes.map(node => [node.UID, node]));
  const violations = [];
  for (const previous of baselineNodes) {
    const current = currentByUid.get(previous.UID);
    if (!current) {
      violations.push(`Baseline ${previous._NODE_TYPE} UID removed: ${previous.UID}`);
      continue;
    }
    if (current._NODE_TYPE !== previous._NODE_TYPE) violations.push(`Baseline node type changed: ${previous.UID}`);
    if (current.MID !== previous.MID) violations.push(`Baseline MID changed: ${previous.UID}`);
  }
  return violations;
}

async function executeTraceTests(root, tempRoot, reportName, testFiles, env = process.env) {
  const resultPath = path.join(tempRoot, `${reportName}.ndjson`);
  const result = execute(process.execPath, [
    '--test',
    '--test-reporter=tap', '--test-reporter-destination=stdout',
    '--test-reporter=./scripts/strictdoc/case-results.mjs', `--test-reporter-destination=${resultPath}`,
    ...testFiles,
  ], { cwd: root, env });
  if (result.status !== 0) {
    throw new Error(`StrictDoc ${reportName} tests failed:\n${String(result.stdout)}\n${String(result.stderr)}`);
  }
  const outcomes = (await readFile(resultPath, 'utf8')).trim();
  return { stdout: String(result.stdout).trim(), outcomes: outcomes ? outcomes.split('\n').map(line => JSON.parse(line)) : [] };
}

function executeChecked(command, args, root) {
  const result = execute(command, args, { cwd: root });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${String(result.stderr).trim()}`);
  return result.stdout;
}

async function exportBaselineTraceNodes(command, root, baseRef, tempRoot) {
  const commit = executeChecked('git', ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`], root).trim();
  const source = path.join(tempRoot, 'baseline-source');
  const archive = path.join(tempRoot, 'baseline.tar');
  const output = path.join(tempRoot, 'baseline-export');
  await mkdir(source);
  executeChecked('git', ['archive', '--format=tar', '--output', archive, commit, 'docs', CONFIG_PATH], root);
  executeChecked('tar', ['-xf', archive, '-C', source], root);
  // Export the predecessor's exact authored files with its own config. The
  // initial Markdown ledger and later native projects use the same stock exporter.
  const native = await access(path.join(source, REGISTER_PATH)).then(() => true, () => false);
  const env = { ...process.env };
  delete env.CODEXIA_STRICTDOC_PUBLIC;
  await runStrictDoc(command, source, native ? 'docs' : 'docs/requirements', output, { formats: 'json', env });
  return collectTraceNodes(JSON.parse(await readFile(path.join(output, 'json/index.json'), 'utf8')));
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function walkFiles(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.posix.join(relative.split(path.sep).join('/'), entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Static output may not contain symlinks: ${child}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function runStrictDoc(command, root, inputPath, outputDir, { formats = 'html,json', env = process.env } = {}) {
  const result = execute(command, [
    'export', path.resolve(root, inputPath),
    '--config', path.join(root, CONFIG_PATH),
    '--formats', formats,
    '--output-dir', outputDir,
    '--no-parallelization',
  ], { cwd: root, env: { ...env, PYTHONDONTWRITEBYTECODE: '1' } });
  if (result.status !== 0) throw new Error(`StrictDoc export failed (${result.status ?? 'signal'}):\n${String(result.stdout)}\n${String(result.stderr)}`);
  return `${String(result.stdout)}\n${String(result.stderr)}`;
}

async function compareExports(firstDir, secondDir) {
  const firstFiles = (await walkFiles(firstDir)).filter((file) => file.startsWith('html/') || file.startsWith('json/'));
  const secondFiles = (await walkFiles(secondDir)).filter((file) => file.startsWith('html/') || file.startsWith('json/'));
  const violations = [];
  if (JSON.stringify(firstFiles) !== JSON.stringify(secondFiles)) violations.push('StrictDoc output file sets differ between identical exports');
  const files = [...new Set([...firstFiles, ...secondFiles])].sort();
  const firstHashes = {};
  for (const relative of files) {
    const firstPath = path.join(firstDir, relative);
    const secondPath = path.join(secondDir, relative);
    let firstBytes;
    let secondBytes;
    try {
      firstBytes = await readFile(firstPath);
      secondBytes = await readFile(secondPath);
    } catch {
      violations.push(`Missing export file in one run: ${relative}`);
      continue;
    }
    if (relative.endsWith('.html')) {
      const left = normalizeHtml(firstBytes.toString('utf8'));
      const right = normalizeHtml(secondBytes.toString('utf8'));
      if (left !== right) violations.push(`Non-deterministic HTML after only documented normalizations: ${relative}`);
      firstHashes[relative] = createHash('sha256').update(left).digest('hex');
    } else if (relative.endsWith('/static_html_search_index.js')) {
      const left = normalizeSearchIndexJavascript(firstBytes.toString('utf8'));
      const right = normalizeSearchIndexJavascript(secondBytes.toString('utf8'));
      if (left !== right) violations.push(`Non-deterministic StrictDoc search index after ordering normalization: ${relative}`);
      firstHashes[relative] = createHash('sha256').update(left).digest('hex');
    } else {
      if (!firstBytes.equals(secondBytes)) violations.push(`Non-deterministic StrictDoc artifact: ${relative}`);
      firstHashes[relative] = createHash('sha256').update(firstBytes).digest('hex');
    }
  }
  return { violations, fileHashes: firstHashes, files };
}

function cleanGitWorktree(root) {
  const result = execute('git', ['status', '--porcelain=v1'], { cwd: root });
  if (result.status !== 0) throw new Error(`Could not inspect git worktree: ${String(result.stderr).trim()}`);
  return result.stdout.trim() === '';
}

async function readGitIdentity(root) {
  const sha = execute('git', ['rev-parse', 'HEAD'], { cwd: root });
  if (sha.status !== 0 || !/^[0-9a-f]{40}\s*$/iu.test(sha.stdout)) throw new Error('Could not identify the exact source SHA');
  return { sourceSha: sha.stdout.trim().toLowerCase(), worktreeClean: cleanGitWorktree(root) };
}

async function findHtmlDocument(root, sourceRel) {
  const files = await walkFiles(root);
  const expectedName = `${path.basename(sourceRel)}.html`;
  const candidates = files.filter((file) => file.endsWith(`/${expectedName}`));
  if (candidates.length !== 1) throw new Error(`Expected one generated requirement HTML page, found ${candidates.length}`);
  return path.join(root, candidates[0]);
}

export async function findTraceHtmlDocuments(outputDir, nodeIds) {
  const expected = new Set(nodeIds);
  const byFile = new Map();
  for (const file of await walkFiles(outputDir)) {
    if (!file.startsWith('html/') || !file.endsWith('.sdoc.html')) continue;
    const html = await readFile(path.join(outputDir, file), 'utf8');
    const ids = [...html.matchAll(/<sdoc-anchor\b[^>]*?\sid="([^"]+)"/gu)]
      .map(match => match[1]).filter(id => expected.has(id));
    if (ids.length > 0) byFile.set(file, ids);
  }
  const seen = new Set();
  for (const ids of byFile.values()) {
    for (const id of ids) {
      if (seen.has(id)) throw new Error(`Generated StrictDoc HTML repeats UID anchor ${id}`);
      seen.add(id);
    }
  }
  const missingIds = [...expected].filter(id => !seen.has(id));
  if (missingIds.length > 0) throw new Error(`Generated HTML is missing UID anchors: ${missingIds.join(', ')}`);
  return byFile;
}

async function checkStaticOutput(outputDir, nodeIds, sourceRel, repositoryRoot) {
  const files = await walkFiles(outputDir);
  if (!files.includes('html/index.html') || !files.includes('json/index.json')) {
    throw new Error('StrictDoc did not generate both HTML and JSON indexes');
  }
  const htmlPath = await findHtmlDocument(path.join(outputDir, 'html'), sourceRel);
  const jsonPath = path.join(outputDir, 'json/index.json');
  await findTraceHtmlDocuments(outputDir, nodeIds);
  const sensitivePatterns = [
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
    /\bsk-[A-Za-z0-9]{20,}\b/u,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  ];
  for (const file of files.filter((entry) => /\.(?:html|json|js|css|svg)$/u.test(entry))) {
    const content = await readFile(path.join(outputDir, file), 'utf8');
    if (sensitivePatterns.some((pattern) => pattern.test(content))) throw new Error(`Generated static output contains a credential-like value: ${file}`);
    if (content.includes(repositoryRoot)) throw new Error(`Generated static output contains a local repository path: ${file}`);
  }
  return { files, htmlPath: path.relative(outputDir, htmlPath), jsonPath: path.relative(outputDir, jsonPath) };
}

async function runVerifier(args) {
  const root = path.resolve(args.root);
  const sourceRel = args.source.split(path.sep).join('/');
  const inventoryPath = path.resolve(root, args.inventory);
  const versionResult = execute(args.strictdoc, ['--version'], { cwd: root });
  const version = String(versionResult.stdout).trim();
  if (versionResult.status !== 0 || version !== EXPECTED_STRICTDOC_VERSION) {
    throw new Error(`StrictDoc must be ${EXPECTED_STRICTDOC_VERSION}; got ${version || String(versionResult.stderr).trim() || 'unavailable'}`);
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codexia-strictdoc-'));
  const run1 = path.join(tempRoot, 'run-1');
  const run2 = path.join(tempRoot, 'run-2');
  const publicOnly = process.env.CODEXIA_STRICTDOC_PUBLIC === '1';
  const configuredReportDir = process.env.CODEXIA_CI_REPORT_DIR;
  const finalOutput = args.outputDir
    ? path.resolve(root, args.outputDir)
    : configuredReportDir
      ? path.join(path.resolve(configuredReportDir), 'strictdoc')
      : path.join(root, 'work/strictdoc');
  const reportPath = args.report ? path.resolve(root, args.report) : path.join(finalOutput, 'trace-report.json');
  try {
    // Use an absolute CLI path only when supplied as a path. Installed commands
    // on PATH remain usable when the baseline is exported from a temp checkout.
    const command = args.strictdoc.includes(path.sep) ? path.resolve(root, args.strictdoc) : args.strictdoc;
    const baselineNodes = await exportBaselineTraceNodes(command, root, args.baseRef, tempRoot);
    await runStrictDoc(command, root, 'docs', run1);
    await runStrictDoc(command, root, 'docs', run2);
    const firstJson = JSON.parse(await readFile(path.join(run1, 'json/index.json'), 'utf8'));
    const traceNodes = collectTraceNodes(firstJson);
    let completeJson = firstJson;
    if (publicOnly) {
      // Verify authoring inputs outside the publication boundary without
      // copying their output into the artifact or report directory.
      const completeOutput = path.join(tempRoot, 'complete-export');
      const env = { ...process.env };
      delete env.CODEXIA_STRICTDOC_PUBLIC;
      await runStrictDoc(command, root, 'docs', completeOutput, { formats: 'json', env });
      completeJson = JSON.parse(await readFile(path.join(completeOutput, 'json/index.json'), 'utf8'));
      const completeNodes = collectTraceNodes(completeJson);
      const scopeViolations = validateBaselineTraceIds(completeNodes, traceNodes);
      if (traceNodes.length !== completeNodes.length || scopeViolations.length > 0) {
        throw new Error(`Published StrictDoc export must preserve all trace nodes from the complete project: ${scopeViolations.join('; ')}`);
      }
    }
    const authoredDocumentCount = (await walkFiles(path.join(root, 'docs'))).filter(file => file.endsWith('.sdoc')).length;
    if (completeJson.DOCUMENTS.length !== authoredDocumentCount) {
      throw new Error(`Complete StrictDoc export contains ${completeJson.DOCUMENTS.length} documents from ${authoredDocumentCount} native sources`);
    }
    const requirementNodes = traceNodes.filter(node => node._NODE_TYPE === 'REQUIREMENT');
    const scenarioNodes = traceNodes.filter(node => node._NODE_TYPE === 'TEST');
    const obligationNodes = traceNodes.filter(node => node._NODE_TYPE === 'OBLIGATION');
    const exportedObligationIds = obligationNodes.map(node => node.UID);
    const nodeViolations = [
      ...validateBaselineTraceIds(baselineNodes, traceNodes),
      ...validateRequirementNodes(requirementNodes),
    ];
    if (nodeViolations.length > 0) throw new Error(nodeViolations.join('\n'));
    const { sources: testSources, violations: discoveryViolations } = await discoverTestSources(root);
    const scenarioViolations = [...discoveryViolations, ...validateScenarioNodes(scenarioNodes, requirementNodes, testSources)];
    if (scenarioViolations.length > 0) throw new Error(scenarioViolations.join('\n'));
    const exportedIds = requirementNodes.map((node) => node.UID);
    const relationViolations = await validateRelations(traceNodes, root);
    if (relationViolations.length > 0) throw new Error(relationViolations.join('\n'));
    const designViolations = await validateObligationDesignRefs(obligationNodes, sourceRel, root);
    if (designViolations.length > 0) throw new Error(designViolations.join('\n'));

    const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
    const { discovered, ansibleProjection, violations: inventoryViolations } = await verifySourceInventory(root, inventory);
    if (inventoryViolations.length > 0) throw new Error(inventoryViolations.join('\n'));
    const determinism = await compareExports(run1, run2);
    if (determinism.violations.length > 0) throw new Error(determinism.violations.join('\n'));
    await mkdir(path.dirname(finalOutput), { recursive: true });
    try {
      await access(finalOutput);
      const existing = await readdir(finalOutput);
      if (existing.length > 0) throw new Error(`Static output target must be empty: ${finalOutput}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await mkdir(finalOutput, { recursive: true });
    const { cp } = await import('node:fs/promises');
    await cp(path.join(run1, 'html'), path.join(finalOutput, 'html'), { recursive: true });
    await cp(path.join(run1, 'json'), path.join(finalOutput, 'json'), { recursive: true });
    // StrictDoc's project dashboard can render the absolute checkout path. Redact
    // only that known local path before the staged static tree is inspected.
    for (const file of await walkFiles(finalOutput)) {
      if (!/\.(?:html|json|js|css|svg)$/u.test(file)) continue;
      const absolutePath = path.join(finalOutput, file);
      const content = await readFile(absolutePath, 'utf8');
      if (content.includes(root)) await writeFile(absolutePath, content.replaceAll(root, 'REPOSITORY_ROOT'), 'utf8');
    }
    const allNodeIds = [...exportedIds, ...exportedObligationIds, ...scenarioNodes.map(node => node.UID)];
    const staticOutput = await checkStaticOutput(finalOutput, allNodeIds, sourceRel, root);
    const nodeTraceTests = [
      'scripts/strictdoc/verify.test.mjs', 'scripts/strictdoc/case-results.test.mjs',
      'scripts/strictdoc/obligation-trace.test.mjs', 'scripts/strictdoc/reverse-trace.test.mjs',
      'scripts/strictdoc/test-sources.test.mjs',
      'scripts/audit/specifications.test.mjs', 'scripts/ci/evidence/trace-receipt.test.mjs',
      'scripts/verification/artifacts/pages-live-ux.test.mjs',
    ];
    const browserTraceTests = ['scripts/strictdoc/verify.browser.mjs'];
    const testsForScope = (scope, supportingFiles) => [...new Set([
      ...supportingFiles,
      ...scenarioNodes.filter(node => node.EXECUTION_SCOPE === scope).map(node => testSources.get(node.UID).file),
    ])];
    const nodeFiles = testsForScope('TRACE_NODE', nodeTraceTests);
    const browserFiles = testsForScope('TRACE_BROWSER', browserTraceTests);
    const nodeFileSet = new Set(nodeFiles);
    const browserFileSet = new Set(browserFiles);
    for (const node of scenarioNodes) {
      const { file } = testSources.get(node.UID);
      const actualScope = nodeFileSet.has(file) ? 'TRACE_NODE' : browserFileSet.has(file) ? 'TRACE_BROWSER' : 'PRODUCT';
      if (actualScope !== node.EXECUTION_SCOPE || (nodeFileSet.has(file) && browserFileSet.has(file))) {
        throw new Error(`${node.UID} execution scope conflicts with the trace runner assignment for ${file}`);
      }
    }
    const nodeTest = await executeTraceTests(root, tempRoot, 'node', nodeFiles);
    const browserTest = await executeTraceTests(root, tempRoot, 'playwright', browserFiles, {
      ...process.env, CODEXIA_STRICTDOC_OUTPUT_DIR: finalOutput,
    });
    const caseExecutions = associateTraceCases(testSources, [...nodeTest.outcomes, ...browserTest.outcomes]);
    const requiredCases = scenarioNodes.filter(node => node.EXECUTION_SCOPE !== 'PRODUCT');
    const caseById = new Map(caseExecutions.map(outcome => [outcome.testId, outcome]));
    const casesWithoutPass = requiredCases.filter(node => caseById.get(node.UID)?.result !== 'PASSED');
    if (casesWithoutPass.length > 0) {
      throw new Error(`Required StrictDoc cases lacked a passing execution: ${casesWithoutPass.map(node =>
        `${node.UID} (${caseById.get(node.UID)?.result ?? 'NOT_RUN'})`).join(', ')}`);
    }
    const git = await readGitIdentity(root);
    const run = resolveRunIdentity(process.env);
    if (run.status === 'IN_PROGRESS') {
      if (run.sourceSha !== git.sourceSha) {
        throw new Error(`Codexia exact-source SHA ${run.sourceSha} does not match checkout ${git.sourceSha}`);
      }
      if (!git.worktreeClean) throw new Error('Codexia exact-source trace requires a clean checkout');
    }
    // The producer can identify a case execution and its current run. The existing
    // CI certifier verifies the uploaded artifact's job, attempt and digest later.
    const runEvidence = run.status === 'IN_PROGRESS' ? caseExecutions.filter(item => item.result === 'PASSED').map(item => ({
      testId: item.testId, url: run.runUrl, sourceSha: run.sourceSha, runId: run.runId,
      attempt: run.runAttempt, repository: run.repository, job: run.job, task: run.task, result: 'PASS',
    })) : [];
    const obligationTrace = await buildObligationTrace({
      requirements: requirementNodes, obligations: obligationNodes, scenarios: scenarioNodes,
      repositoryRoot: root, expectedRepository: run.repository, expectedSourceSha: git.sourceSha, runEvidence,
    });
    if (obligationTrace.violations.length > 0) throw new Error(obligationTrace.violations.join('\n'));
    const reverseDiscovery = await discoverReverseSurfaces({ repositoryRoot: root, boundedDiscovery: discovered, ansibleProjection });
    const reverseTrace = await buildReverseTrace({ discovered: reverseDiscovery, inventory, obligations: obligationTrace.rows });
    if (reverseTrace.violations.length > 0) throw new Error(reverseTrace.violations.join('\n'));
    const lockPath = path.join(SCRIPT_DIR, 'requirements.lock.txt');
    const lockDigest = await sha256File(lockPath);
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: {
        ...git,
        documentScope: publicOnly ? 'public' : 'complete',
        completeDocumentCount: completeJson.DOCUMENTS.length,
        stagedDocumentCount: firstJson.DOCUMENTS.length,
        registerPath: sourceRel,
        requirementCount: exportedIds.length,
        requirementIds: [...exportedIds].sort(),
      },
      toolchain: { strictdocVersion: version, requirementsLockSha256: lockDigest },
      exports: {
        htmlPath: staticOutput.htmlPath,
        jsonPath: staticOutput.jsonPath,
        stagedFileCount: staticOutput.files.length,
        rawFiles: await Promise.all(staticOutput.files.filter(file => file.startsWith('html/') || file.startsWith('json/')).sort().map(async name => {
          const bytes = await readFile(path.join(finalOutput, name));
          return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        })),
        redactions: ['Exact absolute repository root string in generated text artifacts replaced with REPOSITORY_ROOT'],
        deterministic: true,
        normalizationRules: [
          'StrictDoc HTML search-index timestamp',
          'StrictDoc search-index object keys and set-member arrays; StrictDoc serializes these values from Python sets',
        ],
        normalizedFileSha256: determinism.fileHashes,
      },
      inventory: {
        classificationCount: inventory.classifications.length,
        sourceFiles: [...inventory.scope.routes, ...inventory.scope.tools, ...inventory.scope.databaseObjects],
        discoveryMethod: inventory.scope.method,
        discovered,
        discoveredCounts: Object.fromEntries(Object.entries(discovered).map(([key, values]) => [key, values.length])),
        status: inventory.coverageStatus ?? 'PARTIAL',
        limitations: inventory.limitations ?? [],
      },
      traceability: {
        TRC01: { status: 'LOCAL_PASS', detail: 'All baseline REQ, OBL and TEST nodes preserve their UID, MID and type in the standard StrictDoc export.' },
        TRC02: { status: 'LOCAL_PASS', detail: 'Two exports match after only recorded StrictDoc timestamp and search-index key and unordered membership normalization.' },
        TRC03: { status: 'PARTIAL', detail: 'See obligationTrace for resolved design and source references, and the remaining mapping gaps.' },
        TRC04: { status: inventory.coverageStatus ?? 'PARTIAL', detail: 'See reverseTrace for discovered surfaces, obligation links, deviations and discovery limitations.' },
        TRC05: { status: run.status === 'NOT_RUN' ? 'LOCAL_PASS_NO_RUN' : 'IN_PROGRESS', nodeTests: 'PASSED', browserTests: 'PASSED', detail: 'See caseExecutions for observed TEST IDs. The existing CI certifier binds the uploaded report to its job and artifact.' },
        TRC06: { status: 'LOCAL_PASS', detail: 'Fault injection is exercised by the scoped Node test suite.' },
        TRC07: { status: 'PENDING_PAGES_PUBLISH', staticStaging: 'PASSED', browserAcceptance: 'PASSED', detail: 'Static output is staged safely; publication remains with the existing Repository Audit Pages publisher and DOC-01.' },
        gates: projectTraceabilityGates({ requirementNodes, obligationTrace, reverseTrace, caseExecutions, run }),
      },
      tests: {
        node: { status: 'PASSED', output: nodeTest.stdout },
        playwright: { status: 'PASSED', output: browserTest.stdout },
      },
      obligationTrace: { rows: obligationTrace.rows, gaps: obligationTrace.gaps },
      reverseTrace: { rows: reverseTrace.rows, gaps: reverseTrace.gaps },
      requiredCaseIds: requiredCases.map(node => node.UID),
      caseExecutions,
      execution: run,
      publication: { status: 'NOT_PUBLISHED', publisher: '.github/workflows/repository-audit.yml' },
    };
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) return printHelp();
    const report = await runVerifier(args);
    const root = path.resolve(args.root);
    const outputDir = args.outputDir
      ? path.resolve(root, args.outputDir)
      : process.env.CODEXIA_CI_REPORT_DIR
        ? path.join(path.resolve(process.env.CODEXIA_CI_REPORT_DIR), 'strictdoc')
        : path.join(root, 'work/strictdoc');
    const reportPath = args.report ? path.resolve(root, args.report) : path.join(outputDir, 'trace-report.json');
    process.stdout.write(`${JSON.stringify({ report: reportPath, sourceSha: report.source.sourceSha, requirementCount: report.source.requirementCount, traceability: report.traceability }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
