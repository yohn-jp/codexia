import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, compareDesign, hash, validateOperand } from './model.mjs';

const repository = 'yohn-jp/codexia';
const sha = 'a'.repeat(40);
const blank = { screens: [], controls: [], states: [], transitions: [], scenarios: [], journeys: [] };
const observedBlank = { screens: [], controls: [], states: [], transitions: [], scenarios: [] };
const snapshot = (sourceSha = sha) => ({
  schemaVersion: 2, repository, sourceSha, expected: { ...blank, screens: [{ id: 'WRT-01', platforms: ['desktop'], adoption: 'adopted' }] },
  observed: { ...observedBlank, screens: [{ id: 'WRT-01', platform: 'desktop', source: { path: 'app/src/editor.tsx', line: 12 } }] },
  coverage: [{ id: 'WRT-01', platform: 'desktop', status: 'unobserved' }],
});

async function operand(data) {
  const raw = JSON.stringify(data);
  const outputs = { 'snapshot.json': await hash(raw) };
  return {
    raw, manifest: { schemaVersion: 2, repository, sourceSha: data.sourceSha, route: '/ux/',
      inputs: { projection: outputs['snapshot.json'], asset: await hash(JSON.stringify(outputs)) },
      outputs, coverage: data.coverage, evidence: { productVerified: 'not-evaluated' },
    },
  };
}

test('same-source comparison keeps an extracted screen distinct from execution proof', () => {
  const rows = compareDesign(snapshot());
  assert.equal(rows.find(({ id }) => id === 'WRT-01').status, 'unobserved');
});

test('verified structured operands reject schema, digest, repository and duplicate identities', async () => {
  const input = await operand(snapshot());
  assert.equal((await validateOperand(input)).sourceSha, sha);
  await assert.rejects(validateOperand({ ...input, raw: input.raw + ' ' }), /digest/);
  await assert.rejects(validateOperand({ ...input, manifest: { ...input.manifest, schemaVersion: 1 } }), /schema/);
  await assert.rejects(validateOperand(await operand({ ...snapshot(), repository: 'elsewhere/codexia' })), /repository/);
  const data = snapshot();
  data.observed.controls = [{ id: 'WRT-01.A', platform: 'desktop' }, { id: 'WRT-01.A', platform: 'desktop' }];
  await assert.rejects(validateOperand(await operand(data)), /Duplicate/);
});

test('two-version comparison ignores line movement and finds actual removed and changed transitions', () => {
  const left = snapshot();
  const right = snapshot('b'.repeat(40));
  left.observed.transitions = [{ id: 'save', platform: 'desktop', from: 'draft', to: 'saving' }];
  right.observed.transitions = [{ id: 'save', platform: 'desktop', from: 'draft', to: 'unknown' }];
  right.observed.screens[0].source.line = 25;
  const changes = compareVersions(left, right);
  assert.deepEqual(changes.map(({ type, change, id }) => [type, change, id]), [['observed.transitions', 'changed', 'save']]);
  right.observed.transitions = [];
  assert.equal(compareVersions(left, right)[0].change, 'removed');
});

test('two-version comparison includes design-only journeys', () => {
  const left = snapshot();
  const right = snapshot('b'.repeat(40));
  left.expected.journeys = [{ id: 'journey-5', label: 'Author saves', screens: ['WRT-01'] }];
  right.expected.journeys = [{ id: 'journey-5', label: 'Author saves and retries', screens: ['WRT-01'] }];
  assert.deepEqual(compareVersions(left, right).map(({ type, change, id }) => [type, change, id]),
    [['expected.journeys', 'changed', 'journey-5']]);
});
