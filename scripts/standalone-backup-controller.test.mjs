import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertMatchingControllerBackup, validateControllerBackupProof, verifyBackupPublication, atomicWrite, loadBackupIntent, StandaloneController, initialControllerState, validateBackupIntent } from './standalone-update-controller.mjs';
import { PodmanStandaloneHost, assertLegacyApiStoppedState, assertLegacyBackupIdentity, assertLegacyBackupUnitIdentity, assertLegacyBackupTunnelUnitIdentity, containerRuntimeFingerprint, containerRuntimeFingerprintProjection, assertVersion } from '../deploy/updater/standalone-host.mjs';
import { signUpdateChannel } from './update-channel.mjs';

const release = {
  format: 'codexia-update-release/v1', channel: 'stable', state: 'published', version: '1.2.3',
  sourceSha: 'a'.repeat(40), image: 'ghcr.io/yohn-jp/codexia-backend@sha256:' + 'a'.repeat(64),
  platform: 'linux/amd64', profile: 'core', migrationFingerprint: 'sha256:' + 'b'.repeat(64),
  persistenceFormat: 1, apiEpoch: 1,
};

test('failed legacy API unit is reset only after Podman proves the Quadlet container is absent', () => {
  assert.equal(assertLegacyApiStoppedState({ status: 3, stdout: 'failed\n' }, null), true);
  assert.throws(() => assertLegacyApiStoppedState({ status: 3, stdout: 'failed\n' }, { State: { Running: false } }), /still has a Podman container/);
  assert.equal(assertLegacyApiStoppedState({ status: 3, stdout: 'inactive\n' }, null), false);
  assert.equal(assertLegacyApiStoppedState({ status: 4, stdout: 'unknown\n' }, null), false);
});

test('initialized backup evidence binds exact artifact, release, generation and database identity', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'codexia-backup-proof-'));
  try{
    const artifactDirectory=path.join(root,'codexia-20261117T000000Z-12345678-1234-1234-1234-123456789abc');
    await mkdir(artifactDirectory);
    const hash='d'.repeat(64);
    const output='Encrypted backup committed: '+artifactDirectory+'\nPublished checksum manifest sha256: '+hash;
    const host={backupArtifactIdentity:async directory=>{assert.equal(directory,artifactDirectory);return hash;}};
    const publication=await verifyBackupPublication(output,root,host);
    const state=initialControllerState(release,'blue',null);
    const databaseId='123456789:12345';
    const source={format:'codexia-controller-backup-proof/v1',release,journalGeneration:state.journal.generation,databaseId,...publication};
    const receipt={format:'codexia-restore-receipt/v1',checksumManifestSha256:hash};
    assert.deepEqual(validateControllerBackupProof(source),source);
    assert.deepEqual(assertMatchingControllerBackup(source,receipt,state,databaseId,hash),source);
    assert.throws(()=>assertMatchingControllerBackup(source,receipt,{...state,journal:{...state.journal,generation:1}},databaseId,hash),/different controller generation/);
    assert.throws(()=>assertMatchingControllerBackup({...source,release:{...release,version:'1.2.4'}},receipt,state,databaseId,hash),/different installed release/);
    assert.throws(()=>assertMatchingControllerBackup(source,receipt,state,'123456789:12346',hash),/different database identity/);
    assert.throws(()=>assertMatchingControllerBackup(source,{...receipt,checksumManifestSha256:'e'.repeat(64)},state,databaseId,hash),/Restore receipt/);
    assert.throws(()=>assertMatchingControllerBackup(source,receipt,state,databaseId,'e'.repeat(64)),/Current off-VM artifact/);
    assert.throws(()=>assertMatchingControllerBackup(source,receipt,{...state,lastError:'error'},databaseId,hash),/stable initialized controller/);
    assert.throws(()=>validateControllerBackupProof({...source,approval:true}));
    await assert.rejects(verifyBackupPublication(output+'\nextra',root,host),/one committed artifact/);
    await assert.rejects(verifyBackupPublication(output,artifactDirectory,host),/outside the approved destination/);
    await assert.rejects(verifyBackupPublication(output,root,{backupArtifactIdentity:async()=>'e'.repeat(64)}),/Published backup changed/);
  }finally{await rm(root,{recursive:true,force:true});}
});

function controllerBackupIntent(overrides = {}) {
  return {
    format: 'codexia-backup-intent/v1', kind: 'controller', slot: 'blue', image: release.image,
    journalGeneration: 0, priorPaused: false, priorLastError: null, timerWasActive: true,
    createdAt: '2026-11-12T12:00:00.000Z', ...overrides,
  };
}

function legacyBackupIntent(overrides = {}) {
  const apiWasEnabled = overrides.apiWasEnabled ?? true;
  const tunnelWasEnabled = overrides.tunnelWasEnabled ?? true;
  return {
    format: 'codexia-backup-intent/v3', kind: 'legacy', release,
    identity: {
      api: { unitFingerprint: 'f'.repeat(64), runtimeFingerprint: 'a'.repeat(64) },
      tunnel: { unitFingerprint: 'e'.repeat(64), runtimeFingerprint: 'b'.repeat(64) },
    },
    apiWasEnabled, tunnelWasEnabled,
    autostartLinks: overrides.autostartLinks ?? {
      api: { generatorTarget: apiWasEnabled ? '../codexia-api.service' : null, defaultTargetWants: apiWasEnabled },
      tunnel: { generatorTarget: tunnelWasEnabled ? '../codexia-tunnel.service' : null, defaultTargetWants: tunnelWasEnabled },
    },
    tunnelWasActive: true, timerWasActive: true,
    createdAt: '2026-11-12T12:00:00.000Z', ...overrides,
  };
}

function setFixtureAutostart(host,intent){
  host.apiWasEnabled=intent.apiWasEnabled;
  host.tunnelWasEnabled=intent.tunnelWasEnabled;
  host.autostartLinks=structuredClone(intent.autostartLinks);
}

test('legacy backup intent requires complete API and Tunnel identities and startup state', () => {
  const intent = legacyBackupIntent();
  assert.deepEqual(validateBackupIntent(intent), intent);
  assert.throws(() => validateBackupIntent({ ...intent, identity: { ...intent.identity, tunnel: { ...intent.identity.tunnel, unitFingerprint: undefined } } }));
  assert.throws(() => validateBackupIntent({ ...intent, tunnelWasActive: true,
    identity: { ...intent.identity, tunnel: { ...intent.identity.tunnel, runtimeFingerprint: null } } }));
  assert.throws(() => validateBackupIntent({ ...intent, apiWasEnabled: undefined }));
});

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

function legacyFixture({ tunnelActive = true, timerActive = true, backupFailure = false, restoreFailure = false, tunnelStartFailure = false, apiPermitFailure = false, apiPermitCleanupFailure = false, destinationFailure = false, clearIntentFailureAfterUnlink = false, clearRecoveryIntentFailureBeforeUnlink = false, clearRecoveryIntentFailureAfterUnlink = false, startupFenceRemovalFailure = false, primaryIntentResaveFailure = false, recoveryIntentSaveFailure = false } = {}) {
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' });
  const privateKey = key.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const now = Date.parse('2026-11-12T12:00:00Z');
  const host = {
    routeValue: 'blocked',
    legacyActive: true,
    legacyContainerPresent: true,
    legacyUnitFingerprint: 'f'.repeat(64),
    legacyRuntimeFingerprint: 'a'.repeat(64),
    tunnelUnitFingerprint: 'e'.repeat(64),
    tunnelRuntimeFingerprint: 'b'.repeat(64),
    apiWasEnabled: true,
    tunnelWasEnabled: true,
    autostartLinks: {
      api: { generatorTarget: '../codexia-api.service', defaultTargetWants: true },
      tunnel: { generatorTarget: '../codexia-tunnel.service', defaultTargetWants: true },
    },
    startupFence: false,
    apiStartupFence: false,
    tunnelStartupFence: false,
    backupIntent: null,
    recoveryIntent: null,
    failClearIntentAfterUnlink: clearIntentFailureAfterUnlink,
    failClearRecoveryIntentBeforeUnlink: clearRecoveryIntentFailureBeforeUnlink,
    failClearRecoveryIntentAfterUnlink: clearRecoveryIntentFailureAfterUnlink,
    failPrimaryIntentResave: primaryIntentResaveFailure,
    failRecoveryIntentSave: recoveryIntentSaveFailure,
    failStartupFenceRemoval: startupFenceRemovalFailure,
    tunnelActive,
    timerActive,
    preflight: false,
    failBackup: backupFailure,
    failRestore: restoreFailure,
    failTunnelStart: tunnelStartFailure,
    failApiPermit: apiPermitFailure,
    failApiPermitCleanup: apiPermitCleanupFailure,
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
    async captureBackupAutostart() {
      this.trace.push('autostart-capture');
      return { apiWasEnabled: this.apiWasEnabled, tunnelWasEnabled: this.tunnelWasEnabled, autostartLinks: structuredClone(this.autostartLinks) };
    },
    async assertBackupAutostartGated(intent) {
      this.trace.push('autostart-gated');
      assert.equal(this.startupFence, true);
      assert.deepEqual(this.autostartLinks, intent.autostartLinks);
      assert.equal(this.apiWasEnabled, intent.apiWasEnabled);
      assert.equal(this.tunnelWasEnabled, intent.tunnelWasEnabled);
    },
    async restoreBackupAutostart(intent) {
      this.trace.push('autostart-restore');
      assert.deepEqual(this.autostartLinks, intent.autostartLinks);
      assert.equal(this.apiWasEnabled, intent.apiWasEnabled); this.tunnelWasEnabled = intent.tunnelWasEnabled;
    },
    async assertBackupStartupFence() { assert.equal(this.startupFence, true); },
    async removeBackupStartupPermits() { this.trace.push('permits-clear'); },
    async removeBackupStartupFence() { this.trace.push('fence-remove'); if (this.failStartupFenceRemoval) { this.failStartupFenceRemoval = false; throw new Error('synthetic startup-fence cleanup failure'); } this.startupFence = false; this.apiStartupFence = false; this.tunnelStartupFence = false; },
    async validateBackupDestination(destination) {
      this.trace.push('validate-destination');
      assert.equal(destination, '/mnt/backup');
      if (this.failDestination) throw new Error('destination is not an approved remote filesystem');
    },
    async assertLegacyBackupRelease(candidate, { allowStopped = false, expectedIdentity } = {}) {
      this.trace.push('verify-api');
      if (expectedIdentity) {
        assert.equal(this.legacyUnitFingerprint, expectedIdentity.unitFingerprint, 'Legacy API Quadlet/systemd source drifted');
        if (this.legacyContainerPresent) assert.equal(this.legacyRuntimeFingerprint, expectedIdentity.runtimeFingerprint, 'Legacy API runtime drifted');
      }
      if (!this.legacyContainerPresent) {
        assert.ok(allowStopped, 'Legacy writer container is missing');
        assert.ok(expectedIdentity, 'Stopped legacy writer requires its captured Quadlet/systemd identity');
        return { unitFingerprint: this.legacyUnitFingerprint, runtimeFingerprint: null };
      }
      const imageId = 'c'.repeat(64);
      assertLegacyBackupIdentity({
        legacy: { State: { Running: this.legacyActive }, Image: 'sha256:' + imageId, Config: { Env: ['CODEXIA_BROWSER_AUTH=token'] } },
        image: { Id: 'sha256:' + imageId, RepoDigests: [release.image], Os: 'linux', Architecture: 'amd64', Labels: { 'org.opencontainers.image.revision': release.sourceSha } },
        version: this.legacyActive ? { name: 'codexia', version: candidate.version, profile: candidate.profile, hosted: false, browserAuth: 'token' } : null,
      }, candidate, { CODEXIA_BROWSER_AUTH: 'token' }, { requireRunning: !allowStopped });
      return { unitFingerprint: this.legacyUnitFingerprint, runtimeFingerprint: this.legacyRuntimeFingerprint };
    },
    async assertLegacyBackupTunnel({ allowStopped = false, expectedIdentity } = {}) {
      this.trace.push('verify-tunnel');
      if (expectedIdentity) {
        assert.equal(this.tunnelUnitFingerprint, expectedIdentity.unitFingerprint, 'Legacy Tunnel Quadlet/systemd source drifted');
        if (this.tunnelActive) assert.equal(this.tunnelRuntimeFingerprint, expectedIdentity.runtimeFingerprint, 'Legacy Tunnel runtime drifted');
      }
      if (!this.tunnelActive) assert.ok(allowStopped || expectedIdentity?.runtimeFingerprint === null, 'Legacy Tunnel is unexpectedly stopped');
      return { unitFingerprint: this.tunnelUnitFingerprint, runtimeFingerprint: this.tunnelActive ? this.tunnelRuntimeFingerprint : null };
    },
    async stopTunnel() { this.trace.push('tunnel-stop'); this.tunnelActive = false; },
    async startTunnel() { this.trace.push('tunnel-permit'); this.trace.push('tunnel-start'); if (this.failTunnelStart) throw new Error('legacy Tunnel restore failed'); this.tunnelActive = true; },
    async stopLegacyWriter() { this.trace.push('api-stop'); this.legacyActive = false; this.legacyContainerPresent = false; },
    async startLegacyWriter() { this.trace.push('api-permit'); if (this.failApiPermit) throw new Error('API recovery startup permit creation failed'); this.trace.push('api-start'); if (this.failRestore) throw new Error('legacy API restore failed'); this.legacyActive = true; this.legacyContainerPresent = true; if (this.failApiPermitCleanup) throw new Error('API recovery startup permit removal failed'); },
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
      async saveBackupIntent(value) {
        host.trace.push('intent-save');
        if (host.failPrimaryIntentResave) throw new Error('synthetic primary intent re-save failure');
        host.backupIntent = structuredClone(value);
      },
      async loadBackupIntent() { return host.backupIntent && structuredClone(host.backupIntent); },
      async clearBackupIntent() {
        host.backupIntent = null; host.trace.push('intent-clear');
        if (host.failClearIntentAfterUnlink) {
          host.failClearIntentAfterUnlink = false;
          throw new Error('synthetic parent directory fsync failure after unlink');
        }
      },
      async saveBackupRecoveryIntent(value) {
        host.trace.push('recovery-intent-save');
        if (host.failRecoveryIntentSave) throw new Error('synthetic recovery marker fsync failure');
        host.recoveryIntent = structuredClone(value);
      },
      async loadBackupRecoveryIntent() { return host.recoveryIntent && structuredClone(host.recoveryIntent); },
      async clearBackupRecoveryIntent() {
        host.trace.push('recovery-intent-clear');
        if (host.failClearRecoveryIntentBeforeUnlink) { host.failClearRecoveryIntentBeforeUnlink = false; throw new Error('synthetic recovery marker unlink failure before clear'); }
        host.recoveryIntent = null;
        if (host.failClearRecoveryIntentAfterUnlink) { host.failClearRecoveryIntentAfterUnlink = false; throw new Error('synthetic recovery marker directory fsync failure after unlink'); }
      },
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
  assert.equal(host.recoveryIntent, null);
  assert.equal(host.startupFence, false);
  assert.equal(host.apiWasEnabled, true);
  assert.equal(host.tunnelWasEnabled, true);
  assert.ok(host.trace.indexOf('recovery-intent-save') < host.trace.indexOf('fence-install'));
  assert.ok(host.trace.indexOf('fence-install') < host.trace.indexOf('intent-save'));
  assert.ok(host.trace.indexOf('intent-save') < host.trace.indexOf('autostart-gated'));
  assert.ok(host.trace.indexOf('route:blocked') < host.trace.indexOf('tunnel-stop'));
  assert.ok(host.trace.indexOf('tunnel-stop') < host.trace.indexOf('api-stop'));
  assert.ok(host.trace.indexOf('api-stop') < host.trace.indexOf('backup'));
  assert.ok(host.trace.indexOf('backup') < host.trace.indexOf('api-start'));
  assert.ok(host.trace.indexOf('api-permit') < host.trace.indexOf('api-start'));
  assert.ok(host.trace.indexOf('api-start') < host.trace.indexOf('tunnel-start'));
  assert.ok(host.trace.indexOf('tunnel-permit') < host.trace.indexOf('tunnel-start'));
  assert.ok(host.trace.indexOf('tunnel-start') < host.trace.indexOf('timer-start'));
  assert.ok(host.trace.indexOf('autostart-restore') < host.trace.indexOf('intent-clear'));
  const finalFenceInstall = host.trace.lastIndexOf('fence-install');
  assert.ok(finalFenceInstall > host.trace.indexOf('tunnel-start'));
  assert.ok(finalFenceInstall < host.trace.indexOf('autostart-restore'));
  assert.ok(host.trace.indexOf('intent-clear') < host.trace.indexOf('recovery-intent-clear'));
  assert.ok(host.trace.indexOf('recovery-intent-clear') < host.trace.lastIndexOf('fence-remove'));
});

test('legacy backup fails before installing a startup fence if its durable recovery marker cannot be saved', async () => {
  const { host, controller } = legacyFixture({ recoveryIntentSaveFailure: true });

  await assert.rejects(controller.backupLegacy(release, { destination: '/mnt/backup', recipient: 'age1recipient' }), /recovery marker fsync failure/);

  assert.equal(host.startupFence, false);
  assert.equal(host.legacyActive, true);
  assert.equal(host.legacyContainerPresent, true);
  assert.equal(host.tunnelActive, true);
  assert.equal(host.timerActive, true);
  assert.ok(!host.trace.includes('fence-install'));
  assert.ok(!host.trace.includes('api-stop'));
  assert.ok(!host.trace.includes('tunnel-stop'));
  assert.ok(!host.trace.includes('timer-stop'));
  assert.ok(!host.trace.includes('backup'));
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
    assert.equal(host.recoveryIntent, null, boundary.name);
  }
});

test('recovery resumes from the independent marker when the primary intent is missing', async () => {
  const { host, controller } = legacyFixture();
  host.legacyActive = false;
  host.legacyContainerPresent = false;
  host.tunnelActive = false;
  host.timerActive = false;
  host.recoveryIntent = legacyBackupIntent();

  await controller.recoverBackupIntent(null);

  assert.equal(host.legacyActive, true);
  assert.equal(host.tunnelActive, true);
  assert.equal(host.timerActive, true);
  assert.equal(host.backupIntent, null);
  assert.equal(host.recoveryIntent, null);
});

test('mismatched primary and independent recovery intents fail closed', async () => {
  const { host, controller } = legacyFixture();
  host.backupIntent = legacyBackupIntent();
  host.recoveryIntent = legacyBackupIntent({ apiWasEnabled: false, tunnelWasEnabled: false });

  await assert.rejects(controller.loadBackupIntent(), /Primary and independent backup recovery intents disagree/);
  assert.equal(host.startupFence, false);
  assert.ok(!host.trace.includes('fence-remove'));
  assert.ok(!host.trace.includes('api-start'));
});

test('legacy intent unlink followed by parent fsync failure restores intent and keeps the startup fence', async () => {
  const { host, controller } = legacyFixture({ clearIntentFailureAfterUnlink: true });
  const intent = legacyBackupIntent();
  host.backupIntent = structuredClone(intent);

  await assert.rejects(controller.recoverBackupIntent(null), /parent directory fsync failure after unlink/);

  assert.deepEqual(host.backupIntent, intent, 'The failed clear must durably restore the primary intent');
  assert.deepEqual(host.recoveryIntent, intent, 'The independent recovery marker must remain durable');
  assert.equal(host.startupFence, true);
  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.timerActive, false);
  assert.equal(host.tunnelActive, false);
  assert.ok(!host.trace.includes('fence-remove'));
  assert.ok(host.trace.lastIndexOf('recovery-intent-save') < host.trace.length);
});

test('independent recovery marker keeps the startup fence when primary intent re-save fails', async () => {
  const { host, controller } = legacyFixture({ clearIntentFailureAfterUnlink: true, primaryIntentResaveFailure: true, tunnelActive: false });
  const intent = legacyBackupIntent({
    tunnelWasActive: false,
    identity: { ...legacyBackupIntent().identity, tunnel: { ...legacyBackupIntent().identity.tunnel, runtimeFingerprint: null } },
  });
  host.backupIntent = structuredClone(intent);

  await assert.rejects(controller.recoverBackupIntent(null), /parent directory fsync failure after unlink/);

  assert.equal(host.backupIntent, null);
  assert.deepEqual(host.recoveryIntent, intent);
  assert.equal(host.startupFence, true);
  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.timerActive, false);
  assert.equal(host.tunnelActive, false);
  assert.ok(!host.trace.includes('fence-remove'));
  assert.ok(!host.trace.includes('api-start'));
  assert.ok(!host.trace.includes('tunnel-start'));
  assert.ok(host.trace.lastIndexOf('timer-stop') > host.trace.lastIndexOf('timer-start'), 'The failed clear must leave polling stopped after any pre-clear restoration');
});

test('recovery marker fsync failure restores the marker and retains the startup fence', async () => {
  const { host, controller } = legacyFixture({ clearRecoveryIntentFailureAfterUnlink: true, tunnelActive: false });
  const intent = legacyBackupIntent({
    tunnelWasActive: false,
    identity: { ...legacyBackupIntent().identity, tunnel: { ...legacyBackupIntent().identity.tunnel, runtimeFingerprint: null } },
  });
  host.backupIntent = structuredClone(intent);

  await assert.rejects(controller.recoverBackupIntent(null), /recovery marker directory fsync failure after unlink/);

  assert.equal(host.backupIntent, null, 'The primary intent clear was already durable');
  assert.deepEqual(host.recoveryIntent, intent, 'The independent marker must be restored after its ambiguous unlink');
  assert.equal(host.startupFence, true);
  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.timerActive, false);
  assert.equal(host.tunnelActive, false);
  assert.ok(!host.trace.includes('fence-remove'));
  assert.ok(host.trace.lastIndexOf('recovery-intent-save') > host.trace.lastIndexOf('recovery-intent-clear'));
});

test('recovery marker unlink failure retains the marker, blocks routing, and keeps the startup fence', async () => {
  const { host, controller } = legacyFixture({ clearRecoveryIntentFailureBeforeUnlink: true, tunnelActive: false });
  const intent = legacyBackupIntent({
    tunnelWasActive: false,
    identity: { ...legacyBackupIntent().identity, tunnel: { ...legacyBackupIntent().identity.tunnel, runtimeFingerprint: null } },
  });
  host.backupIntent = structuredClone(intent);

  await assert.rejects(controller.recoverBackupIntent(null), /recovery marker unlink failure before clear/);

  assert.equal(host.backupIntent, null, 'The primary intent clear was already durable');
  assert.deepEqual(host.recoveryIntent, intent, 'The recovery marker remains available for the next recovery attempt');
  assert.equal(host.startupFence, true);
  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.timerActive, false);
  assert.equal(host.tunnelActive, false);
  assert.ok(!host.trace.includes('fence-remove'));
});

test('durably committed recovery leaves a failed fence cleanup for the next no-intent pass', async () => {
  const { host, controller } = legacyFixture({ startupFenceRemovalFailure: true });
  host.backupIntent = legacyBackupIntent();

  await assert.rejects(controller.recoverBackupIntent(null), /startup-fence cleanup failed/);

  assert.equal(host.backupIntent, null);
  assert.equal(host.recoveryIntent, null);
  assert.equal(host.startupFence, true, 'A failed fence cleanup must leave the reviewed fence in place');
  assert.equal(host.legacyActive, true);
  assert.equal(host.tunnelActive, true);
  assert.equal(host.timerActive, true);
  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.trace.filter(event => event === 'fence-remove').length, 1, 'The controller must not retry fence removal in the committed error branch');

  await controller.recoverBackupIntent(null);

  assert.equal(host.startupFence, false, 'A later no-intent pass may remove the completed recovery fence');
  assert.equal(host.legacyActive, true);
  assert.equal(host.tunnelActive, true);
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

  await assert.rejects(controller.recoverBackupIntent(null), /Legacy API Quadlet\/systemd source drifted/);

  assert.equal(host.legacyActive, false);
  assert.equal(host.tunnelActive, false);
  assert.equal(host.timerActive, false);
  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.backupIntent.identity.api.unitFingerprint, 'f'.repeat(64));
  assert.equal(host.startupFence, true);
  assert.ok(!host.trace.includes('api-start'));
});

test('interrupted legacy recovery refuses Tunnel source drift before either writer or ingress starts', async () => {
  const { host, controller } = legacyFixture();
  host.legacyActive = false;
  host.legacyContainerPresent = false;
  host.tunnelActive = false;
  host.timerActive = false;
  host.tunnelUnitFingerprint = 'd'.repeat(64);
  host.backupIntent = legacyBackupIntent();

  await assert.rejects(controller.recoverBackupIntent(null), /Legacy Tunnel Quadlet\/systemd source drifted/);

  assert.equal(host.legacyActive, false);
  assert.equal(host.tunnelActive, false);
  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.backupIntent.identity.tunnel.unitFingerprint, 'e'.repeat(64));
  assert.equal(host.apiWasEnabled, true);
  assert.equal(host.tunnelWasEnabled, true);
  assert.ok(!host.trace.includes('api-start'));
  assert.ok(!host.trace.includes('tunnel-start'));
});

test('legacy API runtime drift after Quadlet recreates its container blocks Tunnel and retains intent', async () => {
  const { host, controller } = legacyFixture();
  host.legacyActive = false;
  host.legacyContainerPresent = false;
  host.tunnelActive = false;
  host.timerActive = false;
  host.legacyRuntimeFingerprint = 'd'.repeat(64);
  host.backupIntent = legacyBackupIntent();

  await assert.rejects(controller.recoverBackupIntent(null), /Legacy API runtime drifted/);

  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.legacyActive, false);
  assert.equal(host.tunnelActive, false);
  assert.equal(host.backupIntent.identity.api.runtimeFingerprint, 'a'.repeat(64));
  assert.equal(host.startupFence, true);
  assert.ok(!host.trace.includes('tunnel-start'));
});

test('legacy Tunnel runtime drift after Quadlet recreates its container blocks ingress and retains intent', async () => {
  const { host, controller } = legacyFixture();
  host.legacyActive = false;
  host.legacyContainerPresent = false;
  host.tunnelActive = false;
  host.timerActive = false;
  host.tunnelRuntimeFingerprint = 'd'.repeat(64);
  host.backupIntent = legacyBackupIntent();

  await assert.rejects(controller.recoverBackupIntent(null), /Legacy Tunnel runtime drifted/);

  assert.equal(host.routeValue, 'blocked');
  assert.equal(host.legacyActive, true);
  assert.equal(host.tunnelActive, false);
  assert.equal(host.backupIntent.identity.tunnel.runtimeFingerprint, 'b'.repeat(64));
  assert.equal(host.startupFence, true);
  assert.equal(host.apiWasEnabled, true);
  assert.equal(host.tunnelWasEnabled, true);
  assert.ok(!host.trace.includes('timer-start'));
});

test('failed Tunnel restart keeps generated wants unchanged behind the durable startup fence', async () => {
  const { host, controller } = legacyFixture({ tunnelStartFailure: true });
  host.legacyActive = false;
  host.legacyContainerPresent = false;
  host.tunnelActive = false;
  host.timerActive = false;
  host.backupIntent = legacyBackupIntent({ apiWasEnabled: false, tunnelWasEnabled: false });
  setFixtureAutostart(host,host.backupIntent);

  await assert.rejects(controller.recoverBackupIntent(null), /legacy Tunnel restore failed/);

  assert.equal(host.backupIntent.kind, 'legacy');
  assert.equal(host.startupFence, true);
  assert.equal(host.apiWasEnabled, false);
  assert.equal(host.tunnelWasEnabled, false);
  assert.equal(host.legacyActive, true);
  assert.equal(host.tunnelActive, false);
  assert.equal(host.routeValue, 'blocked');
});

test('failed one-use API startup permit preserves the real backup intent and durable fence', async () => {
  const { host, controller } = legacyFixture({ apiPermitFailure: true });
  host.legacyActive = false;
  host.legacyContainerPresent = false;
  host.tunnelActive = false;
  host.timerActive = false;
  host.backupIntent = legacyBackupIntent();

  await assert.rejects(controller.recoverBackupIntent(null), /API recovery startup permit creation failed/);

  assert.equal(host.backupIntent.kind, 'legacy');
  assert.deepEqual(host.backupIntent.identity, legacyBackupIntent().identity);
  assert.equal(host.startupFence, true);
  assert.equal(host.apiWasEnabled, true);
  assert.equal(host.tunnelWasEnabled, true);
  assert.equal(host.legacyActive, false);
  assert.equal(host.routeValue, 'blocked');
  assert.ok(!host.trace.includes('api-start'));
});

test('failed one-use API startup permit removal preserves the real backup intent and durable fence', async () => {
  const { host, controller } = legacyFixture({ apiPermitCleanupFailure: true });
  host.legacyActive = false;
  host.legacyContainerPresent = false;
  host.tunnelActive = false;
  host.timerActive = false;
  host.backupIntent = legacyBackupIntent();

  await assert.rejects(controller.recoverBackupIntent(null), /API recovery startup permit removal failed/);

  assert.equal(host.backupIntent.kind, 'legacy');
  assert.deepEqual(host.backupIntent.identity, legacyBackupIntent().identity);
  assert.equal(host.startupFence, true);
  assert.equal(host.legacyActive, false);
  assert.equal(host.routeValue, 'blocked');
  assert.ok(host.trace.includes('api-start'));
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

test('Tunnel Quadlet identity includes its pinned image and secret identities', () => {
  const imageId = 'c'.repeat(64);
  const image = {
    Id: 'sha256:' + imageId,
    RepoDigests: ['docker.io/cloudflare/cloudflared@sha256:' + 'd'.repeat(64)],
    Os: 'linux', Architecture: 'amd64',
  };
  const imageReference = 'docker.io/cloudflare/cloudflared:2026.11.0@sha256:' + 'd'.repeat(64);
  const identity = {
    sourcePath: '/home/codexia/.config/containers/systemd/codexia-tunnel.container',
    fragmentPath: '/run/user/1002/systemd/generator/codexia-tunnel.service',
    source: `[Container]\nImage=${imageReference}\nContainerName=codexia-tunnel\nSecret=codexia-tunnel-token,type=mount,target=/run/secrets/token\n`,
    fragment: `[Service]\nExecStart=/usr/bin/podman run --name=codexia-tunnel ${imageReference}\n`,
    image,
    secretIdentities: [{ name: 'codexia-tunnel-token', id: 'secret-id-1' }],
  };
  const fingerprint = assertLegacyBackupTunnelUnitIdentity(identity);
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.ok(!fingerprint.includes('fixture-secret-value'));
  assert.notEqual(assertLegacyBackupTunnelUnitIdentity({ ...identity, secretIdentities: [{ name: 'codexia-tunnel-token', id: 'secret-id-2' }] }), fingerprint);
  assert.throws(() => assertLegacyBackupTunnelUnitIdentity({ ...identity, secretIdentities: [{ name: 'codexia-tunnel-token', id: 'secret-id-1', value: 'fixture-secret-value' }] }), /unsupported fields/);
  assert.throws(() => assertLegacyBackupTunnelUnitIdentity({ ...identity, source: identity.source.replace(imageReference, 'unPinnedImage') }), /digest/);
});

test('container runtime fingerprint covers data mounts, network, ports, environment, and ignores volatile state', () => {
  const runtime = {
    Id: 'container-1', Created: '2026-11-12T12:00:00Z', State: { Running: true, Pid: 123 },
    Image: 'sha256:' + 'a'.repeat(64), ImageName: release.image,
    Config: {
      Env: ['PORT=3000', 'CODEXIA_PROFILE=core'], Entrypoint: ['node'], Cmd: ['server.js'],
      Labels: { service: 'codexia-api' }, ExposedPorts: { '3000/tcp': {} }, User: '10001', WorkingDir: '/app',
      CreateCommand: ['podman', 'run', '--secret', 'codexia-app-password,type=mount,target=/run/secrets/app-password'],
      Secrets: [{ Name: 'codexia-app-password', ID: 'secret-id-1', UID: 0, GID: 0, Mode: 292 }],
    },
    HostConfig: {
      NetworkMode: 'codexia.network', PortBindings: {}, ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,nosuid' },
      Binds: [], RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 0 }, CapDrop: ['ALL'], SecurityOpt: [],
    },
    Mounts: [{ Type: 'volume', Name: 'codexia-data', Source: '/var/lib/volumes/codexia-data', Destination: '/data', Driver: 'local', Mode: 'rw', RW: true, Propagation: 'rprivate', Options: [] }],
    NetworkSettings: { Networks: { 'codexia.network': { NetworkID: 'network-id-1', Aliases: ['codexia-api'], IPAddress: '10.0.0.2', Gateway: '10.0.0.1' } } },
  };
  const secretIdentities = [{ name: 'codexia-app-password', id: 'secret-id-1' }];
  const fingerprint = containerRuntimeFingerprint(runtime, secretIdentities);
  assert.equal(containerRuntimeFingerprint({ ...runtime, Id: 'container-2', Created: '2026-11-13T12:00:00Z', State: { Running: false, Pid: 0 }, NetworkSettings: { Networks: { 'codexia.network': { NetworkID: 'network-id-1', Aliases: ['codexia-api'], IPAddress: '10.0.0.8', Gateway: '10.0.0.1' } } } }, secretIdentities), fingerprint);
  assert.notEqual(containerRuntimeFingerprint({ ...runtime, NetworkSettings: { Networks: { 'codexia.network': { ...runtime.NetworkSettings.Networks['codexia.network'], NetworkID: 'network-id-2' } } } }, secretIdentities), fingerprint);
  assert.notEqual(containerRuntimeFingerprint({ ...runtime, Config: { ...runtime.Config, CreateCommand: ['podman', 'run', '--secret', 'codexia-app-password,type=mount,target=/run/secrets/other'] } }, secretIdentities), fingerprint);
  assert.notEqual(containerRuntimeFingerprint({ ...runtime, HostConfig: { ...runtime.HostConfig, PortBindings: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3000' }] } } }, secretIdentities), fingerprint);
  assert.notEqual(containerRuntimeFingerprint({ ...runtime, HostConfig: { ...runtime.HostConfig, CpuQuota: 50000 } }, secretIdentities), fingerprint);
  assert.notEqual(containerRuntimeFingerprint({ ...runtime, Mounts: [{ ...runtime.Mounts[0], Name: 'codexia-data-drift' }] }, secretIdentities), fingerprint);
  assert.notEqual(containerRuntimeFingerprint({ ...runtime, NetworkSettings: { Networks: { 'public.network': { NetworkID: 'network-id-public', Aliases: ['codexia-api'] } } } }, secretIdentities), fingerprint);
  assert.notEqual(containerRuntimeFingerprint({ ...runtime, Config: { ...runtime.Config, Env: ['PORT=4000'] } }, secretIdentities), fingerprint);
  assert.throws(() => containerRuntimeFingerprint({ ...runtime, Config: { ...runtime.Config, Env: ['CODEXIA_AUTH_TOKEN=fixture-secret-value'] } }, secretIdentities), /Plaintext secret environment/);
  assert.throws(() => containerRuntimeFingerprint({ ...runtime, Config: { ...runtime.Config, Secrets: [{ Name: 'codexia-app-password', ID: 'stale-secret-id' }] } }, secretIdentities), /Podman runtime secret IDs differ/);
  assert.throws(() => containerRuntimeFingerprint(runtime, [{ name: 'codexia-app-password', id: 'secret-id-1', value: 'fixture-secret-value' }]), /unsupported fields/);
  assert.ok(!fingerprint.includes('fixture-secret-value'));
  assert.ok(!fingerprint.includes('/run/secrets/app-password'));
});

test('container runtime fingerprint binds sanitized secret targets without retaining raw command values', () => {
  const secrets = [{ name: 'codexia-app-password', id: 'secret-id-1' }];
  const container = {
    Image: 'sha256:' + 'a'.repeat(64),
    Config: {
      Env: ['CODEXIA_DATABASE_PASSWORD_FILE=/run/secrets/app-password'],
      CreateCommand: ['podman', 'run', '--label', 'review.marker=fixture-secret-value', '--secret', 'codexia-app-password,type=mount,target=/run/secrets/app-password'],
      Secrets: [{ Name: 'codexia-app-password', ID: 'secret-id-1', UID: 0, GID: 0, Mode: 292 }],
    },
    HostConfig: {},
    NetworkSettings: { Networks: {} },
    Mounts: [],
  };
  const fingerprint = containerRuntimeFingerprint(container, secrets);
  const projection = containerRuntimeFingerprintProjection(container, secrets);
  const reordered = containerRuntimeFingerprint({
    ...container,
    Config: { ...container.Config, CreateCommand: ['podman', 'create', '--label', 'review.marker=fixture-secret-value', '--secret', 'codexia-app-password,target=/run/secrets/app-password,type=mount'] },
  }, secrets);
  const drifted = containerRuntimeFingerprint({
    ...container,
    Config: { ...container.Config, CreateCommand: ['podman', 'run', '--label', 'review.marker=fixture-secret-value', '--secret', 'codexia-app-password,type=mount,target=/run/secrets/other'] },
  }, secrets);

  assert.equal(reordered, fingerprint, 'Equivalent secret options must fingerprint stably');
  assert.notEqual(drifted, fingerprint, 'A changed secret mount target must change runtime identity');
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.ok(!fingerprint.includes('fixture-secret-value'));
  assert.ok(!fingerprint.includes('--secret'));
  assert.ok(!JSON.stringify(projection).includes('fixture-secret-value'));
  assert.ok(!JSON.stringify(projection).includes('--secret'));
});

test('container runtime fingerprint preserves ordered entrypoint and command arguments', () => {
  const container = {
    Image: 'sha256:' + 'a'.repeat(64),
    Config: { Env: [], Entrypoint: ['/usr/bin/node'], Cmd: ['server.js', '--read-only'], CreateCommand: ['podman', 'run'] },
    HostConfig: {},
    NetworkSettings: { Networks: {} },
    Mounts: [],
  };
  const fingerprint = containerRuntimeFingerprint(container);
  const reordered = containerRuntimeFingerprint({ ...container, Config: { ...container.Config, Cmd: ['--read-only', 'server.js'] } });

  assert.notEqual(reordered, fingerprint, 'Argument order changes the process that the container runs');
});

test('container runtime fingerprint excludes only Podman-generated hostname and preserves explicit environment order', () => {
  const base = {
    Image: 'sha256:' + 'a'.repeat(64),
    Config: { Env: ['PORT=3000', 'PORT=4000'], Entrypoint: ['/usr/bin/node'], Cmd: ['server.js'], CreateCommand: ['podman', 'run'] },
    HostConfig: {},
    NetworkSettings: { Networks: {} },
    Mounts: [],
  };
  const before = containerRuntimeFingerprint({ ...base, Config: { ...base.Config, Hostname: 'container-1' } });
  const after = containerRuntimeFingerprint({ ...base, Config: { ...base.Config, Hostname: 'container-2' } });
  assert.equal(before, after, 'Podman derives the default hostname from the recreated container ID');

  const firstEnvironmentOrder = containerRuntimeFingerprint(base);
  const secondEnvironmentOrder = containerRuntimeFingerprint({ ...base, Config: { ...base.Config, Env: ['PORT=4000', 'PORT=3000'] } });
  assert.notEqual(firstEnvironmentOrder, secondEnvironmentOrder, 'Duplicate environment variables are order-sensitive');

  const explicit = { ...base, Config: { ...base.Config, Hostname: 'codexia-api', CreateCommand: ['podman', 'run', '--hostname', 'codexia-api'] } };
  const explicitDrift = { ...explicit, Config: { ...explicit.Config, Hostname: 'changed-host', CreateCommand: ['podman', 'run', '--hostname', 'changed-host'] } };
  assert.notEqual(containerRuntimeFingerprint(explicit), containerRuntimeFingerprint(explicitDrift));
});

test('container runtime fingerprint canonicalizes unique environment order but preserves duplicates', () => {
  const base = {
    Image: 'sha256:' + 'a'.repeat(64),
    Config: { Env: ['ZED=last', 'ALPHA=first'], Entrypoint: ['/bin/sh'], Cmd: ['sleep', '300'], CreateCommand: ['podman', 'run'] },
    HostConfig: {},
    NetworkSettings: { Networks: {} },
    Mounts: [],
  };
  const reordered = { ...base, Config: { ...base.Config, Env: ['ALPHA=first', 'ZED=last'] } };

  assert.equal(containerRuntimeFingerprint(reordered), containerRuntimeFingerprint(base), 'Unique environment keys have no order-dependent lookup semantics');

  const duplicates = { ...base, Config: { ...base.Config, Env: ['PORT=3000', 'PORT=4000'] } };
  const duplicatesReordered = { ...duplicates, Config: { ...duplicates.Config, Env: ['PORT=4000', 'PORT=3000'] } };
  assert.notEqual(containerRuntimeFingerprint(duplicatesReordered), containerRuntimeFingerprint(duplicates), 'Duplicate environment key order can change the effective value');
});

test('container runtime fingerprint normalizes only Podman-generated HOSTNAME and rejects unrelated drift', () => {
  const makeContainer = (id, hostname, createCommand = ['podman', 'run'], envHostname = hostname) => ({
    Id: id.repeat(64),
    Image: 'sha256:' + 'a'.repeat(64),
    Config: { Env: ['PATH=/usr/bin', 'HOSTNAME=' + envHostname], Hostname: hostname, CreateCommand: createCommand },
    HostConfig: {},
    NetworkSettings: { Networks: {} },
    Mounts: [],
  });
  const first = makeContainer('a', 'aaaaaaaaaaaa');
  const recreated = makeContainer('b', 'bbbbbbbbbbbb');
  assert.equal(containerRuntimeFingerprint(first), containerRuntimeFingerprint(recreated), 'Generated hostname follows the recreated container identity');

  const idHostname = makeContainer('e', '', ['podman', 'run'], 'e'.repeat(12));
  assert.equal(containerRuntimeFingerprint(idHostname), containerRuntimeFingerprint(makeContainer('f', '', ['podman', 'run'], 'f'.repeat(12))), 'Generated hostname may also be the inspected container ID prefix');

  const mismatchedGeneratedValue = makeContainer('c', 'cccccccccccc', ['podman', 'run'], 'unrelated-hostname');
  assert.throws(() => containerRuntimeFingerprint(mismatchedGeneratedValue), /Podman-generated HOSTNAME does not match the inspected hostname or container ID/);

  const explicitBefore = makeContainer('d', 'default-hostname', ['podman', 'run', '--env', 'HOSTNAME=service-a'], 'service-a');
  const explicitAfter = makeContainer('d', 'default-hostname', ['podman', 'run', '--env', 'HOSTNAME=service-b'], 'service-b');
  assert.notEqual(containerRuntimeFingerprint(explicitBefore), containerRuntimeFingerprint(explicitAfter), 'Explicit HOSTNAME remains part of runtime identity');

  const explicitHostnameBefore = makeContainer('g', 'service-host', ['podman', 'run', '--hostname', 'service-host'], 'service-host');
  const explicitHostnameAfter = makeContainer('g', 'service-host', ['podman', 'run', '--hostname', 'service-host'], 'changed-host');
  assert.notEqual(containerRuntimeFingerprint(explicitHostnameBefore), containerRuntimeFingerprint(explicitHostnameAfter), 'An explicit hostname keeps its runtime HOSTNAME tied to the observed configuration');
});

test('container runtime fingerprint validates and retains Podman Config.Passwd boolean', () => {
  const container = {
    Image: 'sha256:' + 'a'.repeat(64),
    Config: { Env: [], CreateCommand: ['podman', 'run'], Passwd: false },
    HostConfig: {},
    NetworkSettings: { Networks: {} },
    Mounts: [],
  };
  const fingerprint = containerRuntimeFingerprint(container);

  assert.notEqual(containerRuntimeFingerprint({ ...container, Config: { ...container.Config, Passwd: true } }), fingerprint);
  assert.throws(() => containerRuntimeFingerprint({ ...container, Config: { ...container.Config, Passwd: 'fixture-value' } }), /Config.Passwd must be a boolean/);
  assert.throws(() => containerRuntimeFingerprint({ ...container, HostConfig: { Passwd: false } }), /Potential plaintext secret in HostConfig property: Passwd/);
});

test('legacy startup fence allows only marker-free starts or a unit-specific recovery permit', () => {
  const originalRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = '/run/user/1000';
  try {
    const host = new PodmanStandaloneHost({
      routeFile: '/home/codexia/.config/codexia/route',
      quadletDirectory: '/home/codexia/.config/containers/systemd',
      githubTokenFile: '/home/codexia/.config/codexia/github-token',
      stateFile: '/home/codexia/.local/state/codexia/controller.json',
      frontendIdentityUrl: 'https://example.test/desktop/update-identity.json',
      browserAuth: { mode: 'token' },
    });
    const paths = host.backupStartupFencePaths();

    assert.match(paths.api.content, /^\[Unit\]\nConditionPathExists=\|!/u);
    assert.match(paths.api.content, /backup-recovery\.json/u);
    assert.match(paths.api.content, /\nConditionPathExists=\|\/run\/user\/1000\//u);
    assert.notEqual(paths.api.permit, paths.tunnel.permit);
    assert.ok(paths.api.content.includes(paths.api.permit));
    assert.ok(paths.tunnel.content.includes(paths.tunnel.permit));
  } finally {
    if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = originalRuntime;
  }
});

test('production host exposes an assertion for the loaded durable startup fence', () => {
  assert.equal(typeof PodmanStandaloneHost.prototype.assertBackupStartupFence, 'function');
});

test('stale process-bound recovery permits are removable but live permits fail closed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-start-permit-'));
  const originalRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = directory;
  const host = new PodmanStandaloneHost({
    routeFile: '/home/codexia/.config/codexia/route',
    quadletDirectory: '/home/codexia/.config/containers/systemd',
    githubTokenFile: '/home/codexia/.config/codexia/github-token',
    stateFile: '/home/codexia/.local/state/codexia/controller.json',
    frontendIdentityUrl: 'https://example.test/desktop/update-identity.json',
    browserAuth: { mode: 'token' },
  });
  const entry = host.backupStartupFencePaths().api;
  const descriptor = await open('/dev/null', 'r');
  try {
    await symlink('/proc/2147483647/fd/9', entry.permit);
    await host.removeBackupStartupPermits();
    await assert.rejects(lstat(entry.permit), { code: 'ENOENT' });

    await symlink(`/proc/${process.pid}/fd/${descriptor.fd}`, entry.permit);
    await assert.rejects(host.removeBackupStartupPermits(), /still held by a live process/);
  } finally {
    await descriptor.close();
    if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = originalRuntime;
    await rm(directory, { recursive: true, force: true });
  }
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
