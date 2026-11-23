import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertNoPublicSecrets,
  createGeneratedMermaid,
  parseGeneratedMermaid,
  REQUIRED_RISK_ASSETS,
  REQUIRED_RISK_BOUNDARIES,
  REQUIRED_RISK_CHECK_IDS,
  REQUIRED_RELATIONSHIPS,
  REQUIRED_BIDIRECTIONAL_RELATIONSHIPS,
  REQUIRED_TRUST_BOUNDARIES,
  validateLikeC4Export,
  validateThreatModelCheckIds,
  validateThreatRisks,
  verifyGeneratedMermaid,
} from './contract.mjs';

function likeC4Export() {
  const ids = Object.keys(REQUIRED_TRUST_BOUNDARIES);
  const elements = Object.fromEntries(ids.map(id => [id, {
    id,
    title: id,
    metadata: { trustBoundary: REQUIRED_TRUST_BOUNDARIES[id] },
  }]));
  const allPairs = [...REQUIRED_RELATIONSHIPS, ...REQUIRED_BIDIRECTIONAL_RELATIONSHIPS];
  const relations = Object.fromEntries(allPairs.map(([source, target], index) => [String(index), {
    id: String(index), source: { model: source }, target: { model: target },
    isBidirectional: REQUIRED_BIDIRECTIONAL_RELATIONSHIPS.some(([from, to]) => from === source && to === target),
  }]));
  return { elements, relations };
}

function threatRisks(status = 'unchecked') {
  return [
    'codexia-bola-project-isolation',
    'codexia-mcp-issuer-resource',
    'codexia-session-scope-confusion',
    'codexia-false-db-receipt',
    'codexia-edge-operations-plane',
    'codexia-backup-key-restore',
    'codexia-public-pages-disclosure',
  ].map((id, index) => ({
    category: id,
    risk_status: status,
    synthetic_id: id + '@asset-' + index,
    most_relevant_trust_boundary: REQUIRED_RISK_BOUNDARIES[id],
    most_relevant_technical_asset: REQUIRED_RISK_ASSETS[id],
  }));
}

test('LikeC4 export keeps approved element boundaries and trust relationships', () => {
  const model = likeC4Export();
  assert.equal(validateLikeC4Export(model), true);

  model.elements['codexia.fastify'].metadata.trustBoundary = 'edge';
  assert.throws(() => validateLikeC4Export(model), /codexia\.fastify.*application/u);

  const crossedPlane = likeC4Export();
  crossedPlane.relations.untrusted = {
    id: 'untrusted', source: { model: 'web' }, target: { model: 'codexia.backupExecutor' },
  };
  assert.throws(() => validateLikeC4Export(crossedPlane), /web -> codexia\.backupExecutor/u);

  const directShell = likeC4Export();
  directShell.relations.webToSsh = {
    id: 'webToSsh', source: { model: 'web' }, target: { model: 'codexia.ssh' },
  };
  assert.throws(() => validateLikeC4Export(directShell), /client.*host-operations|web -> codexia\.ssh/u);
});

test('Threagile risks cover each required scenario and cannot be silently suppressed', () => {
  assert.equal(validateThreatRisks(threatRisks()), true);

  const suppressed = threatRisks();
  suppressed[0].risk_status = 'mitigated';
  assert.throws(() => validateThreatRisks(suppressed), /codexia-bola-project-isolation.*suppressed/u);
  assert.throws(() => validateThreatRisks(threatRisks().slice(1)), /missing required risk codexia-bola-project-isolation/u);

  const misassignedBoundary = threatRisks();
  misassignedBoundary[0].most_relevant_trust_boundary = 'public-pages';
  assert.throws(() => validateThreatRisks(misassignedBoundary), /must remain in trust boundary codexia-vm/u);

  const misassignedAsset = threatRisks();
  misassignedAsset[0].most_relevant_technical_asset = 'public-pages';
  assert.throws(() => validateThreatRisks(misassignedAsset), /must remain attached to asset codexia-api/u);
});

test('each Threagile risk retains its existing verification references', () => {
  const source = readFileSync(new URL('../../docs/architecture/threagile/model.yaml', import.meta.url), 'utf8');
  assert.equal(validateThreatModelCheckIds(source), true);
  assert.deepEqual(Object.keys(REQUIRED_RISK_CHECK_IDS).sort(), Object.keys(REQUIRED_RISK_BOUNDARIES).sort());

  const missingReference = source.replace('AUTH-06', 'AUTH-X6');
  assert.throws(() => validateThreatModelCheckIds(missingReference),
    /codexia-bola-project-isolation.*verification reference AUTH-06/u);
});

test('public architecture inputs reject credential exposure', () => {
  assert.equal(assertNoPublicSecrets(['model: public C4 boundary']), true);
  const leaked = 'Authorization: Bearer ' + 'fixture-token-which-must-never-be-published';
  assert.throws(() => assertNoPublicSecrets([leaked]), /secret-like material/u);
});

test('checked Mermaid derivative binds exact LikeC4 source bytes and regenerated output', () => {
  const modelSource = "model { author = person 'Author' }\n";
  const generated = 'graph LR\n  Author["Author"]\n';
  const derivative = createGeneratedMermaid(modelSource, generated);
  const parsed = parseGeneratedMermaid(derivative);
  assert.equal(parsed.sourcePath, 'docs/architecture/likec4/model.likec4');
  assert.equal(parsed.generator, 'likec4@1.61.0');
  assert.equal(parsed.source, generated.trim());
  assert.equal(verifyGeneratedMermaid(modelSource, derivative, generated), true);

  assert.throws(() => verifyGeneratedMermaid(modelSource + ' // changed\n', derivative, generated), /source digest/u);
  assert.throws(() => verifyGeneratedMermaid(modelSource, derivative, generated + '  %% drift\n'), /regeneration/u);
});
