import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureSaveEvidence } from './execution.mjs';
import { createSource } from './source.mjs';

test('the canonical actor emits an unknown save and a same-operation receipt', async () => {
  const root = new URL('../../', import.meta.url);
  const canonical = createSource(root);
  const projection = { screens: [{ id: 'WRT-01', platform: 'desktop' }], states: [], transitions: [], scenarios: [] };
  const sha = 'a'.repeat(40);
  await captureSaveEvidence(canonical, fileURLToPath(root), sha, projection);
  const { transitions, scenarios } = projection;
  assert.equal(scenarios[0].initial, 'WRT-01/server/0/idle');
  const unknown = transitions.find(({ to }) => to.endsWith('/unknown'));
  const retry = transitions.find(({ event }) => event === 'SAVE.RETRY');
  const confirmation = transitions.find(({ to }) => to.endsWith('/confirmed'));
  assert.equal(unknown.context.receiptId, null);
  assert.equal(retry.from, unknown.to);
  assert.equal(confirmation.from, retry.to);
  assert.notEqual(unknown.from, confirmation.from);
  assert.equal(retry.context.operationId, unknown.context.operationId);
  assert.equal(confirmation.context.receiptId, 'synthetic-receipt');
  assert.equal(confirmation.evidence.sourceSha, sha);
  assert.equal(confirmation.method, 'trace');
});
