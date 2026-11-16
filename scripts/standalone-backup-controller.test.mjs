import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { atomicWrite, loadBackupIntent, StandaloneController, initialControllerState, validateBackupIntent } from './standalone-update-controller.mjs';
import { assertLegacyBackupIdentity, assertLegacyBackupUnitIdentity, assertVersion } from '../deploy/updater/standalone-host.mjs';
import { signUpdateChannel } from './update-channel.mjs';

const release = {
  format: 'codexia-update-release/v1', channel: 'stable', state: 'published', version: '1.2.3',
  sourceSha: 'a'.repeat(40), image: 'ghcr.io/yohn-jp/codexia-backend@sha256:' + 'a'.repeat(64),
  platform: 'linux/amd64', profile: 'core', migrationFingerprint: 'sha256:' + 'b'.repeat(64),
  persistenceFormat: 1, apiEpoch: 1,
};

function controllerBackupIntent(overrides = {}) {
  return {
    format: 'codexia-backup-intent/v1', kind: 'controller', slot: 'blue', image: release.image,
    journalGeneration: 0, priorPaused: false, priorLastError: null, timerWasActive: true,
    createdAt: '2026-11-12T12:00:00.000Z', ...overrides,
  };
}

function legacyBackupIntent(overrides = {}) {
  return {
    format: 'codexia-backup-intent/v1', kind: 'legacy', release,
    legacyUnitFingerprint: 'f'.repeat(64),
    tunnelWasActive: true, timerWasActive: true,
    createdAt: '2026-11-12T12:00:00.000Z', ...overrides,
  };
}

test('backup intent is durable, owner-private, and rejects symlinks or undeclared fields', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-backup-intent-'));
  const filename = path.join(directory, 'backup-intent.json');
  const target = path.join(directory, 'target.json');
  try {
    const intent = controllerBackupIntent();
    await atomicWrite(filename, JSON.stringify(intent) + '\n');
    assert.deepEqual(await loadBackupIntent(filename), intent);
    assert.throws(() => validateBackupIntent({ ...intent, recipient: 'age1not-a-recovery-secret' }));
    await chmod(filename, 0o644);
    await assert.rejects(loadBackupIntent(filename), /permissions must be private/);
    await rm(filename);
    await atomicWrite(target, JSON.stringify(intent) + '\n');
    await symlink(target, filename);
    await assert.rejects(loadBackupIntent(filename), /regular file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function fixture({ paused = false, timerActive = true, backupFailure = false, restoreFailure = false, destinationFailure = false } = {}) {
  let backupIntent = null;
  const host = {
    routeValue: 'blue',
    writers: [{ slot: 'blue', image: release.image }],
    timerActive,
    preflight: false,
    failBackup: backupFailure,
    failRestore: restoreFailure,
    failDestination: destinationFailure,
    trace: [],
    async observe() { return { route: this.routeValue, writers: structuredClone(this.writers) }; },
    async assertNoPreflight() { assert.equal(this.preflight, false, 'unexpected preflight container'); },
    async validateBackupDestination(destination) {
      this.trace.push('validate-destination');
      assert.equal(destination, '/mnt/backup');
      if (this.failDestination) throw new Error('destination is not an approved remote filesystem');
    },
    async pollingTimerActive() { this.trace.push('timer-state'); return this.timerActive; },
    async stopPollingTimer() { this.trace.push('timer-stop'); this.timerActive = false; },
    async startPollingTimer() { this.trace.push('timer-start'); this.timerActive = true; },
    async route(value) { this.trace.push('route:' + value); this.routeValue = value; },
    async stopWriter(slot) {
      this.trace.push('stop:' + slot);
      this.writers = this.writers.filter(writer => writer.slot !== slot);
    },
    async pullAndVerify(candidate) { this.trace.push('verify:' + candidate.image); },
    async prepare(slot) { this.trace.push('prepare:' + slot); },
    async stopPreflight(slot) { this.trace.push('preflight-stop:' + slot); },
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
    store: {
      async save(state) { persisted = structuredClone(state); },
      async saveBackupIntent(value) { host.trace.push('intent-save'); backupIntent = structuredClone(value); },
      async loadBackupIntent() { return backupIntent && structuredClone(backupIntent); },
      async clearBackupIntent() { host.trace.push('intent-clear'); backupIntent = null; },
    },
    publicKey: null,
    observeMilliseconds: 0,
  });
  return {
    host, controller, persisted: () => persisted, backupIntent: () => backupIntent,
    state: { ...initialControllerState(release, 'blue', null), paused },
  };
}

test('backup fences the sole writer under controller lock and restores prior timer and pause state', async () => {
  const { host, controller, state, persisted, backupIntent } = fixture();
  const result = await controller.backup(state, { destination: '/mnt/backup', recipient: 'age1recipient' });

  assert.equal(result.output, 'Encrypted backup committed');
  assert.equal(result.state.paused, false);
  assert.deepEqual(result.state.journal, state.journal);
  assert.deepEqual(host.writers, [{ slot: 'blue', image: release.image }]);
  assert.equal(host.routeValue, 'blue');
  assert.equal(host.timerActive, true);
  assert.equal(persisted().paused, false);
  assert.equal(backupIntent(), null);
  assert.ok(host.trace.indexOf('intent-save') < host.trace.indexOf('timer-stop'));
  assert.ok(host.trace.lastIndexOf('intent-clear') > host.trace.lastIndexOf('timer-start'));
  assert.ok(host.trace.indexOf('route:blocked') < host.trace.indexOf('stop:blue'));
  assert.ok(host.trace.indexOf('stop:blue') < host.trace.indexOf('backup'));
  assert.ok(host.trace.indexOf('backup') < host.trace.lastIndexOf('start:blue'));
  assert.ok(host.trace.lastIndexOf('start:blue') < host.trace.lastIndexOf('route:blue'));
  assert.ok(host.trace.lastIndexOf('route:blue') < host.trace.lastIndexOf('timer-start'));
});

test('boot recovery resumes an interrupted controller backup from each persisted topology boundary', async () => {
  const boundaries = [
    { name: 'after timer stop', timerActive: false, route: 'blue', writers: [{ slot: 'blue', image: release.image }] },
    { name: 'after route block', timerActive: false, route: 'blocked', writers: [{ slot: 'blue', image: release.image }] },
    { name: 'after writer stop', timerActive: false, route: 'blocked', writers: [] },
  ];
  for (const boundary of boundaries) {
    const { host, controller, state } = fixture();
    host.timerActive = boundary.timerActive;
    host.routeValue = boundary.route;
    host.writers = structuredClone(boundary.writers);
    await controller.store.saveBackupIntent(controllerBackupIntent());

    const recovered = await controller.recoverBackupIntent({ ...state, paused: true });

    assert.equal(recovered.paused, false, boundary.name);
    assert.equal(recovered.lastError, null, boundary.name);
    assert.deepEqual(host.writers, [{ slot: 'blue', image: release.image }], boundary.name);
    assert.equal(host.routeValue, 'blue', boundary.name);
    assert.equal(host.timerActive, true, boundary.name);
    assert.equal(await controller.store.loadBackupIntent(), null, boundary.name);
  }
});

test('interrupted controller backup with an unrecognized writer stays blocked and preserves its intent', async () => {
  const { host, controller, state } = fixture();
  const unexpected = release.image.replace(/a{64}$/u, 'd'.repeat(64));
  host.timerActive = false;
  host.routeValue = 'blocked';
  host.writers = [{ slot: 'blue', image: unexpected }];
  await controller.store.saveBackupIntent(controllerBackupIntent());

  await assert.rejects(controller.recoverBackupIntent({ ...state, paused: true }), /Backup recovery blocked/);

  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.timerActive, false);
  assert.deepEqual(host.writers, [{ slot: 'blue', image: unexpected }]);
  assert.notEqual(await controller.store.loadBackupIntent(), null);
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

test('stable backup rejects an invalid destination before pausing or fencing the writer', async () => {
  const { host, controller, state } = fixture({ destinationFailure: true });
  await assert.rejects(controller.backup(state, { destination: '/mnt/backup', recipient: 'age1recipient' }), /not an approved remote filesystem/);
  assert.deepEqual(host.writers, [{ slot: 'blue', image: release.image }]);
  assert.equal(host.routeValue, 'blue');
  assert.equal(host.timerActive, true);
  assert.ok(!host.trace.includes('timer-stop'));
  assert.ok(!host.trace.includes('route:blocked'));
  assert.ok(!host.trace.includes('stop:blue'));
});

function legacyFixture({ tunnelActive = true, timerActive = true, backupFailure = false, restoreFailure = false, destinationFailure = false } = {}) {
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' });
  const privateKey = key.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const now = Date.parse('2026-11-12T12:00:00Z');
  const host = {
    routeValue: 'blocked',
    legacyActive: true,
    legacyContainerPresent: true,
    legacyUnitFingerprint: 'f'.repeat(64),
    startupFence: false,
    apiStartupFence: false,
    tunnelStartupFence: false,
    backupIntent: null,
    tunnelActive,
    timerActive,
    preflight: false,
    failBackup: backupFailure,
    failRestore: restoreFailure,
    failDestination: destinationFailure,
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
    async installBackupStartupFence() {
      this.trace.push('fence-install');
      this.startupFence = true; this.apiStartupFence = true; this.tunnelStartupFence = true;
    },
    async assertBackupStartupFence() { assert.equal(this.startupFence, true); },
    async removeLegacyBackupStartupFence() { this.trace.push('api-fence-remove'); this.apiStartupFence = false; this.startupFence = this.tunnelStartupFence; },
    async removeTunnelBackupStartupFence() { this.trace.push('tunnel-fence-remove'); this.tunnelStartupFence = false; this.startupFence = this.apiStartupFence; },
    async removeBackupStartupFence() { this.trace.push('fence-remove'); this.startupFence = false; this.apiStartupFence = false; this.tunnelStartupFence = false; },
    async validateBackupDestination(destination) {
      this.trace.push('validate-destination');
      assert.equal(destination, '/mnt/backup');
      if (this.failDestination) throw new Error('destination is not an approved remote filesystem');
    },
    async assertLegacyBackupRelease(candidate, { allowStopped = false, expectedUnitFingerprint } = {}) {
      this.trace.push('verify-api');
      if (expectedUnitFingerprint) assert.equal(this.legacyUnitFingerprint, expectedUnitFingerprint, 'Legacy Quadlet/systemd source drifted');
      if (!this.legacyContainerPresent) {
        assert.ok(allowStopped, 'Legacy writer container is missing');
        assert.ok(expectedUnitFingerprint, 'Stopped legacy writer requires its captured Quadlet/systemd fingerprint');
        return this.legacyUnitFingerprint;
      }
      const imageId = 'c'.repeat(64);
      assertLegacyBackupIdentity({
        legacy: { State: { Running: this.legacyActive }, Image: 'sha256:' + imageId, Config: { Env: ['CODEXIA_BROWSER_AUTH=token'] } },
        image: { Id: 'sha256:' + imageId, RepoDigests: [release.image], Os: 'linux', Architecture: 'amd64', Labels: { 'org.opencontainers.image.revision': release.sourceSha } },
        version: this.legacyActive ? { name: 'codexia', version: candidate.version, profile: candidate.profile, hosted: false, browserAuth: 'token' } : null,
      }, candidate, { CODEXIA_BROWSER_AUTH: 'token' }, { requireRunning: !allowStopped });
      return this.legacyUnitFingerprint;
    },
    async stopTunnel() { this.trace.push('tunnel-stop'); this.tunnelActive = false; },
    async startTunnel() { this.trace.push('tunnel-start'); this.tunnelActive = true; },
    async stopLegacyWriter() { this.trace.push('api-stop'); this.legacyActive = false; this.legacyContainerPresent = false; },
    async startLegacyWriter() { this.trace.push('api-start'); if (this.failRestore) throw new Error('legacy API restore failed'); this.legacyActive = true; this.legacyContainerPresent = true; },
    async backup(destination, recipient) {
      this.trace.push('backup');
      assert.equal(destination, '/mnt/backup');
      assert.equal(recipient, 'age1recipient');
      assert.equal(this.legacyContainerPresent, false, 'Quadlet stop should remove the legacy container');
      if (this.failBackup) throw new Error('synthetic backup failure');
      return 'Encrypted legacy backup committed';
    },
  };
  const controller = new StandaloneController({
    host, store: {
      async save() { throw new Error('legacy backup must not create a journal'); },
      async saveBackupIntent(value) { host.backupIntent = structuredClone(value); host.trace.push('intent-save'); },
      async loadBackupIntent() { return host.backupIntent && structuredClone(host.backupIntent); },
      async clearBackupIntent() { host.backupIntent = null; host.trace.push('intent-clear'); },
    },
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
  assert.equal(host.backupIntent, null);
  assert.equal(host.startupFence, false);
  assert.ok(host.trace.indexOf('fence-install') < host.trace.indexOf('intent-save'));
  assert.ok(host.trace.indexOf('route:blocked') < host.trace.indexOf('tunnel-stop'));
  assert.ok(host.trace.indexOf('tunnel-stop') < host.trace.indexOf('api-stop'));
  assert.ok(host.trace.indexOf('api-stop') < host.trace.indexOf('backup'));
  assert.ok(host.trace.indexOf('backup') < host.trace.indexOf('api-start'));
  assert.ok(host.trace.indexOf('api-fence-remove') < host.trace.indexOf('api-start'));
  assert.ok(host.trace.indexOf('api-start') < host.trace.indexOf('tunnel-start'));
  assert.ok(host.trace.indexOf('tunnel-fence-remove') < host.trace.indexOf('tunnel-start'));
  assert.ok(host.trace.indexOf('tunnel-start') < host.trace.indexOf('timer-start'));
});

test('boot recovery resumes an interrupted legacy backup only after revalidating its signed container', async () => {
  const boundaries = [
    { name: 'after timer stop', timerActive: false, tunnelActive: true, legacyActive: true },
    { name: 'after Tunnel stop', timerActive: false, tunnelActive: false, legacyActive: true },
    { name: 'after legacy API stop', timerActive: false, tunnelActive: false, legacyActive: false, legacyContainerPresent: false },
  ];
  for (const boundary of boundaries) {
    const { host, controller } = legacyFixture();
    Object.assign(host, boundary);
    host.backupIntent = legacyBackupIntent();

    await controller.recoverBackupIntent(null);

    assert.equal(host.legacyActive, true, boundary.name);
    assert.equal(host.tunnelActive, true, boundary.name);
    assert.equal(host.timerActive, true, boundary.name);
    assert.equal(host.routeValue, 'blocked', boundary.name);
    assert.equal(host.backupIntent, null, boundary.name);
  }
});

test('interrupted pre-journal backup refuses to restart when the captured Quadlet or systemd unit drifted', async () => {
  const { host, controller } = legacyFixture();
  host.legacyActive = false;
  host.legacyContainerPresent = false;
  host.tunnelActive = false;
  host.timerActive = false;
  host.startupFence = true;
  host.apiStartupFence = true;
  host.tunnelStartupFence = true;
  host.legacyUnitFingerprint = 'd'.repeat(64);
  host.backupIntent = legacyBackupIntent();

  await assert.rejects(controller.recoverBackupIntent(null), /Legacy Quadlet\/systemd source drifted/);

  assert.equal(host.legacyActive, false);
  assert.equal(host.tunnelActive, false);
  assert.equal(host.timerActive, false);
  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.backupIntent.legacyUnitFingerprint, 'f'.repeat(64));
  assert.equal(host.startupFence, true);
  assert.ok(!host.trace.includes('api-start'));
});

test('legacy backup identity accepts a missing API epoch only after immutable image and runtime checks', () => {
  const imageId = 'c'.repeat(64);
  const legacy = {
    State: { Running: true },
    Image: 'sha256:' + imageId,
    Config: { Env: ['CODEXIA_BROWSER_AUTH=token'] },
  };
  const image = { Id: 'sha256:' + imageId, RepoDigests: [release.image], Os: 'linux', Architecture: 'amd64', Labels: { 'org.opencontainers.image.revision': release.sourceSha } };
  const version = { name: 'codexia', version: release.version, profile: release.profile, hosted: false, browserAuth: 'token' };

  assert.doesNotThrow(() => assertLegacyBackupIdentity({ legacy, image, version }, release, { CODEXIA_BROWSER_AUTH: 'token' }));
  assert.throws(() => assertVersion(version, release, 'token'), /epoch mismatch/);
});

test('legacy backup identity rejects an unexpected image, profile, or advertised API epoch', () => {
  const imageId = 'c'.repeat(64);
  const legacy = {
    State: { Running: true },
    Image: 'sha256:' + imageId,
    Config: { Env: ['CODEXIA_BROWSER_AUTH=token'] },
  };
  const image = { Id: 'sha256:' + imageId, RepoDigests: [release.image], Os: 'linux', Architecture: 'amd64', Labels: { 'org.opencontainers.image.revision': release.sourceSha } };
  const version = { name: 'codexia', version: release.version, profile: release.profile, hosted: false, browserAuth: 'token' };
  const auth = { CODEXIA_BROWSER_AUTH: 'token' };

  assert.throws(() => assertLegacyBackupIdentity({ legacy: { ...legacy, Image: 'sha256:' + 'd'.repeat(64) }, image, version }, release, auth), /image differs/);
  assert.throws(() => assertLegacyBackupIdentity({ legacy, image, version: { ...version, profile: 'full' } }, release, auth), /'full' !== 'core'/);
  assert.throws(() => assertLegacyBackupIdentity({ legacy, image, version: { ...version, apiEpoch: release.apiEpoch + 1 } }, release, auth), /epoch mismatch/);
});

test('legacy backup fingerprints only the loaded Quadlet/systemd unit tied to the signed image', () => {
  const imageId = 'c'.repeat(64);
  const sourcePath = '/home/codexia/.config/containers/systemd/codexia-api.container';
  const fragmentPath = '/run/user/1002/systemd/generator/codexia-api.service';
  const source = `[Container]\nImage=ghcr.io/yohn-jp/codexia-backend:sha-${release.sourceSha}\nContainerName=codexia-api\n`;
  const fragment = `[Service]\nExecStart=/usr/bin/podman run --name=codexia-api ghcr.io/yohn-jp/codexia-backend:sha-${release.sourceSha}\n`;
  const image = {
    Id: 'sha256:' + imageId, RepoDigests: [release.image], Os: 'linux', Architecture: 'amd64',
    Labels: { 'org.opencontainers.image.revision': release.sourceSha },
  };
  const identity = { source, fragment, sourcePath, fragmentPath, quadletImage: image, selectedImage: image };
  assert.match(assertLegacyBackupUnitIdentity(identity, release), /^[a-f0-9]{64}$/u);
  assert.throws(() => assertLegacyBackupUnitIdentity({ ...identity, source: source.replace('ContainerName=codexia-api', 'ContainerName=other-api') }, release), /Expected values to be strictly equal/);
  assert.throws(() => assertLegacyBackupUnitIdentity({ ...identity, fragment: fragment.replace(/sha-[a-f0-9]{40}/u, 'different-image') }, release), /does not start the image/);
  assert.throws(() => assertLegacyBackupUnitIdentity({ ...identity, quadletImage: { ...image, Id: 'sha256:' + 'd'.repeat(64) } }, release), /does not resolve/);
});

test('pre-journal backup failure restores prior services and timer before returning failure', async () => {
  const { host, controller } = legacyFixture({ backupFailure: true });
  await assert.rejects(controller.backupLegacy(release, { destination: '/mnt/backup', recipient: 'age1recipient' }), /synthetic backup failure/);
  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.legacyActive, true);
  assert.equal(host.tunnelActive, true);
  assert.equal(host.timerActive, true);
});

test('pre-journal backup rejects an invalid destination before stopping the legacy services', async () => {
  const { host, controller } = legacyFixture({ destinationFailure: true });
  await assert.rejects(controller.backupLegacy(release, { destination: '/mnt/backup', recipient: 'age1recipient' }), /not an approved remote filesystem/);
  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.legacyActive, true);
  assert.equal(host.tunnelActive, true);
  assert.equal(host.timerActive, true);
  assert.ok(!host.trace.includes('timer-stop'));
  assert.ok(!host.trace.includes('tunnel-stop'));
  assert.ok(!host.trace.includes('api-stop'));
});

test('pre-journal recovery failure leaves the route blocked and does not restart ingress', async () => {
  const { host, controller } = legacyFixture({ restoreFailure: true });
  await assert.rejects(controller.backupLegacy(release, { destination: '/mnt/backup', recipient: 'age1recipient' }), /Legacy backup recovery blocked/);
  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.legacyActive, false);
  assert.equal(host.tunnelActive, false);
  assert.equal(host.timerActive, false);
});
