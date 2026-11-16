import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { StandaloneController, initialControllerState } from './standalone-update-controller.mjs';
import { signUpdateChannel } from './update-channel.mjs';

const release = {
  format: 'codexia-update-release/v1', channel: 'stable', state: 'published', version: '1.2.3',
  sourceSha: 'a'.repeat(40), image: 'ghcr.io/yohn-jp/codexia-backend@sha256:' + 'a'.repeat(64),
  platform: 'linux/amd64', profile: 'core', migrationFingerprint: 'sha256:' + 'b'.repeat(64),
  persistenceFormat: 1, apiEpoch: 1,
};

function fixture({ paused = false, timerActive = true, backupFailure = false, restoreFailure = false } = {}) {
  const host = {
    routeValue: 'blue',
    writers: [{ slot: 'blue', image: release.image }],
    timerActive,
    preflight: false,
    failBackup: backupFailure,
    failRestore: restoreFailure,
    trace: [],
    async observe() { return { route: this.routeValue, writers: structuredClone(this.writers) }; },
    async assertNoPreflight() { assert.equal(this.preflight, false, 'unexpected preflight container'); },
    async pollingTimerActive() { this.trace.push('timer-state'); return this.timerActive; },
    async stopPollingTimer() { this.trace.push('timer-stop'); this.timerActive = false; },
    async startPollingTimer() { this.trace.push('timer-start'); this.timerActive = true; },
    async route(value) { this.trace.push('route:' + value); this.routeValue = value; },
    async stopWriter(slot) {
      this.trace.push('stop:' + slot);
      this.writers = this.writers.filter(writer => writer.slot !== slot);
    },
    async startWriter(slot, candidate) {
      this.trace.push('start:' + slot);
      if (this.failRestore) throw new Error('writer restore failed');
      assert.equal(this.writers.length, 0);
      this.writers = [{ slot, image: candidate.image }];
    },
    async probe(slot) { assert.equal(slot, 'blue'); },
    async backup(destination, recipient) {
      this.trace.push('backup');
      assert.equal(destination, '/mnt/backup');
      assert.equal(recipient, 'age1recipient');
      if (this.failBackup) throw new Error('synthetic backup failure');
      return 'Encrypted backup committed';
    },
  };
  let persisted;
  const controller = new StandaloneController({
    host,
    store: { async save(state) { persisted = structuredClone(state); } },
    publicKey: null,
    observeMilliseconds: 0,
  });
  return {
    host, controller, persisted: () => persisted,
    state: { ...initialControllerState(release, 'blue', null), paused },
  };
}

test('backup fences the sole writer under controller lock and restores prior timer and pause state', async () => {
  const { host, controller, state, persisted } = fixture();
  const result = await controller.backup(state, { destination: '/mnt/backup', recipient: 'age1recipient' });

  assert.equal(result.output, 'Encrypted backup committed');
  assert.equal(result.state.paused, false);
  assert.deepEqual(result.state.journal, state.journal);
  assert.deepEqual(host.writers, [{ slot: 'blue', image: release.image }]);
  assert.equal(host.routeValue, 'blue');
  assert.equal(host.timerActive, true);
  assert.equal(persisted().paused, false);
  assert.ok(host.trace.indexOf('route:blocked') < host.trace.indexOf('stop:blue'));
  assert.ok(host.trace.indexOf('stop:blue') < host.trace.indexOf('backup'));
  assert.ok(host.trace.indexOf('backup') < host.trace.lastIndexOf('start:blue'));
  assert.ok(host.trace.lastIndexOf('start:blue') < host.trace.lastIndexOf('route:blue'));
  assert.ok(host.trace.lastIndexOf('route:blue') < host.trace.lastIndexOf('timer-start'));
});

test('failed backup still restores the original writer and prior paused/timer state', async () => {
  const { host, controller, state, persisted } = fixture({ paused: true, timerActive: false, backupFailure: true });
  await assert.rejects(controller.backup(state, { destination: '/mnt/backup', recipient: 'age1recipient' }), /synthetic backup failure/);

  assert.deepEqual(host.writers, [{ slot: 'blue', image: release.image }]);
  assert.equal(host.routeValue, 'blue');
  assert.equal(host.timerActive, false);
  assert.equal(persisted().paused, true);
  assert.deepEqual(persisted().journal, state.journal);
  assert.ok(!host.trace.includes('timer-stop'));
  assert.ok(!host.trace.includes('timer-start'));
});

test('ambiguous or missing prior writer blocks backup before any maintenance mutation', async () => {
  const missing = fixture();
  missing.host.writers = [];
  await assert.rejects(missing.controller.backup(missing.state, { destination: '/mnt/backup', recipient: 'age1recipient' }), /exactly one active writer/);
  assert.equal(missing.host.routeValue, 'blue');
  assert.ok(!missing.host.trace.includes('timer-stop'));
  assert.ok(!missing.host.trace.includes('route:blocked'));

  const multiple = fixture();
  multiple.host.writers.push({ slot: 'green', image: release.image });
  await assert.rejects(multiple.controller.backup(multiple.state, { destination: '/mnt/backup', recipient: 'age1recipient' }), /exactly one active writer/);
  assert.equal(multiple.host.routeValue, 'blue');
  assert.ok(!multiple.host.trace.includes('timer-stop'));
});

test('writer restoration failure leaves route blocked, controller paused, and timer stopped', async () => {
  const { host, controller, state, persisted } = fixture({ restoreFailure: true });
  await assert.rejects(controller.backup(state, { destination: '/mnt/backup', recipient: 'age1recipient' }), /restore failed/);

  assert.deepEqual(host.writers, []);
  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.timerActive, false);
  assert.equal(persisted().paused, true);
  assert.deepEqual(persisted().journal, state.journal);
  assert.ok(!host.trace.includes('timer-start'));
});

test('preflight drift is rejected before pausing or blocking the service', async () => {
  const { host, controller, state } = fixture();
  host.preflight = true;
  await assert.rejects(controller.backup(state, { destination: '/mnt/backup', recipient: 'age1recipient' }), /unexpected preflight container/);
  assert.equal(host.routeValue, 'blue');
  assert.ok(!host.trace.includes('timer-stop'));
  assert.ok(!host.trace.includes('route:blocked'));
});

function legacyFixture({ tunnelActive = true, timerActive = true, backupFailure = false, restoreFailure = false } = {}) {
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' });
  const privateKey = key.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const now = Date.parse('2026-11-12T12:00:00Z');
  const host = {
    routeValue: 'blocked',
    legacyActive: true,
    tunnelActive,
    timerActive,
    preflight: false,
    failBackup: backupFailure,
    failRestore: restoreFailure,
    trace: [],
    async fetchChannel() {
      return signUpdateChannel({
        format: 'codexia-update-channel/v1', sequence: 1,
        issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
        releases: [release],
      }, privateKey, now);
    },
    async frontendIdentity() { this.trace.push('frontend'); return { profile: 'core', apiEpoch: 1 }; },
    async routeState() { this.trace.push('route-state'); return this.routeValue; },
    async route(value) { this.trace.push('route:' + value); this.routeValue = value; },
    async legacyServiceActive() { this.trace.push('api-state'); return this.legacyActive; },
    async tunnelServiceActive() { this.trace.push('tunnel-state'); return this.tunnelActive; },
    async pollingTimerActive() { this.trace.push('timer-state'); return this.timerActive; },
    async stopPollingTimer() { this.trace.push('timer-stop'); this.timerActive = false; },
    async startPollingTimer() { this.trace.push('timer-start'); this.timerActive = true; },
    async assertNoPreflight() { assert.equal(this.preflight, false); },
    async assertLegacyRelease(candidate) { this.trace.push('verify-api'); assert.equal(this.legacyActive, true); assert.equal(candidate.image, release.image); },
    async stopTunnel() { this.trace.push('tunnel-stop'); this.tunnelActive = false; },
    async startTunnel() { this.trace.push('tunnel-start'); this.tunnelActive = true; },
    async stopLegacyWriter() { this.trace.push('api-stop'); this.legacyActive = false; },
    async startLegacyWriter() { this.trace.push('api-start'); if (this.failRestore) throw new Error('legacy API restore failed'); this.legacyActive = true; },
    async backup(destination, recipient) {
      this.trace.push('backup');
      assert.equal(destination, '/mnt/backup');
      assert.equal(recipient, 'age1recipient');
      if (this.failBackup) throw new Error('synthetic backup failure');
      return 'Encrypted legacy backup committed';
    },
  };
  const controller = new StandaloneController({
    host, store: { async save() { throw new Error('legacy backup must not create a journal'); } },
    publicKey, now: () => now,
  });
  return { host, controller };
}

test('pre-journal backup verifies the signed legacy identity and restores API, Tunnel, and timer', async () => {
  const { host, controller } = legacyFixture();
  const result = await controller.backupLegacy(release, { destination: '/mnt/backup', recipient: 'age1recipient' });

  assert.equal(result.output, 'Encrypted legacy backup committed');
  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.legacyActive, true);
  assert.equal(host.tunnelActive, true);
  assert.equal(host.timerActive, true);
  assert.ok(host.trace.indexOf('route:blocked') < host.trace.indexOf('tunnel-stop'));
  assert.ok(host.trace.indexOf('tunnel-stop') < host.trace.indexOf('api-stop'));
  assert.ok(host.trace.indexOf('api-stop') < host.trace.indexOf('backup'));
  assert.ok(host.trace.indexOf('backup') < host.trace.indexOf('api-start'));
  assert.ok(host.trace.indexOf('api-start') < host.trace.indexOf('tunnel-start'));
  assert.ok(host.trace.indexOf('tunnel-start') < host.trace.indexOf('timer-start'));
});

test('pre-journal backup failure restores prior services and timer before returning failure', async () => {
  const { host, controller } = legacyFixture({ backupFailure: true });
  await assert.rejects(controller.backupLegacy(release, { destination: '/mnt/backup', recipient: 'age1recipient' }), /synthetic backup failure/);
  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.legacyActive, true);
  assert.equal(host.tunnelActive, true);
  assert.equal(host.timerActive, true);
});

test('pre-journal recovery failure leaves the route blocked and does not restart ingress', async () => {
  const { host, controller } = legacyFixture({ restoreFailure: true });
  await assert.rejects(controller.backupLegacy(release, { destination: '/mnt/backup', recipient: 'age1recipient' }), /Legacy backup recovery blocked/);
  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.legacyActive, false);
  assert.equal(host.tunnelActive, false);
  assert.equal(host.timerActive, false);
});
