import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const phases = ['idle','detected','verified','pulled','candidate-ready','draining','switched','observing','committed','rollback','blocked'];
const digest = /^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u;
const checkpointDigest = /^sha256:[a-f0-9]{64}$/u;
const safeSlot = value => value === 'blue' || value === 'green';
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
const next = {
  idle: ['detected'], detected: ['verified','blocked'], verified: ['pulled','blocked'],
  pulled: ['candidate-ready','blocked'], 'candidate-ready': ['draining','blocked'],
  draining: ['switched','blocked'], switched: ['observing','rollback','blocked'],
  observing: ['committed','rollback','blocked'], committed: ['detected'],
  rollback: ['blocked','idle'], blocked: ['idle'],
};

export function validateJournal(value) {
  if (!exact(value, ['format','generation','phase','active','candidate','checkpoint']) ||
      value.format !== 'codexia-updater-journal/v1' ||
      !Number.isSafeInteger(value.generation) || value.generation < 0 ||
      !phases.includes(value.phase) ||
      !exact(value.active, ['slot','image']) || !safeSlot(value.active.slot) ||
      typeof value.active.image !== 'string' || !digest.test(value.active.image) ||
      (value.candidate !== null && (!exact(value.candidate,['slot','image']) ||
        !safeSlot(value.candidate.slot) || typeof value.candidate.image !== 'string' ||
        !digest.test(value.candidate.image) || value.candidate.slot === value.active.slot ||
        value.candidate.image === value.active.image)) ||
      (value.checkpoint !== null && (!exact(value.checkpoint,['sequence','sha256']) ||
        !Number.isSafeInteger(value.checkpoint.sequence) || value.checkpoint.sequence < 1 ||
        typeof value.checkpoint.sha256 !== 'string' || !checkpointDigest.test(value.checkpoint.sha256)))) {
    throw new Error('Invalid updater journal');
  }
  if (['detected','verified','pulled','candidate-ready','draining','switched','observing','rollback'].includes(value.phase) && !value.candidate) {
    throw new Error('Update phase requires a candidate');
  }
  if (['idle','committed'].includes(value.phase) && value.candidate) throw new Error('Stable phase cannot retain candidate');
  return structuredClone(value);
}

export function advanceJournal(currentValue, event) {
  const current = validateJournal(currentValue);
  assert.ok(event && typeof event === 'object' && !Array.isArray(event), 'Invalid updater event');
  const { to, candidate, checkpoint, proof } = event;
  assert.ok(next[current.phase]?.includes(to), 'Forbidden updater transition');
  const updated = { ...current, generation: current.generation + 1, phase: to };
  if (to === 'detected') {
    assert.ok(candidate && exact(candidate,['slot','image']) && candidate.slot !== current.active.slot, 'Candidate must occupy inactive slot');
    assert.ok(checkpoint && checkpointDigest.test(checkpoint.sha256) && Number.isSafeInteger(checkpoint.sequence) && checkpoint.sequence >= 1, 'Authenticated channel checkpoint required');
    if (current.checkpoint && (checkpoint.sequence < current.checkpoint.sequence ||
      (checkpoint.sequence === current.checkpoint.sequence && checkpoint.sha256 !== current.checkpoint.sha256))) throw new Error('Channel rollback or equivocation');
    updated.candidate = candidate;
    updated.checkpoint = checkpoint;
  }
  if (to === 'verified') assert.equal(proof?.channelVerified, true, 'Authenticated candidate verification required');
  if (to === 'pulled') assert.equal(proof?.artifactVerified, true, 'Immutable artifact verification required');
  if (to === 'candidate-ready') {
    assert.equal(proof?.ready, true, 'Candidate readiness required');
    assert.equal(proof?.candidateReadOnly, true, 'Candidate must be fenced from writes');
    assert.equal(proof?.migrationDisabled, true, 'Automatic DB migrations prohibited');
  }
  if (to === 'draining') assert.equal(proof?.oldAdmissionClosed, true, 'Old writer must stop admitting writes');
  if (to === 'switched') {
    assert.equal(proof?.oldWriterFenced, true, 'Old writer fencing required');
    assert.equal(proof?.newWriterExclusive, true, 'Exclusive new writer ownership required');
    assert.equal(proof?.proxyOnCandidate, true, 'Proxy switch observation required');
  }
  if (to === 'observing') assert.equal(proof?.candidateServing, true, 'New API observation required');
  if (to === 'committed') {
    assert.equal(proof?.candidateHealthy, true, 'Observation window health required');
    assert.equal(proof?.oldWriterFenced, true, 'Old writer fencing required');
    updated.active = current.candidate;
    updated.candidate = null;
  }
  if (to === 'rollback') {
    assert.equal(proof?.candidateWriterFenced, true, 'Candidate writer fencing required');
    assert.equal(proof?.oldImageCompatible, true, 'Rollback compatibility required');
    assert.equal(proof?.proxyOnOld, true, 'Old proxy route observation required');
  }
  if (to === 'idle') {
    assert.equal(proof?.activeWriterExclusive, true, 'Single-writer observation required');
    assert.equal(proof?.proxyOnActive, true, 'Active proxy observation required');
    updated.candidate = null;
  }
  return validateJournal(updated);
}

export function recoveryDecision(value, observation) {
  const journal = validateJournal(value);
  if (!observation || !safeSlot(observation.proxySlot) ||
      !Array.isArray(observation.writerSlots) || !observation.writerSlots.every(safeSlot) ||
      new Set(observation.writerSlots).size !== observation.writerSlots.length) return 'blocked';
  if (observation.writerSlots.length > 1) return 'blocked';
  if (journal.phase === 'idle' || journal.phase === 'committed') {
    return observation.proxySlot === journal.active.slot && observation.writerSlots[0] === journal.active.slot ? 'resume-polling' : 'blocked';
  }
  // No automated recovery after a partially completed cutover: the proxy, writer and
  // journal are not an atomic transaction. Require operator reconciliation.
  return 'blocked';
}

export async function saveJournal(filename, value) {
  const journal = validateJournal(value);
  const dir = path.dirname(filename);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(filename)}.${process.pid}.${createHash('sha256').update(String(Math.random())).digest('hex').slice(0,12)}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(journal) + '\n');
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temp, filename);
    const directory = await open(dir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (handle) await handle.close();
    await rm(temp, { force: true });
  }
}

export async function loadJournal(filename) {
  const content = await readFile(filename, 'utf8');
  if (content.length > 16384) throw new Error('Updater journal exceeds limit');
  return validateJournal(JSON.parse(content));
}

/** Host-only lock; no stale lock removal or implicit takeover. */
export async function withUpdateLock(filename, callback) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const handle = await open(filename, 'wx', 0o600);
  try { return await callback(); } finally { await handle.close(); await rm(filename, { force: true }); }
}
