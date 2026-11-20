import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertMatchingControllerBackup, validateControllerState } from './standalone-update-controller.mjs';
import { verifyUpdateChannel } from './update-channel.mjs';
import { validateUpdateRelease } from './update-release-policy.mjs';

const digest = /^sha256:[a-f0-9]{64}$/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const phases = ['prepared', 'applying', 'committed'];

function version(value) {
  return value.split('.').map(Number);
}

export function assertSameEpochAdditiveTarget(installedValue, targetValue) {
  const installed = validateUpdateRelease(installedValue);
  const target = validateUpdateRelease(targetValue);
  assert.equal(target.state, 'published', 'Schema target must be published');
  assert.notEqual(target.image, installed.image, 'Schema target must be a new immutable image');
  assert.notEqual(target.sourceSha, installed.sourceSha, 'Schema target must be a new source revision');
  for (const field of ['platform', 'profile', 'persistenceFormat', 'apiEpoch']) {
    assert.equal(target[field], installed[field], `Same-epoch schema target changed ${field}`);
  }
  assert.notEqual(target.migrationFingerprint, installed.migrationFingerprint, 'Schema target must advance the migration fingerprint');
  assert.ok(version(target.version).some((part, index) => part > version(installed.version)[index] && version(target.version).slice(0, index).every((value, i) => value === version(installed.version)[i])), 'Schema target version must advance');
  return { installed, target };
}

export function validateSchemaMaintenanceIntent(value) {
  assert.deepEqual(Object.keys(value ?? {}).sort(), ['createdAt', 'databaseId', 'format', 'journalGeneration', 'operationId', 'phase', 'priorPaused', 'priorRelease', 'priorSlot', 'priorTimerWasActive', 'routeFile', 'stateFile', 'targetRelease'].sort());
  assert.equal(value.format, 'codexia-schema-maintenance/v1');
  assert.match(value.operationId, uuid, 'Schema maintenance operation ID is invalid');
  assert.ok(phases.includes(value.phase), 'Schema maintenance phase is invalid');
  assert.ok(Number.isFinite(Date.parse(value.createdAt)), 'Schema maintenance timestamp is invalid');
  assert.match(value.databaseId, /^[1-9]\d{0,19}:[1-9]\d{0,9}$/u, 'Schema maintenance database identity is invalid');
  assert.ok(Number.isSafeInteger(value.journalGeneration) && value.journalGeneration >= 0);
  assert.equal(typeof value.priorPaused, 'boolean');
  assert.equal(typeof value.priorTimerWasActive, 'boolean');
  assert.ok(['blue', 'green'].includes(value.priorSlot));
  assert.ok(typeof value.stateFile === 'string' && typeof value.routeFile === 'string');
  const { installed: priorRelease, target: targetRelease } = assertSameEpochAdditiveTarget(value.priorRelease, value.targetRelease);
  return { ...value, priorRelease, targetRelease };
}

function targetState(state, target, checkpoint, slot) {
  return validateControllerState({ ...state, installed: target, previous: state.installed,
    pending: null, paused: state.paused, lastError: null, lastSuccessAt: new Date().toISOString(),
    journal: { ...state.journal, generation: state.journal.generation + 1, phase: 'committed',
      active: { slot, image: target.image }, candidate: null, checkpoint } });
}

async function assertWriter(controller, state, slot, release, route) {
  const observed = await controller.host.observe();
  assert.deepEqual(observed.writers, [{ slot, image: release.image }], 'Schema maintenance writer is not exclusive');
  assert.equal(observed.route, route, 'Schema maintenance route is not as expected');
  await controller.host.probe(slot, release);
}

/**
 * Execute the disruptive portion of same-epoch schema maintenance. The caller
 * must already hold the updater lock; markerStore must use atomic, fsynced
 * writes. No old release is restored after the migration transaction starts.
 */
export async function runSchemaMaintenance({ controller, state: stateValue, target: targetValue, source, restore, markerStore, stateFile, routeFile }) {
  let state = validateControllerState(stateValue);
  const { installed, target } = assertSameEpochAdditiveTarget(state.installed, targetValue);
  assert.ok(state.lastError === null && ['idle', 'committed'].includes(state.journal.phase), 'Schema maintenance requires a healthy stable controller');
  const channel = verifyUpdateChannel(await controller.host.fetchChannel(), controller.publicKey, state.journal.checkpoint, controller.now());
  assert.ok(channel.payload.releases.some(item => item.state === 'published' && JSON.stringify(item) === JSON.stringify(target)), 'Schema target is absent from the authenticated channel');
  await controller.uiEpoch(target);
  await controller.host.pullAndVerify(target);
  const databaseId = await controller.host.freshDatabaseIdentity();
  const backupHash = await controller.host.backupArtifactIdentity(source.artifactDirectory);
  assertMatchingControllerBackup(source, restore, state, databaseId, backupHash);
  const observed = await controller.host.observe();
  assert.deepEqual(observed.writers, [{ slot: state.journal.active.slot, image: installed.image }], 'Schema maintenance requires one active installed writer');
  assert.equal(observed.route, state.journal.active.slot, 'Schema maintenance requires the active route');
  const timerWasActive = await controller.host.pollingTimerActive();
  const intent = validateSchemaMaintenanceIntent({ format: 'codexia-schema-maintenance/v1', operationId: randomUUID(), phase: 'prepared',
    createdAt: new Date(controller.now()).toISOString(), databaseId, journalGeneration: state.journal.generation,
    priorPaused: state.paused, priorTimerWasActive: timerWasActive, priorSlot: state.journal.active.slot,
    priorRelease: installed, targetRelease: target, stateFile, routeFile });
  await markerStore.save(intent);
  try {
    if (timerWasActive) await controller.host.stopPollingTimer();
    await controller.host.route('blocked');
    await controller.host.stopWriter(intent.priorSlot);
    assert.deepEqual((await controller.host.observe()).writers, [], 'Schema maintenance writer fence was not confirmed');
    await markerStore.save({ ...intent, phase: 'applying' });
    const result = await controller.host.applyAdditiveSchema(target, installed.migrationFingerprint, target.migrationFingerprint);
    assert.deepEqual(result.fingerprint, target.migrationFingerprint, 'Schema migration returned an uncertified fingerprint');
    state = targetState(state, target, channel.checkpoint, intent.priorSlot);
    await markerStore.save({ ...intent, phase: 'committed' });
    await controller.save(state);
    await controller.host.startWriter(intent.priorSlot, target);
    const route = state.paused ? 'blocked' : intent.priorSlot;
    await controller.host.route(route);
    await assertWriter(controller, state, intent.priorSlot, target, route);
    if (timerWasActive && !state.paused) await controller.host.startPollingTimer();
    await markerStore.clear();
    return state;
  } catch (error) {
    await controller.host.route('blocked').catch(() => undefined);
    await controller.host.stopPollingTimer().catch(() => undefined);
    throw error;
  }
}

/** Recover only an interrupted marker. Prior state is restored only when the
 * target migration has not committed; an uncertain fingerprint remains blocked. */
export async function recoverSchemaMaintenance({ controller, state: stateValue, markerStore }) {
  const marker = validateSchemaMaintenanceIntent(await markerStore.load());
  let state = validateControllerState(stateValue);
  await controller.host.route('blocked');
  await controller.host.stopPollingTimer().catch(() => undefined);
  const observeFingerprint = async release => controller.host.schemaFingerprint(release).catch(() => null);
  const targetFingerprint = await observeFingerprint(marker.targetRelease);
  const priorFingerprint = await observeFingerprint(marker.priorRelease);
  const targetCommitted = targetFingerprint === marker.targetRelease.migrationFingerprint;
  const priorIntact = priorFingerprint === marker.priorRelease.migrationFingerprint;
  if (targetCommitted === priorIntact) throw new Error('Schema maintenance recovery cannot classify database state');
  const release = targetCommitted ? marker.targetRelease : marker.priorRelease;
  const slot = marker.priorSlot;
  state = targetCommitted ? targetState(state, release, state.journal.checkpoint, slot) : state;
  const recoveredPaused = targetCommitted ? marker.priorPaused : marker.priorPaused;
  await controller.save({ ...state, paused: recoveredPaused, lastError: null });
  await controller.host.startWriter(slot, release);
  const route = recoveredPaused ? 'blocked' : slot;
  await controller.host.route(route);
  await assertWriter(controller, state, slot, release, route);
  if (marker.priorTimerWasActive && !recoveredPaused) await controller.host.startPollingTimer();
  await markerStore.clear();
  return state;
}
