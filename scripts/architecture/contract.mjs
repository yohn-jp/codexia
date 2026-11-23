import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const LIKEC4_VERSION = '1.61.0';
export const LIKEC4_GENERATOR = `likec4@${LIKEC4_VERSION}`;
export const LIKEC4_SOURCE_PATH = 'docs/architecture/likec4/model.likec4';
export const LIKEC4_VIEW_ID = 'architecture';
export const LIKEC4_VIEW_TITLE = 'Codexia system context, containers, and trust boundaries';

export const REQUIRED_TRUST_BOUNDARIES = Object.freeze({
  author: 'client',
  web: 'client',
  indexedDb: 'client',
  ios: 'client',
  iosJournal: 'client',
  externalAi: 'client',
  edge: 'edge',
  'edge.workers': 'edge',
  'edge.tunnel': 'edge',
  codexia: 'application-host',
  'codexia.fastify': 'application',
  'codexia.fastify.betterAuth': 'application',
  'codexia.fastify.mcp': 'application',
  'codexia.fastify.core': 'application',
  'codexia.fastify.modules': 'application',
  'codexia.fastify.persistence': 'application',
  'codexia.postgres': 'data',
  'codexia.history': 'data',
  'codexia.backupExecutor': 'host-operations',
  'codexia.ssh': 'host-operations',
  operations: 'operations',
  'operations.workflow': 'operations',
  'operations.ansible': 'operations',
  tailscale: 'operations',
  offsite: 'offsite-storage',
  'offsite.s3': 'offsite-storage',
});

export const REQUIRED_RELATIONSHIPS = Object.freeze([
  ['author', 'web'],
  ['web', 'indexedDb'],
  ['ios', 'iosJournal'],
  ['web', 'edge.workers'],
  ['web', 'edge.tunnel'],
  ['ios', 'edge.tunnel'],
  ['externalAi', 'codexia.fastify.mcp'],
  ['edge.tunnel', 'codexia.fastify'],
  ['codexia.fastify.mcp', 'codexia.fastify.core'],
  ['codexia.fastify.core', 'codexia.fastify.modules'],
  ['codexia.fastify.core', 'codexia.fastify.persistence'],
  ['codexia.fastify.persistence', 'codexia.postgres'],
  ['codexia.fastify.betterAuth', 'codexia.postgres'],
  ['operations.workflow', 'tailscale'],
  ['operations.workflow', 'operations.ansible'],
  ['operations.ansible', 'codexia.ssh'],
  ['codexia.ssh', 'codexia.backupExecutor'],
  ['codexia.backupExecutor', 'codexia.postgres'],
  ['codexia.backupExecutor', 'codexia.history'],
  ['codexia.backupExecutor', 'offsite.s3'],
]);

export const REQUIRED_BIDIRECTIONAL_RELATIONSHIPS = Object.freeze([
  ['codexia.fastify.core', 'codexia.fastify.modules'],
]);

export const FORBIDDEN_RELATIONSHIPS = Object.freeze([
  ['author', 'codexia.ssh'],
  ['web', 'codexia.ssh'],
  ['ios', 'codexia.ssh'],
  ['externalAi', 'codexia.ssh'],
  ['edge.tunnel', 'codexia.ssh'],
  ['codexia.fastify.mcp', 'codexia.ssh'],
  ['web', 'operations.ansible'],
  ['ios', 'operations.ansible'],
  ['externalAi', 'operations.ansible'],
]);

const APPROVED_TRUST_BOUNDARIES = new Set([
  'client', 'edge', 'application-host', 'application', 'data',
  'host-operations', 'operations', 'offsite-storage',
]);
const PRODUCT_REQUEST_BOUNDARIES = new Set(['client', 'edge', 'application-host', 'application']);
const PROTECTED_OPERATIONS_BOUNDARIES = new Set(['operations', 'host-operations']);

export const REQUIRED_RISK_IDS = Object.freeze([
  'codexia-bola-project-isolation',
  'codexia-mcp-issuer-resource',
  'codexia-session-scope-confusion',
  'codexia-false-db-receipt',
  'codexia-edge-operations-plane',
  'codexia-backup-key-restore',
  'codexia-public-pages-disclosure',
]);

export const REQUIRED_RISK_BOUNDARIES = Object.freeze({
  'codexia-bola-project-isolation': 'codexia-vm',
  'codexia-mcp-issuer-resource': 'codexia-vm',
  'codexia-session-scope-confusion': 'codexia-vm',
  'codexia-false-db-receipt': 'codexia-vm',
  'codexia-edge-operations-plane': 'host-operations',
  'codexia-backup-key-restore': 'offsite-storage',
  'codexia-public-pages-disclosure': 'public-pages',
});

export const REQUIRED_RISK_ASSETS = Object.freeze({
  'codexia-bola-project-isolation': 'codexia-api',
  'codexia-mcp-issuer-resource': 'codexia-api',
  'codexia-session-scope-confusion': 'codexia-api',
  'codexia-false-db-receipt': 'codexia-api',
  'codexia-edge-operations-plane': 'operator-host-path',
  'codexia-backup-key-restore': 'backup-executor',
  'codexia-public-pages-disclosure': 'public-pages',
});

export const REQUIRED_RISK_CHECK_IDS = Object.freeze({
  'codexia-bola-project-isolation': ['REQ-AUTH-002', 'REQ-DATA-003', 'AUTH-06', 'MCPV-004'],
  'codexia-mcp-issuer-resource': ['EXT-MCP-001', 'AUTH-05', 'AUTH-06', 'MCPV-002', 'MCPV-004'],
  'codexia-session-scope-confusion': ['EXT-AUTH-001', 'EXT-SHARE-001', 'AUTH-04', 'AUTH-05', 'AUTH-06', 'REQ-AUTH-005'],
  'codexia-false-db-receipt': ['REQ-DATA-002:O01', 'REQ-API-002:O01', 'MCPV-005'],
  'codexia-edge-operations-plane': ['EXT-EDGE-001', 'EXT-EDGE-002', 'EXT-OPS-001', 'AUTH-07'],
  'codexia-backup-key-restore': [
    'EXT-OPS-003', 'BACKUP-S3-001', 'BACKUP-S3-002', 'BACKUP-S3-003', 'BACKUP-S3-004',
    'BACKUP-S3-005', 'BACKUP-S3-006', 'BACKUP-S3-007', 'BKC-T04', 'BKC-T05', 'BKC-T06',
    'BKC-T07', 'BKC-T08', 'BKC-T10',
  ],
  'codexia-public-pages-disclosure': ['REQ-QUAL-002', 'AUTH-08', 'G5'],
});

const SUPPRESSED_STATUSES = new Set(['mitigated', 'false-positive']);
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
  /\bBearer\s+(?!\$\{|<|CHANGE_ME\b|REDACTED\b|EXAMPLE\b)[A-Za-z0-9._~+/-]{16,}/iu,
  /\b(?:AWS_SECRET_ACCESS_KEY|(?:api|access|secret|private)[_-]?(?:key|token))\s*[:=]\s*["']?(?!\$\{|<|CHANGE_ME\b|REDACTED\b|EXAMPLE\b)[A-Za-z0-9/+._=-]{20,}/iu,
]);

/** @param {unknown} model */
export function validateLikeC4Export(model) {
  assert.ok(model && typeof model === 'object', 'LikeC4 export must be an object');
  assert.ok(model.elements && typeof model.elements === 'object', 'LikeC4 export is missing elements');
  assert.ok(model.relations && typeof model.relations === 'object', 'LikeC4 export is missing relationships');

  for (const [id, boundary] of Object.entries(REQUIRED_TRUST_BOUNDARIES)) {
    const element = model.elements[id];
    assert.ok(element, `LikeC4 model is missing required element ${id}`);
    assert.equal(element.metadata?.trustBoundary, boundary,
      `LikeC4 element ${id} must remain in trust boundary ${boundary}`);
  }
  for (const element of Object.values(model.elements)) {
    assert.ok(APPROVED_TRUST_BOUNDARIES.has(element.metadata?.trustBoundary),
      `LikeC4 element ${element.id ?? '<unknown>'} must use an approved trust boundary`);
  }

  const pairs = new Set();
  const relations = Object.values(model.relations);
  for (const relation of relations) {
    const source = relation.source?.model;
    const target = relation.target?.model;
    pairs.add(`${source}->${target}`);
    if (relation.isBidirectional === true) pairs.add(`${target}->${source}`);
  }
  for (const [source, target] of REQUIRED_RELATIONSHIPS) {
    assert.ok(pairs.has(`${source}->${target}`),
      `LikeC4 model is missing required trust relationship ${source} -> ${target}`);
  }
  for (const [source, target] of REQUIRED_BIDIRECTIONAL_RELATIONSHIPS) {
    assert.ok(relations.some(relation => relation.isBidirectional === true &&
      relation.source?.model === source && relation.target?.model === target),
    `LikeC4 model is missing the bidirectional relationship ${source} <-> ${target}`);
  }
  for (const [source, target] of FORBIDDEN_RELATIONSHIPS) {
    assert.ok(!pairs.has(`${source}->${target}`),
      `LikeC4 model must not cross the product and protected operations boundary: ${source} -> ${target}`);
  }
  for (const relation of relations) {
    const source = relation.source?.model;
    const target = relation.target?.model;
    const sourceBoundary = model.elements[source]?.metadata?.trustBoundary;
    const targetBoundary = model.elements[target]?.metadata?.trustBoundary;
    const crossesProtectedOperations =
      (PRODUCT_REQUEST_BOUNDARIES.has(sourceBoundary) && PROTECTED_OPERATIONS_BOUNDARIES.has(targetBoundary)) ||
      (PROTECTED_OPERATIONS_BOUNDARIES.has(sourceBoundary) && PRODUCT_REQUEST_BOUNDARIES.has(targetBoundary));
    assert.ok(!crossesProtectedOperations,
      `LikeC4 model must not cross from ${sourceBoundary} to ${targetBoundary}: ${source} -> ${target}`);
  }

  const modelText = Object.values(model.elements).map(element =>
    `${element.id ?? ''} ${element.title ?? ''}`).join('\n');
  assert.doesNotMatch(modelText,
    /(?:internal\s+)?(?:llm|model-provider|provider-streaming|inference-queue|token-charging)/iu,
    'LikeC4 model must not reintroduce retired internal inference services');
  return true;
}

/** @param {unknown} risks */
export function validateThreatRisks(risks) {
  assert.ok(Array.isArray(risks), 'Threagile risk output must be a JSON array');
  const risksById = new Map();
  for (const risk of risks) {
    if (!risk || typeof risk.synthetic_id !== 'string') continue;
    risksById.set(risk.synthetic_id, risk);
  }
  for (const id of REQUIRED_RISK_IDS) {
    const matches = [...risksById.values()].filter(risk => risk.synthetic_id.startsWith(`${id}@`));
    assert.ok(matches.length > 0, `Threagile output is missing required risk ${id}`);
    for (const risk of matches) {
      assert.ok(!SUPPRESSED_STATUSES.has(risk.risk_status),
        `Threagile risk ${id} is suppressed as ${risk.risk_status}`);
      assert.equal(risk.most_relevant_trust_boundary, REQUIRED_RISK_BOUNDARIES[id],
        `Threagile risk ${id} must remain in trust boundary ${REQUIRED_RISK_BOUNDARIES[id]}`);
      assert.equal(risk.most_relevant_technical_asset, REQUIRED_RISK_ASSETS[id],
        `Threagile risk ${id} must remain attached to asset ${REQUIRED_RISK_ASSETS[id]}`);
    }
  }
  return true;
}

/** @param {string} threatModelSource */
export function validateThreatModelCheckIds(threatModelSource) {
  assert.equal(typeof threatModelSource, 'string', 'Threagile source must be text');
  for (const [id, requiredChecks] of Object.entries(REQUIRED_RISK_CHECK_IDS)) {
    const header = new RegExp(`^  [^\\n]+:\\n    id: ${id}\\n`, 'mu').exec(threatModelSource);
    assert.ok(header, `Threagile source is missing required risk ${id}`);
    const start = header.index + header[0].length;
    const remainder = threatModelSource.slice(start);
    const nextRisk = /^  [^\n]+:\n    id: |^risk_tracking:/mu.exec(remainder);
    const body = remainder.slice(0, nextRisk?.index ?? remainder.length);
    const check = /^    check:\s*(.+)$/mu.exec(body)?.[1] ?? '';
    for (const checkId of requiredChecks) {
      assert.ok(check.includes(checkId),
        `Threagile risk ${id} is missing verification reference ${checkId}`);
    }
  }
  return true;
}

/** @param {string[]} texts */
export function assertNoPublicSecrets(texts) {
  assert.ok(Array.isArray(texts) && texts.every(text => typeof text === 'string'),
    'Public architecture inputs must be text');
  const combined = texts.join('\n');
  for (const pattern of SECRET_PATTERNS) {
    assert.ok(!pattern.test(combined), 'Public architecture input contains secret-like material');
  }
  return true;
}

/** @param {string} modelSource @param {string} generatedMermaid @param {string} title */
export function createGeneratedMermaid(modelSource, generatedMermaid, title = LIKEC4_VIEW_TITLE) {
  assert.equal(typeof modelSource, 'string', 'LikeC4 source must be text');
  assert.equal(typeof generatedMermaid, 'string', 'Generated Mermaid must be text');
  assert.equal(typeof title, 'string', 'LikeC4 view title must be text');
  assert.ok(title.length > 0 && !/[\r\n]/u.test(title), 'LikeC4 view title must be one line');
  const source = generatedMermaid.trim();
  assert.match(source, /^(?:graph|flowchart)\s/um, 'LikeC4 did not generate a Mermaid graph');
  const digest = createHash('sha256').update(modelSource, 'utf8').digest('hex');
  return [
    `%% Generated by ${LIKEC4_GENERATOR}; do not edit.`,
    `%% source: ${LIKEC4_SOURCE_PATH}`,
    `%% source-sha256: ${digest}`,
    `%% view: ${LIKEC4_VIEW_ID}`,
    `%% title: ${JSON.stringify(title)}`,
    source,
    '',
  ].join('\n');
}

/** @param {string} text */
export function parseGeneratedMermaid(text) {
  assert.equal(typeof text, 'string', 'Generated Mermaid derivative must be text');
  const lines = text.split(/\r?\n/u);
  const generator = /^%% Generated by (likec4@[0-9.]+); do not edit\.$/u.exec(lines[0] ?? '')?.[1];
  const sourcePath = /^%% source: (.+)$/u.exec(lines[1] ?? '')?.[1];
  const sourceSha256 = /^%% source-sha256: ([a-f0-9]{64})$/u.exec(lines[2] ?? '')?.[1];
  const viewId = /^%% view: ([a-z][a-z0-9-]*)$/u.exec(lines[3] ?? '')?.[1];
  let title;
  try {
    title = JSON.parse(/^%% title: (".*")$/u.exec(lines[4] ?? '')?.[1] ?? 'null');
  } catch {
    title = null;
  }
  assert.equal(generator, LIKEC4_GENERATOR, 'Generated Mermaid uses an unexpected LikeC4 version');
  assert.equal(sourcePath, LIKEC4_SOURCE_PATH, 'Generated Mermaid points at an unexpected LikeC4 source');
  assert.equal(viewId, LIKEC4_VIEW_ID, 'Generated Mermaid selects an unexpected LikeC4 view');
  assert.ok(typeof title === 'string' && title.length > 0, 'Generated Mermaid is missing its LikeC4 view title');
  assert.ok(sourceSha256, 'Generated Mermaid is missing its LikeC4 source digest');
  const source = lines.slice(5).join('\n').trim();
  assert.match(source, /^(?:graph|flowchart)\s/um, 'Generated Mermaid body is not a graph');
  return { generator, sourcePath, sourceSha256, viewId, title, source };
}

/** @param {string} generated */
export function extractLikeC4Mermaid(generated) {
  assert.equal(typeof generated, 'string', 'LikeC4 Mermaid output must be text');
  const lines = generated.split(/\r?\n/u);
  assert.equal(lines[0]?.trim(), '---', 'LikeC4 Mermaid output must include its title frontmatter');
  assert.equal(lines[2]?.trim(), '---', 'LikeC4 Mermaid output frontmatter must be closed');
  const titleValue = /^title:\s*(".*")$/u.exec(lines[1] ?? '')?.[1];
  assert.ok(titleValue, 'LikeC4 Mermaid output is missing a quoted view title');
  const title = JSON.parse(titleValue);
  assert.equal(title, LIKEC4_VIEW_TITLE, 'LikeC4 view title differs from the checked architecture contract');
  const source = lines.slice(3).join('\n').trim();
  assert.match(source, /^(?:graph|flowchart)\s/um, 'LikeC4 Mermaid output has no graph body');
  return { title, source };
}

/** @param {string} modelSource @param {string} checkedIn @param {string} regenerated */
export function verifyGeneratedMermaid(modelSource, checkedIn, regenerated) {
  const parsed = parseGeneratedMermaid(checkedIn);
  const actualDigest = createHash('sha256').update(modelSource, 'utf8').digest('hex');
  assert.equal(parsed.sourceSha256, actualDigest, 'Generated Mermaid source digest is stale');
  const parsedGenerated = typeof regenerated === 'string' && regenerated.startsWith('---\n')
    ? extractLikeC4Mermaid(regenerated)
    : { title: parsed.title, source: regenerated.trim() };
  assert.equal(checkedIn, createGeneratedMermaid(modelSource, parsedGenerated.source, parsedGenerated.title),
    'Checked Mermaid derivative differs from LikeC4 regeneration');
  return true;
}
