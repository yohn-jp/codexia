const repository = 'yohn-jp/codexia';
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const groups = ['screens', 'controls', 'states', 'transitions', 'scenarios'];
const expectedOnlyGroups = ['journeys'];
const projectionModes = ['expected', 'observed'];
const coverageStates = new Set(['observed', 'unobserved', 'unextracted', 'unimplemented', 'implementation-only',
  'excluded', 'proposal', 'external', 'conceptual']);
export const maxBytes = 4 * 1024 * 1024;

export async function hash(value) {
  const bytes = new TextEncoder().encode(value);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonical(value, ignoreSourcePositions = false) {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry, ignoreSourcePositions));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => !(ignoreSourcePositions
    && (key === 'sourceSha' || ((key === 'line' || key === 'anchor') && Object.hasOwn(value, 'path')))))
    .map((key) => [key, canonical(value[key], ignoreSourcePositions)]));
}

const serialize = (value, ignoreSourcePositions) => JSON.stringify(canonical(value, ignoreSourcePositions));
const identity = (row) => (row.platform ?? row.platforms?.join(',') ?? '') + '/' + row.id;

function indexed(values) {
  if (!Array.isArray(values)) throw new Error('Missing projection collection');
  const map = new Map();
  for (const value of values) {
    if (typeof value?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,180}$/.test(value.id)) {
      throw new Error('Invalid projection ID');
    }
    const key = identity(value);
    if (map.has(key)) throw new Error('Duplicate projection ID: ' + key);
    map.set(key, value);
  }
  return map;
}

export async function validateOperand({ manifest, raw }) {
  if (!manifest || typeof raw !== 'string' || raw.length > maxBytes) throw new Error('Missing or oversized projection');
  if (manifest.schemaVersion !== 2) throw new Error('Unsupported schema');
  if (manifest.repository !== repository || manifest.route !== '/ux/') throw new Error('Unexpected repository or route');
  if (!sha.test(manifest.sourceSha ?? '')) throw new Error('Invalid source SHA');
  const outputs = manifest.outputs;
  const projection = outputs?.['snapshot.json'];
  if (!digest.test(projection ?? '') || manifest.inputs?.projection !== projection || await hash(raw) !== projection
    || !Object.values(outputs).every((value) => digest.test(value)) || await hash(JSON.stringify(outputs)) !== manifest.inputs.asset) {
    throw new Error('Artifact digest mismatch');
  }
  const snapshot = JSON.parse(raw);
  if (snapshot.schemaVersion !== 2) throw new Error('Unsupported projection schema');
  if (snapshot.repository !== repository) throw new Error('Unexpected projection repository');
  if (snapshot.sourceSha !== manifest.sourceSha) throw new Error('Projection source SHA mismatch');
  for (const mode of projectionModes) for (const group of groups) indexed(snapshot[mode]?.[group]);
  for (const group of expectedOnlyGroups) indexed(snapshot.expected?.[group]);
  if (Object.hasOwn(snapshot.observed ?? {}, 'journeys')) throw new Error('Observed projection cannot claim design journeys');
  indexed(snapshot.coverage);
  if (serialize(snapshot.coverage) !== serialize(manifest.coverage)
    || snapshot.coverage.some(({ status }) => !coverageStates.has(status))
    || manifest.evidence?.productVerified !== 'not-evaluated') throw new Error('Invalid coverage or product evidence');
  return snapshot;
}

export function compareDesign(snapshot) {
  const expected = new Map(groups.slice(0, 2).flatMap((name) => snapshot.expected[name]).map((record) => [record.id, record]));
  const observed = new Map(groups.slice(0, 2).flatMap((name) => snapshot.observed[name]).map((record) => [identity(record), record]));
  return snapshot.coverage.filter(({ status }) => status !== 'excluded').map((record) => {
    const screen = snapshot.expected.screens.find(({ id }) => id === record.id);
    const conditions = snapshot.expected.scenarios.filter(({ screens, platforms }) =>
      screens?.includes(screen?.id) && platforms?.includes(record.platform));
    return {
      ...record, expected: expected.get(record.id), observed: observed.get(identity(record)),
      designTransitions: snapshot.expected.transitions.filter(({ scenario }) => conditions.some(({ id }) => id === scenario)),
      implementationTransitions: snapshot.observed.transitions.filter(({ screen, control, platform }) =>
        (screen === record.id || control === record.id) && platform === record.platform),
    };
  });
}

export function compareVersions(left, right) {
  const categories = projectionModes.flatMap((mode) => groups.map((group) => [
    mode + '.' + group, left[mode][group], right[mode][group],
  ]));
  categories.push(...expectedOnlyGroups.map((group) => ['expected.' + group, left.expected[group], right.expected[group]]));
  categories.push(['coverage', left.coverage, right.coverage]);
  return categories.flatMap(([type, previous, current]) => {
    const before = indexed(previous);
    const after = indexed(current);
    const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
    return keys.flatMap((key) => {
      const left = before.get(key);
      const right = after.get(key);
      const change = !left ? 'added' : !right ? 'removed' : serialize(left, true) !== serialize(right, true) ? 'changed' : null;
      return change ? [{ type, change, id: (right ?? left).id, platform: (right ?? left).platform, before: left, after: right }] : [];
    });
  });
}
