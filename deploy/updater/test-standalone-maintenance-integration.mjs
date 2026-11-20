import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { signUpdateChannel } from '../../scripts/update-channel.mjs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PodmanStandaloneHost,
  assertRuntimeProcessInSystemdUnit,
  assertRuntimeProcessMemoryMax,
  assertRuntimeObservation,
  assertRuntimeSystemdCpuQuota,
  assertRuntimeUnit,
  assertRuntimeUnitDropIns,
  browserAuthEnvironment,
  imageConfig,
  readRuntimeCapabilityStatus,
  runWithSensitiveInput,
  validateRuntimeContract,
} from './standalone-host.mjs';
import {
  MAINTENANCE_SOURCE_FILES,
  MAINTENANCE_UNIT_FILES,
  maintainStandaloneUpdater,
} from './standalone-maintenance.mjs';
import {
  atomicWrite,
  initialControllerState,
  loadControllerState,
} from '../../scripts/standalone-update-controller.mjs';

const UID = process.getuid();
const SERVICE = 'codexia-slot-blue.service';
const CONTAINER = 'codexia-slot-blue';
const ROTATION_PROXY_CONTAINER = 'codexia-api-proxy';
const POSTGRES_IMAGE = 'docker.io/library/postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536';
const BACKUP_DIGEST_FIXTURE = 'e'.repeat(64);
const SOURCE_ROOT = '/opt/codexia-updater';
const SOURCE_MARKER = path.join(SOURCE_ROOT, '.codexia-runtime-contract-source');
const FAILURE_CPU = 175;
let injectedFailure = false;

function run(binary, args, options = {}) {
  try {
    return execFileSync(binary, args, {
      encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], ...options,
    }).trim();
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    throw new Error(`${binary} ${args.join(' ')} failed (${String(error.status ?? 'unknown')})${output ? `: ${output}` : ''}`);
  }
}

function systemdState(unit) {
  return run('systemctl', ['--user', 'show', '--property=ActiveState', '--value', unit]);
}

async function waitForUnit(unit, expected) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (systemdState(unit) === expected) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`systemd unit ${unit} did not reach ${expected}`);
}

function normalizeImageId(value) {
  if (typeof value !== 'string') return '';
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

async function validateSlot(config, runtime, state, expectedImage) {
  assert.ok(['blue', 'green'].includes(state.journal.active.slot));
  assert.equal(state.installed.profile, runtime.profile);
  const activeSlot = state.journal.active.slot;
  const activeName = `codexia-slot-${activeSlot}`;
  const unit = `${activeName}.service`;
  assert.equal(systemdState(unit), 'active', `${unit} is not active`);
  const observed = JSON.parse(run('podman', ['inspect', '--type', 'container', activeName]))[0];
  assert.equal(observed.State?.Running, true, `${activeName} is not running`);
  assert.equal(normalizeImageId(observed.Image), expectedImage, `${activeName} is not the synthetic pinned fixture image`);

  for (const slot of ['blue', 'green']) {
    const slotName = `codexia-slot-${slot}`;
    const filename = path.join(config.quadletDirectory, `${slotName}.container`);
    let content;
    try { content = await readFile(filename, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT' && slot !== activeSlot) continue;
      throw error;
    }
    const file = await lstat(filename);
    assert.ok(file.isFile() && !file.isSymbolicLink(), `${filename} is not a regular file`);
    assert.equal(file.mode & 0o777, 0o600, `${filename} mode drift`);
    assert.equal(file.uid, UID, `${filename} owner drift`);
    const configuredImage = content.match(/^Image=(\S+)$/mu)?.[1];
    assert.equal(configuredImage, expectedImage, `${filename} image drift`);
    const expected = imageConfig({ image: expectedImage, profile: runtime.profile }, browserAuthEnvironment(config, new URL(config.frontendIdentityUrl).origin), runtime).replace('PLACEHOLDER', slotName);
    assert.equal(content, expected, `${filename} runtime drift`);
    assertRuntimeUnitDropIns(run('systemctl', ['--user', 'show', '--property=DropInPaths', '--value', `${slotName}.service`]));
    if (slot === activeSlot) {
      const capabilityStatus = await readRuntimeCapabilityStatus(observed, `${slotName} writer`);
      assertRuntimeObservation(observed, runtime, JSON.parse(run('podman', ['image', 'inspect', expectedImage]))[0].Config?.Env, expected, capabilityStatus);
      assertRuntimeUnit(run('systemctl', ['--user', 'cat', unit]), runtime);
      await assertRuntimeSystemdCpuQuota(unit, runtime);
      const processCgroupPath = await assertRuntimeProcessInSystemdUnit(unit, observed, `${slotName} writer`);
      await assertRuntimeProcessMemoryMax(processCgroupPath, runtime, `${slotName} writer`);
    }
  }
  const inactive = activeSlot === 'blue' ? 'green' : 'blue';
  const inactiveName = `codexia-slot-${inactive}`;
  const inactiveResult = spawnSync('podman', ['container', 'exists', inactiveName], { timeout: 15000, stdio: 'ignore' });
  if (inactiveResult.status === 0) {
    const inactiveObserved = JSON.parse(run('podman', ['inspect', '--type', 'container', inactiveName]))[0];
    assert.notEqual(inactiveObserved.State?.Running, true, `${inactiveName} is an overlapping writer`);
  } else assert.equal(inactiveResult.status, 1, `Podman state for ${inactiveName} is unobservable`);
}

export async function verifyFixture(configPath) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const state = await loadControllerState(config.stateFile);
  const runtime = validateRuntimeContract(config.runtime);
  const route = (await readFile(config.routeFile, 'utf8')).trim();
  assert.equal(route, state.journal.active.slot, 'Fixture route differs from committed active slot');
  const image = normalizeImageId(JSON.parse(run('podman', ['inspect', '--type', 'container', CONTAINER]))[0].Image);
  const info = JSON.parse(run('podman', ['image', 'inspect', image]))[0];
  assert.ok(info.Config?.Labels?.['codexia.runtime-contract-test'], 'Synthetic image ownership label is absent');
  await validateSlot(config, runtime, state, image);
  const response = JSON.parse(run('podman', ['exec', CONTAINER, 'node', '--input-type=module', '-e',
    'const response=await fetch("http://127.0.0.1:3000/api/version");if(!response.ok)process.exit(1);process.stdout.write(await response.text())']));
  assert.equal(response.name, 'codexia');
  assert.equal(response.version, state.installed.version);
  assert.equal(response.profile, runtime.profile);
  assert.equal(response.apiEpoch, state.installed.apiEpoch);
  assert.equal(response.hosted, false);
  return { state, runtime, image };
}

function fixtureConfig({ home, stateDir, quadletDir, runtime }) {
  const privateDir = path.join(home, '.config', 'codexia-updater');
  return {
    format: 'codexia-standalone-updater/v1', enabled: true,
    stateFile: path.join(stateDir, 'controller.json'),
    routeFile: path.join(stateDir, 'route'),
    quadletDirectory: quadletDir,
    publicKeyFile: path.join(privateDir, 'channel-public.pem'),
    githubTokenFile: path.join(privateDir, 'github-read-token'),
    frontendIdentityUrl: 'https://codexia.invalid/desktop/update-identity.json',
    observeMilliseconds: 300000, initialSlot: 'blue',
    browserAuth: { mode: 'token' }, runtime,
  };
}

async function writeFixtureSource(repoRoot) {
  const sourceInfo = await lstat(SOURCE_ROOT);
  assert.ok(sourceInfo.isDirectory() && !sourceInfo.isSymbolicLink(), 'Fixture updater source root is not a real directory');
  assert.equal(sourceInfo.uid, UID, 'Fixture updater source root is not owned by the disposable user');
  assert.equal((await readFile(SOURCE_MARKER, 'utf8')).trim(), 'codexia-runtime-contract-source/v1', 'Fixture updater source marker is absent or invalid');
  assert.deepEqual(await readdir(SOURCE_ROOT), [path.basename(SOURCE_MARKER)], 'Fixture updater source directory is not pristine');
  for (const relative of MAINTENANCE_SOURCE_FILES) {
    const source = path.join(repoRoot, relative);
    const target = path.join(SOURCE_ROOT, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const content = await readFile(source);
    await writeFile(target, content, { mode: 0o600 });
    await chmod(target, 0o600);
  }
}

async function writeOldVerifierShim(repoRoot) {
  const target = path.join(SOURCE_ROOT, 'deploy/updater/standalone-updater.mjs');
  const helperUrl = pathToFileURL(path.resolve(repoRoot, 'deploy/updater/test-standalone-maintenance-integration.mjs')).href;
  const content = `import { verifyFixture } from ${JSON.stringify(helperUrl)};\n` +
    `if (process.argv[2] !== 'verify' || !process.argv[3]) throw new Error('Fixture old-code verifier only accepts verify');\n` +
    `await verifyFixture(process.argv[3]);\n`;
  await writeFile(target, content, { mode: 0o600 });
  await chmod(target, 0o600);
}

async function createCandidate({ repoRoot, stateDir, configPath, sourceDir, unitDir, quadletDir, candidateConfig, nonce }) {
  const root = path.join(stateDir, 'maintenance', 'candidates', nonce);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const writeCandidate = async (relative, content) => {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, content, { mode: 0o600, flag: 'wx' });
    await chmod(destination, 0o600);
  };
  for (const relative of MAINTENANCE_SOURCE_FILES) await writeCandidate(relative, await readFile(path.join(repoRoot, relative)));
  for (const filename of MAINTENANCE_UNIT_FILES) {
    if (filename === 'codexia-updater.timer') continue;
    await writeCandidate(path.join('units', filename), await readFile(path.join(repoRoot, 'deploy/updater', `${filename}.example`)));
  }
  // Keep the synthetic timer far enough in the future that the disposable
  // acceptance run can never fire the updater service as a side effect.
  let timer = await readFile(path.join(repoRoot, 'deploy/updater/codexia-updater.timer.example'), 'utf8');
  timer = timer.replace('OnBootSec=5min', 'OnBootSec=24h').replace('OnUnitInactiveSec=5min', 'OnUnitInactiveSec=24h');
  await writeCandidate('units/codexia-updater.timer', timer);
  await writeCandidate('config.json', JSON.stringify(candidateConfig, null, 2) + '\n');
  await writeCandidate('quadlet/codexia-api-proxy.container', await readFile(path.join(quadletDir, 'codexia-api-proxy.container')));
  const manifest = { format: 'codexia-updater-maintenance/v1', candidateRoot: root, sourceDir, unitDir, configPath };
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest) + '\n', { mode: 0o600, flag: 'wx' });
  return { root, manifestPath, manifest };
}

async function runLiveAnsibleTimerCheck({ repoRoot, workDir, enabled, shouldPass }) {
  const ansible = process.env.ANSIBLE_PLAYBOOK || 'ansible-playbook';
  const configPath = path.join(workDir, `timer-config-${enabled ? 'enabled' : 'disabled'}.json`);
  const playbookPath = path.join(workDir, 'verify-live-timer.yml');
  await writeFile(configPath, JSON.stringify({ enabled }) + '\n', { mode: 0o600 });
  await writeFile(playbookPath, `---\n- hosts: localhost\n  connection: local\n  gather_facts: false\n  tasks:\n    - ansible.builtin.slurp:\n        src: ${JSON.stringify(configPath)}\n      register: saved_config\n    - ansible.builtin.include_tasks: ${JSON.stringify(path.join(repoRoot, 'deploy/ansible/verify-timer.yml'))}\n`, { mode: 0o600 });
  const result = spawnSync(ansible, ['-i', 'localhost,', '-c', 'local', playbookPath], {
    encoding: 'utf8', timeout: 60000, env: process.env,
  });
  if (result.error) throw result.error;
  if (shouldPass && result.status !== 0) throw new Error(`Live Ansible timer check unexpectedly failed:\n${result.stdout}\n${result.stderr}`);
  if (!shouldPass && result.status === 0) throw new Error(`Live Ansible timer check accepted mismatched enabled=${enabled}`);
}

async function runInterruptedBootRecovery({ repoRoot, workDir, stateDir, configPath, candidate, environment, expectedState, expectedRuntime, interruption }) {
  assert.ok(['after-write', 'after-writer-drain'].includes(interruption));
  const faultBin = path.join(workDir, `fault-bin-${interruption}`);
  await mkdir(faultBin, { mode: 0o700 });
  const markerPath = path.join(stateDir, 'maintenance', 'in-progress.json');
  const observedPath = path.join(workDir, `fault-observed-${interruption}`);
  const systemctlPath = path.join(faultBin, 'systemctl');
  const shim = [
    '#!/bin/sh',
    '/usr/bin/systemctl "$@"',
    'status=$?',
    'if [ "$status" -ne 0 ]; then exit "$status"; fi',
    'if [ "${CODEXIA_RUNTIME_MAINTENANCE_KILL_AT-}" = "after-write" ] && [ "$1" = "--user" ] && [ "$2" = "daemon-reload" ] && [ -f "${CODEXIA_RUNTIME_MAINTENANCE_MARKER-}" ]; then',
    '  printf "%s\\n" after-write > "${CODEXIA_RUNTIME_MAINTENANCE_KILL_MARKER}"',
    '  kill -KILL "$PPID"',
    'fi',
    'if [ "${CODEXIA_RUNTIME_MAINTENANCE_KILL_AT-}" = "after-writer-drain" ] && [ "$1" = "--user" ] && [ "$2" = "stop" ] && [ "$3" = "codexia-slot-blue.service" ] && [ -f "${CODEXIA_RUNTIME_MAINTENANCE_MARKER-}" ]; then',
    '  printf "%s\\n" after-writer-drain > "${CODEXIA_RUNTIME_MAINTENANCE_KILL_MARKER}"',
    '  kill -KILL "$PPID"',
    'fi',
    'exit "$status"',
  ].join('\n') + '\n';
  await writeFile(systemctlPath, shim, { mode: 0o700, flag: 'wx' });

  const wrapper = path.join(SOURCE_ROOT, 'deploy/updater/codexia-updater');
  const testEntry = path.resolve(repoRoot, 'deploy/updater/test-standalone-maintenance-integration.mjs');
  const killEnv = {
    ...environment,
    PATH: faultBin + path.delimiter + environment.PATH,
    CODEXIA_RUNTIME_MAINTENANCE_KILL_AT: interruption,
    CODEXIA_RUNTIME_MAINTENANCE_MARKER: markerPath,
    CODEXIA_RUNTIME_MAINTENANCE_KILL_MARKER: observedPath,
  };
  const interrupted = spawnSync('flock', ['--exclusive', '--nonblock', '--no-fork', path.join(stateDir, 'host.lock'), process.execPath, testEntry, '--maintain', candidate.manifestPath, 'expect-interruption'], {
    encoding: 'utf8', timeout: 240000, maxBuffer: 4 * 1024 * 1024, env: killEnv,
  });
  if (interrupted.error) throw interrupted.error;
  assert.equal(interrupted.signal, 'SIGKILL', `Maintenance did not terminate at ${interruption}: ${interrupted.stdout}\n${interrupted.stderr}`);
  assert.equal((await readFile(observedPath, 'utf8')).trim(), interruption, `Fault injection did not reach ${interruption}`);
  const markerInfo = await lstat(markerPath);
  assert.ok(markerInfo.isFile() && !markerInfo.isSymbolicLink(), 'Interrupted maintenance marker was not retained');
  assert.equal(JSON.parse(await readFile(markerPath, 'utf8')).runtimeChanged, true, 'Fault-injected transaction did not exercise typed runtime recovery');
  const directVerify = spawnSync('sh', [wrapper, 'verify', configPath], {
    encoding: 'utf8', timeout: 240000, maxBuffer: 4 * 1024 * 1024, env: environment,
  });
  if (directVerify.error) throw directVerify.error;
  assert.notEqual(directVerify.status, 0, 'Installed verify accepted pending maintenance');
  assert.match(directVerify.stderr, /Pending runtime maintenance requires recovery before other operations/u);
  const interruptedState = await loadControllerState(path.join(stateDir, 'controller.json'));
  assert.equal(interruptedState.paused, true, 'Interrupted maintenance did not keep the controller paused');
  await assertTimerState('inactive', 'enabled');
  if (interruption === 'after-write') {
    assert.equal((await readFile(path.join(stateDir, 'route'), 'utf8')), 'blue\n', 'Pre-drain interruption unexpectedly changed the route');
    assert.equal(systemdState(SERVICE), 'active', 'Pre-drain interruption unexpectedly stopped the writer');
    const originalMarker = await readFile(markerPath, 'utf8');
    const ambiguousMarker = JSON.parse(originalMarker);
    ambiguousMarker.routeFile = path.join(stateDir, 'unexpected-route');
    await atomicWrite(markerPath, JSON.stringify(ambiguousMarker) + '\n');
    const refused = spawnSync('sh', [wrapper, 'boot', configPath], {
      encoding: 'utf8', timeout: 240000, maxBuffer: 4 * 1024 * 1024, env: environment,
    });
    if (refused.error) throw refused.error;
    assert.notEqual(refused.status, 0, 'Boot accepted a maintenance marker for a different route');
    assert.equal((await readFile(path.join(stateDir, 'route'), 'utf8')), 'blocked\n', 'Ambiguous recovery did not keep ingress blocked');
    await assertTimerState('inactive', 'enabled');
    await lstat(markerPath);
    await atomicWrite(markerPath, originalMarker);
  } else {
    assert.equal((await readFile(path.join(stateDir, 'route'), 'utf8')), 'blocked\n', 'Writer-drain interruption did not fence ingress');
    // The fault shim kills the controller after systemctl stop but before
    // stopWriter can reset a failed unit after Podman removes its container.
    // Both inactive and failed are valid interruption boundaries, but only
    // when the actual writer is absent. Leave reset/restart to boot recovery.
    assert.ok(['inactive', 'failed'].includes(systemdState(SERVICE)),
      'Writer-drain interruption did not stop the active writer');
    const drained = spawnSync('podman', ['container', 'exists', CONTAINER], { timeout: 15000, stdio: 'ignore' });
    if (drained.error) throw drained.error;
    assert.equal(drained.status, 1, 'Writer container remains or absence is unobservable after interruption');
  }

  const preload = path.join(repoRoot, 'deploy/updater/test-standalone-maintenance-preload.mjs');
  const bootEnvironment = {
    ...environment,
    NODE_OPTIONS: [environment.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(' '),
    CODEXIA_RUNTIME_MAINTENANCE_BOOT_RECOVERY: 'yes',
  };
  const boot = spawnSync('sh', [wrapper, 'boot', configPath], {
    encoding: 'utf8', timeout: 240000, maxBuffer: 4 * 1024 * 1024, env: bootEnvironment,
  });
  if (boot.error) throw boot.error;
  if (boot.status !== 0) throw new Error(`Canonical boot recovery failed after ${interruption} (${boot.status}):\n${boot.stdout}\n${boot.stderr}`);
  await assert.rejects(lstat(markerPath), { code: 'ENOENT' }, 'Successful boot recovery retained the transaction marker');
  const recoveredConfig = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(recoveredConfig.runtime, expectedRuntime, 'Boot recovery did not restore the previous runtime configuration');
  const recoveredState = await loadControllerState(path.join(stateDir, 'controller.json'));
  assert.deepEqual(recoveredState, expectedState, 'Boot recovery changed the controller journal/checkpoint or pause state');
  assert.equal((await readFile(path.join(stateDir, 'route'), 'utf8')), 'blue\n', 'Boot recovery did not restore the committed route');
  await assertTimerState('active', 'enabled');
  await verifyFixture(configPath);
  run('podman', ['exec', CONTAINER, 'node', '--input-type=module', '-e',
    'import {readFileSync} from "node:fs";const nl=String.fromCharCode(10);for(const [p,v] of [["/data/runtime-contract-marker","data-marker-v1"+nl],["/history/runtime-contract-marker","history-marker-v1"+nl]])if(readFileSync(p,"utf8")!==v)throw new Error(p)']);
}

export function installTestAdapters(hostClass = PodmanStandaloneHost) {
  const expectedImage = process.env.CODEXIA_RUNTIME_MAINTENANCE_IMAGE;
  const stopWriterWithRuntimeProof = hostClass.prototype.stopWriter;
  const verifyWriterUnitsWithPinnedIdentity = hostClass.prototype.verifyWriterUnits;
  const assertProxyRuntimeWithPinnedRepoDigest = hostClass.prototype.assertProxyRuntime;
  assert.match(expectedImage ?? '', /^sha256:[a-f0-9]{64}$/u, 'Synthetic local image identity is missing');

  if (process.env.CODEXIA_RUNTIME_MAINTENANCE_BACKUP_DIGEST) {
    const backupDigest = process.env.CODEXIA_RUNTIME_MAINTENANCE_BACKUP_DIGEST;
    assert.match(backupDigest, /^[a-f0-9]{64}$/u);
    // The disposable VM has no off-VM backup destination. Keep proof/receipt
    // structure, release, generation and live PostgreSQL identity real while
    // substituting only the external artifact digest lookup.
    hostClass.prototype.backupArtifactIdentity = async function syntheticPublishedArtifact(directory) {
      assert.ok(path.basename(directory).startsWith('codexia-'), 'Synthetic backup path lost its artifact identity');
      return backupDigest;
    };
    hostClass.prototype.assertProxyRuntime = async function assertDisposableStableProxy() {
      assert.equal(systemdState(`${ROTATION_PROXY_CONTAINER}.service`), 'active', 'Stable proxy fixture is not active');
      // The local synthetic app image is not the proxy image. Keep the
      // production RepoDigest, container/image identity, mount, network,
      // capability and read-only checks for the pinned proxy fixture.
      await assertProxyRuntimeWithPinnedRepoDigest.call(this);
    };
    hostClass.prototype.verifyBlockedPasswordRotation = async function verifyBlockedPostgresRotation(slot, release) {
      assert.deepEqual(await this.observe(), { route: 'blocked', writers: [{ slot, image: release.image }] });
      await this.assertProxyRuntime();
      await this.waitReady(`codexia-slot-${slot}`, release);
      const response = run('podman', ['exec', ROTATION_PROXY_CONTAINER, 'node', '--input-type=module', '-e',
        'const r=await fetch("http://127.0.0.1:3000/api/version",{signal:AbortSignal.timeout(3000)});process.stdout.write(String(r.status));']);
      assert.equal(response, '503', 'Stable proxy fixture admitted traffic while rotation was fenced');
    };
    hostClass.prototype.probe = async function probePostgresRotationWriter(slot, release) {
      await this.assertProxyRuntime();
      await this.waitReady(`codexia-slot-${slot}`, release);
      const result = JSON.parse(run('podman', ['exec', ROTATION_PROXY_CONTAINER, 'node', '--input-type=module', '-e',
        'const r=await fetch("http://127.0.0.1:3000/api/version",{signal:AbortSignal.timeout(3000)});if(!r.ok)process.exit(1);process.stdout.write(JSON.stringify({slot:r.headers.get("x-codexia-upstream-slot"),version:await r.json()}));']));
      assert.equal(result.slot, slot, 'Stable proxy selected a different writer slot');
      assert.equal(result.version.name, 'codexia');
      assert.equal(result.version.version, release.version);
      assert.equal(result.version.profile, release.profile);
      assert.equal(result.version.apiEpoch, release.apiEpoch);
    };
  }

  if(process.env.CODEXIA_RUNTIME_MAINTENANCE_TUNNEL_ROTATION==='yes'){
    const tunnelActive=async()=>systemdState('codexia-tunnel.service')==='active';
    const readTunnelSecret=()=>{
      const [secret]=JSON.parse(run('podman',['secret','inspect','--showsecret','codexia-tunnel-token']));
      assert.ok(secret?.ID&&typeof secret.SecretData==='string','Disposable Tunnel secret is unobservable');
      return {id:secret.ID,owner:secret.Spec?.Labels?.['io.codexia.tunnel-token-rotation'],token:secret.SecretData};
    };
    hostClass.prototype.tunnelServiceActive=async function syntheticTunnelServiceActive(){return tunnelActive();};
    hostClass.prototype.tunnelRotationServiceActive=async function syntheticTunnelRotationServiceActive(){return tunnelActive();};
    hostClass.prototype.tunnelServiceActive=async function syntheticTunnelServiceActive(){return tunnelActive();};
    hostClass.prototype.assertTunnelStoppedForRotation=async function assertSyntheticTunnelStopped(){
      assert.equal(await tunnelActive(),false,'Disposable Tunnel service is not stopped for secret replacement');
      assert.equal(spawnSync('podman',['container','exists','codexia-tunnel'],{stdio:'ignore'}).status,1,
        'Disposable Tunnel container unexpectedly exists while its synthetic systemd service is stopped');
    };
    hostClass.prototype.captureTunnelTokenRotation=async function captureSyntheticTunnelRotation(replacement,operationId,state){
      assert.equal(await tunnelActive(),true,'Tunnel rotation requires active synthetic service');
      const current=readTunnelSecret();
      const digest=value=>createHash('sha256').update(value).digest('hex');
      assert.notEqual(current.token,replacement,'Synthetic Tunnel replacement must differ');
      assert.deepEqual(await this.observe(),{route:state.journal.active.slot,writers:[{slot:state.journal.active.slot,image:state.installed.image}]});
      return {operationId,originalSecretId:current.id,previousDigest:digest(current.token),replacementDigest:digest(replacement),
        sourceDigest:createHash('sha256').update('synthetic-tunnel-quadlet').digest('hex'),
        fragmentDigest:createHash('sha256').update('synthetic-tunnel-unit').digest('hex'),
        imageId:expectedImage.slice('sha256:'.length),runtimeDigest:createHash('sha256').update('synthetic-tunnel-runtime').digest('hex')};
    };
    hostClass.prototype.assertTunnelTokenRotationSources=async function assertSyntheticTunnelSources(snapshot){
      const current=readTunnelSecret();
      const digest=createHash('sha256').update(current.token).digest('hex');
      assert.ok((current.id===snapshot.originalSecretId&&digest===snapshot.previousDigest)||
        (current.owner===snapshot.operationId&&[snapshot.previousDigest,snapshot.replacementDigest].includes(digest)),
      'Synthetic Tunnel secret changed outside its rotation');
      return current;
    };
    hostClass.prototype.verifyTunnelTokenRotation=async function verifySyntheticTunnelRotation(snapshot,expectedDigest){
      const current=await this.assertTunnelTokenRotationSources(snapshot);
      assert.equal(createHash('sha256').update(current.token).digest('hex'),expectedDigest);
      assert.equal(await tunnelActive(),true,'Synthetic Tunnel did not return active');
    };
  }

  // Only this disposable test adapter emulates the external metadata endpoints.
  // The actual maintenance file writes, lock, systemd timer and recovery are real.
  if (process.env.CODEXIA_RUNTIME_MAINTENANCE_PROBE_KEY) {
    hostClass.prototype.fetchChannel = async function fetchSyntheticChannel() {
      const token=(await readFile(this.config.githubTokenFile,'utf8')).trim();
      assert.ok(['fixture-old-github','fixture-new-github'].includes(token),'Synthetic GitHub token rejected');
      const canonical=this.config.githubTokenFile===path.join(path.dirname(this.config.publicKeyFile),'github-read-token');
      if(canonical&&token==='fixture-new-github'){
        if(process.env.CODEXIA_RUNTIME_MAINTENANCE_PROBE_FAILURE==='after-write')throw Error('Synthetic post-write credential rejection');
        if(process.env.CODEXIA_RUNTIME_MAINTENANCE_PROBE_FAILURE==='crash')process.kill(process.pid,'SIGKILL');
      }
      const state=await loadControllerState(this.config.stateFile);
      const now=Date.now();
      const privateKey=await readFile(process.env.CODEXIA_RUNTIME_MAINTENANCE_PROBE_KEY,'utf8');
      return signUpdateChannel({format:'codexia-update-channel/v1',sequence:1,issuedAt:new Date(now-1000).toISOString(),
        expiresAt:new Date(now+60000).toISOString(),releases:[state.installed]},privateKey,now);
    };
    hostClass.prototype.probeAccessCredentials = async function probeSyntheticAccess(release) {
      const identity=await this.frontendIdentity();
      assert.equal(identity.profile,release.profile);
      assert.equal(identity.apiEpoch,release.apiEpoch);
    };
    hostClass.prototype.frontendIdentity = async function fetchSyntheticFrontend() {
      const id=(await readFile(this.config.accessClientIdFile,'utf8')).trim();
      const secret=(await readFile(this.config.accessClientSecretFile,'utf8')).trim();
      assert.ok((id==='fixture-old-id'&&secret==='fixture-old-secret')||(id==='fixture-new-id'&&secret==='fixture-new-secret'),'Synthetic Access pair rejected');
      const state=await loadControllerState(this.config.stateFile);
      return {profile:state.installed.profile,apiEpoch:state.installed.apiEpoch};
    };
  }

  hostClass.prototype.assertRuntimeSources = async function assertSyntheticRuntimeSources() {
    validateRuntimeContract(this.runtime);
    assert.equal(this.runtime.modelCachePath, null, 'Locked maintenance fixture must not mount host model data');
  };

  hostClass.prototype.observe = async function observeSyntheticHost() {
    const state = await loadControllerState(this.config.stateFile);
    const route = (await readFile(this.config.routeFile, 'utf8')).trim();
    const writers = [];
    for (const slot of ['blue', 'green']) {
      const name = `codexia-slot-${slot}`;
      const result = spawnSync('podman', ['container', 'exists', name], { timeout: 15000, stdio: 'ignore' });
      if (result.status === 1) continue;
      assert.equal(result.status, 0, `Podman state for ${name} is unobservable`);
      const observed = JSON.parse(run('podman', ['inspect', '--type', 'container', name]))[0];
      if (!observed.State?.Running) continue;
      assert.equal(normalizeImageId(observed.Image), expectedImage, `${name} has an unexpected synthetic image`);
      writers.push({ slot, image: state.journal.active.image });
    }
    return { route, writers };
  };

  hostClass.prototype.verifyWriterUnits = async function verifySyntheticWriterUnits(state) {
    assert.match(state?.installed?.image ?? '', /^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u, 'Synthetic controller release identity is not digest pinned');
    const restoredUnits = [];
    try {
      for (const slot of ['blue', 'green']) {
        const filename = path.join(this.config.quadletDirectory, `codexia-slot-${slot}.container`);
        let content;
        try { content = await readFile(filename, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT' && slot !== state.journal.active.slot) continue; throw error; }
        const image = content.match(/^Image=(\S+)$/mu)?.[1];
        assert.ok(image === expectedImage || image === state.installed.image, `${filename} has an unexpected fixture image identity`);
        if (image === expectedImage) {
          restoredUnits.push({ filename, content });
          await atomicWrite(filename, content.replace(/^Image=\S+$/mu, `Image=${state.installed.image}`));
        }
      }
      await verifyWriterUnitsWithPinnedIdentity.call(this, state);
    } finally {
      for (const { filename, content } of restoredUnits.reverse()) await atomicWrite(filename, content);
    }
    const observed = await this.observe();
    if(observed.writers.length){
      assert.deepEqual(observed.writers, [{ slot: state.journal.active.slot, image: state.installed.image }], 'Synthetic maintenance must retain exactly one active writer');
      await validateSlot(this.config, this.runtime, state, expectedImage);
    }else assert.equal(observed.route,'blocked','Absent writer is only admissible during blocked recovery');
  };

  hostClass.prototype.convergeWriterUnits = async function convergeSyntheticWriterUnits(state) {
    assert.equal(state.journal.active.slot, 'blue');
    for (const slot of ['blue', 'green']) {
      const name = `codexia-slot-${slot}`;
      const filename = path.join(this.config.quadletDirectory, `${name}.container`);
      let old;
      try { old = await readFile(filename, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT' && slot === 'green') continue; throw error; }
      assert.equal(old.match(/^Image=(\S+)$/mu)?.[1], expectedImage, `${name} source does not use the synthetic pinned image`);
      await atomicWrite(filename, imageConfig({ image: expectedImage, profile: this.runtime.profile }, this.authEnvironment, this.runtime).replace('PLACEHOLDER', name));
    }
    run('systemctl', ['--user', 'daemon-reload']);
    for (const slot of ['blue', 'green']) {
      const name = `codexia-slot-${slot}`;
      const filename = path.join(this.config.quadletDirectory, `${name}.container`);
      try { await lstat(filename); } catch (error) { if (error.code === 'ENOENT' && slot === 'green') continue; throw error; }
      assertRuntimeUnitDropIns(run('systemctl', ['--user', 'show', '--property=DropInPaths', '--value', `${name}.service`]));
    }
  };

  hostClass.prototype.stopWriter = async function stopSyntheticWriter(slot) {
    assert.equal(slot, 'blue');
    await stopWriterWithRuntimeProof.call(this, slot);
  };

  hostClass.prototype.startWriter = async function startSyntheticWriter(slot, release) {
    assert.equal(slot, 'blue');
    assert.equal(release.profile, this.runtime.profile);
    const observed = await this.observe();
    assert.deepEqual(observed.writers, [], 'Runtime maintenance attempted to overlap writers');
    run('systemctl', ['--user', 'start', SERVICE], { timeout: 120000 });
    await waitForUnit(SERVICE, 'active');
    await validateSlot(this.config, this.runtime, await loadControllerState(this.config.stateFile), expectedImage);
  };

  hostClass.prototype.probe = async function probeSyntheticWriter(slot, release) {
    assert.equal(slot, 'blue');
    assert.equal(release.profile, this.runtime.profile);
    const result = JSON.parse(run('podman', ['exec', CONTAINER, 'node', '--input-type=module', '-e',
      'const ready=await fetch("http://127.0.0.1:3000/health/ready");if(!ready.ok)process.exit(1);const response=await fetch("http://127.0.0.1:3000/api/version");if(!response.ok)process.exit(1);process.stdout.write(await response.text())']));
    assert.equal(result.name, 'codexia');
    assert.equal(result.version, release.version);
    assert.equal(result.profile, release.profile);
    assert.equal(result.apiEpoch, release.apiEpoch);
    if (!injectedFailure && process.env.CODEXIA_RUNTIME_MAINTENANCE_FAIL_CPU === String(FAILURE_CPU) && this.runtime.resources.cpuQuotaPercent === FAILURE_CPU) {
      injectedFailure = true;
      throw new Error('synthetic post-update readiness failure');
    }
  };
}

async function performMaintenance(manifestPath, outcome) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  let maintain=maintainStandaloneUpdater;
  if(manifest.rotateProbeCredentials){
    const installedHost=await import(pathToFileURL(path.join(SOURCE_ROOT,'deploy/updater/standalone-host.mjs')).href);
    const installedMaintenance=await import(pathToFileURL(path.join(SOURCE_ROOT,'deploy/updater/standalone-maintenance.mjs')).href);
    installTestAdapters(installedHost.PodmanStandaloneHost);
    maintain=installedMaintenance.maintainStandaloneUpdater;
  }else installTestAdapters();
  const config = JSON.parse(await readFile(manifest.configPath, 'utf8'));
  const state = await loadControllerState(config.stateFile);
  const publicKey = await readFile(config.publicKeyFile, 'utf8');
  const store = { save: value => atomicWrite(config.stateFile, JSON.stringify(value) + '\n') };
  if (outcome === 'expect-failure') {
    await assert.rejects(maintain({ config, manifestPath, publicKey, state, store }), /Updater maintenance failed; previous source\/config\/units were restored/u);
  } else if (outcome === 'expect-success') {
    const result = await maintain({ config, manifestPath, publicKey, state, store });
    assert.equal(result.format, 'codexia-updater-maintenance/v1');
    if(manifest.rotateProbeCredentials)assert.equal(result.probeCredentialsRotated,true);
  } else if (outcome === 'expect-interruption') await maintain({ config, manifestPath, publicKey, state, store });
  else throw new Error('Unknown synthetic maintenance test outcome');
}

async function assertTimerState(active, enabled) {
  const observed = {
    active: run('systemctl', ['--user', 'show', '--property=ActiveState', '--value', 'codexia-updater.timer']),
    enabled: run('systemctl', ['--user', 'show', '--property=UnitFileState', '--value', 'codexia-updater.timer']),
  };
  assert.deepEqual(observed, { active, enabled }, 'Locked maintenance changed updater polling state');
}

function runAppPasswordQuery(sql) {
  return run('podman', ['exec', '-i', 'codexia-db', 'sh', '-ec',
    'export PGPASSWORD="$(cat /run/secrets/app-password)"; exec psql -X -w -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U codexia -d codexia'],
  { input: sql, stdio: ['pipe', 'pipe', 'pipe'] });
}

async function createPasswordRotationCandidate({ stateDir, config, userUnitDir, password }) {
  const candidateRoot = path.join(path.dirname(config.publicKeyFile), 'maintenance', 'candidates', randomBytes(16).toString('hex'));
  await mkdir(candidateRoot, { recursive: true, mode: 0o700 });
  const credentials = path.join(candidateRoot, 'credentials');
  const quadlet = path.join(candidateRoot, 'quadlet', 'codexia-db.container');
  await mkdir(credentials, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(quadlet), { recursive: true, mode: 0o700 });
  await writeFile(path.join(credentials, 'postgres-app-password'), password, { mode: 0o600, flag: 'wx' });
  await writeFile(quadlet, await readFile(path.join(config.quadletDirectory, 'codexia-db.container')), { mode: 0o600, flag: 'wx' });

  const backupDigest = BACKUP_DIGEST_FIXTURE;
  const state = await loadControllerState(config.stateFile);
  const databaseId = await new PodmanStandaloneHost(config).passwordRotationDatabaseId();
  const artifactName = `codexia-${new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const artifactDirectory = path.join(path.dirname(stateDir), artifactName);
  await mkdir(artifactDirectory, { mode: 0o700 });
  const proof = {
    format: 'codexia-controller-backup-proof/v1', artifactDirectory, checksumManifestSha256: backupDigest,
    databaseId, journalGeneration: state.journal.generation, release: state.installed,
  };
  await atomicWrite(path.join(stateDir, 'controller-backup-proof.json'), JSON.stringify(proof) + '\n');
  const receipt = { format: 'codexia-restore-receipt/v1', checksumManifestSha256: backupDigest };
  const receiptFile = path.join(candidateRoot, 'restore-receipt.json');
  await writeFile(receiptFile, JSON.stringify(receipt) + '\n', { mode: 0o600, flag: 'wx' });
  const manifest = {
    format: 'codexia-updater-maintenance/v1', rotatePostgresAppPassword: true,
    candidateRoot: candidateRoot, configPath: path.join(path.dirname(config.publicKeyFile), 'config.json'),
    sourceDir: SOURCE_ROOT, unitDir: userUnitDir,
    appPasswordFile: path.join(credentials, 'postgres-app-password'), restoreReceiptFile: receiptFile,
    databaseQuadletFile: quadlet,
  };
  const manifestPath = path.join(candidateRoot, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest) + '\n', { mode: 0o600, flag: 'wx' });
  return { root: candidateRoot, manifestPath, manifest, state, databaseId, artifactDirectory };
}

async function createPreflightPasswordRotationCandidate({stateDir,config,userUnitDir,password}){
  const candidateRoot=path.join(path.dirname(config.publicKeyFile),'maintenance','candidates',randomBytes(16).toString('hex'));
  const credentials=path.join(candidateRoot,'credentials');
  const quadlet=path.join(candidateRoot,'quadlet','codexia-db.container');
  await mkdir(credentials,{recursive:true,mode:0o700});
  await mkdir(path.dirname(quadlet),{recursive:true,mode:0o700});
  await writeFile(path.join(credentials,'postgres-preflight-password'),password,{mode:0o600,flag:'wx'});
  await writeFile(quadlet,await readFile(path.join(config.quadletDirectory,'codexia-db.container')),{mode:0o600,flag:'wx'});
  const state=await loadControllerState(config.stateFile);
  const databaseId=await new PodmanStandaloneHost(config).passwordRotationDatabaseId();
  const checksum=BACKUP_DIGEST_FIXTURE;
  const artifactDirectory=path.join(path.dirname(stateDir),`codexia-preflight-${randomUUID()}`);
  await mkdir(artifactDirectory,{mode:0o700});
  await atomicWrite(path.join(stateDir,'controller-backup-proof.json'),JSON.stringify({
    format:'codexia-controller-backup-proof/v1',artifactDirectory,checksumManifestSha256:checksum,
    databaseId,journalGeneration:state.journal.generation,release:state.installed,
  })+'\n');
  const receiptFile=path.join(candidateRoot,'restore-receipt.json');
  await writeFile(receiptFile,JSON.stringify({format:'codexia-restore-receipt/v1',checksumManifestSha256:checksum})+'\n',{mode:0o600,flag:'wx'});
  const manifest={format:'codexia-updater-maintenance/v1',rotatePostgresPreflightPassword:true,candidateRoot,
    configPath:path.join(path.dirname(config.publicKeyFile),'config.json'),sourceDir:SOURCE_ROOT,unitDir:userUnitDir,
    preflightPasswordFile:path.join(credentials,'postgres-preflight-password'),restoreReceiptFile:receiptFile,
    databaseQuadletFile:quadlet};
  const manifestPath=path.join(candidateRoot,'manifest.json');
  await writeFile(manifestPath,JSON.stringify(manifest)+'\n',{mode:0o600,flag:'wx'});
  return {root:candidateRoot,manifestPath,manifest,databaseId,artifactDirectory};
}

async function runPreflightPasswordRotationCandidate({repoRoot,candidate,configPath,environment,killAfterSql=false,killAfterSecret=false}){
  const wrapper=path.join(SOURCE_ROOT,'deploy/updater/codexia-updater');
  const preload=path.join(repoRoot,'deploy/updater/test-standalone-maintenance-preload.mjs');
  const env={...environment,CODEXIA_RUNTIME_MAINTENANCE_PREFLIGHT_PASSWORD_ROTATION:'yes',
    CODEXIA_RUNTIME_MAINTENANCE_BACKUP_DIGEST:BACKUP_DIGEST_FIXTURE,
    ...(killAfterSql?{CODEXIA_RUNTIME_MAINTENANCE_KILL_AFTER_PREFLIGHT_SQL:'yes'}:{}),
    ...(killAfterSecret?{CODEXIA_RUNTIME_MAINTENANCE_KILL_AFTER_PREFLIGHT_SECRET:'yes'}:{}),
    NODE_OPTIONS:[environment.NODE_OPTIONS,`--import=${preload}`].filter(Boolean).join(' ')};
  const child=spawnSync('sh',[wrapper,'maintain',configPath,candidate.manifestPath],
    {encoding:'utf8',timeout:240000,maxBuffer:4*1024*1024,env});
  if(child.error)throw child.error;
  if(killAfterSql||killAfterSecret)assert.equal(child.signal,'SIGKILL','Preflight interruption did not stop at its requested transaction boundary');
  else assert.equal(child.status,0,`Preflight password rotation failed (${child.status}):\n${child.stdout}\n${child.stderr}`);
  return child;
}

async function createApiAuthTokenCandidate({config,token}){
  const candidateRoot=path.join(path.dirname(config.publicKeyFile),'maintenance','candidates','api-token-'+randomBytes(16).toString('hex'));
  await mkdir(path.join(candidateRoot,'credentials'),{recursive:true,mode:0o700});
  const apiAuthTokenFile=path.join(candidateRoot,'credentials','api-auth-token');
  await writeFile(apiAuthTokenFile,token,{mode:0o600,flag:'wx'});
  const manifest={format:'codexia-updater-maintenance/v1',candidateRoot,
    configPath:path.join(path.dirname(config.publicKeyFile),'config.json'),sourceDir:SOURCE_ROOT,
    unitDir:path.resolve(config.quadletDirectory,'../../../.config/systemd/user'),
    rotateApiAuthToken:true,apiAuthTokenFile};
  const manifestPath=path.join(candidateRoot,'manifest.json');
  await writeFile(manifestPath,JSON.stringify(manifest)+'\n',{mode:0o600,flag:'wx'});
  return {candidateRoot,manifestPath};
}

async function runApiAuthTokenRotationCandidate({repoRoot,candidate,configPath,environment,killAtSecretCreate=false,killAtCompletedMarker=false}){
  const wrapper=path.join(SOURCE_ROOT,'deploy/updater/codexia-updater');
  const preload=path.join(repoRoot,'deploy/updater/test-standalone-maintenance-preload.mjs');
  let env={...environment,CODEXIA_RUNTIME_MAINTENANCE_AUTH_TOKEN_ROTATION:'yes',
    NODE_OPTIONS:[environment.NODE_OPTIONS,`--import=${preload}`].filter(Boolean).join(' ')};
  let observedFile;
  if(killAtSecretCreate){
    const faultBin=path.join(candidate.candidateRoot,'fault-bin');
    await mkdir(faultBin,{mode:0o700});
    observedFile=path.join(candidate.candidateRoot,'secret-created-before-process-death');
    const podmanPath=execFileSync('which',['podman'],{encoding:'utf8'}).trim();
    const shim=['#!/bin/sh',`"${podmanPath}" "$@"`,'status=$?','if [ "$status" -ne 0 ]; then exit "$status"; fi',
      'if [ "$1" = secret ] && [ "$2" = create ]; then','  for argument do',
      '    if [ "$argument" = codexia-auth-token ]; then',`      printf '%s\\n' created > "${observedFile}"`,
      '      kill -KILL "$PPID"','      break','    fi','  done','fi','exit "$status"'].join('\n')+'\n';
    await writeFile(path.join(faultBin,'podman'),shim,{mode:0o700,flag:'wx'});
    env={...env,PATH:faultBin+path.delimiter+env.PATH};
  }
  if(killAtCompletedMarker){
    const completedEnvironment={...env,CODEXIA_RUNTIME_MAINTENANCE_KILL_AT:'after-api-auth-completion-marker'};
    const child=spawnSync('sh',[wrapper,'maintain',configPath,candidate.manifestPath],
      {encoding:'utf8',timeout:240000,maxBuffer:4*1024*1024,env:completedEnvironment});
    if(child.error)throw child.error;
    assert.equal(child.signal,'SIGKILL','API token completion fault injection did not stop before rollback snapshot cleanup');
    const config=JSON.parse(await readFile(configPath,'utf8'));
    const markerPath=path.join(path.dirname(config.stateFile),'maintenance','in-progress.json');
    const marker=JSON.parse(await readFile(markerPath,'utf8'));
    assert.equal(marker.phase,'completed','API token fault injection did not preserve its durable completion marker');
    return {signal:child.signal};
  }
  const child=spawnSync('sh',[wrapper,'maintain',configPath,candidate.manifestPath],
    {encoding:'utf8',timeout:240000,maxBuffer:4*1024*1024,env});
  if(child.error)throw child.error;
  if(killAtSecretCreate){
    assert.equal(child.signal,'SIGKILL','API token fault injection did not terminate after secret creation');
    assert.equal((await readFile(observedFile,'utf8')).trim(),'created');
  }else if(child.status!==0){
    const loadFailure=/ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/u.test(`${child.stdout??''}\n${child.stderr??''}`);
    throw Error(`API token rotation failed with status ${String(child.status)}${loadFailure?' while loading its test preload':''}`);
  }
  return child;
}

async function createTunnelTokenCandidate({config,userUnitDir,token}){
  const candidateRoot=path.join(path.dirname(config.publicKeyFile),'maintenance','candidates','tunnel-token-'+randomBytes(16).toString('hex'));
  await mkdir(path.join(candidateRoot,'credentials'),{recursive:true,mode:0o700});
  const tunnelTokenFile=path.join(candidateRoot,'credentials','tunnel-token');
  await writeFile(tunnelTokenFile,token,{mode:0o600,flag:'wx'});
  const manifest={format:'codexia-updater-maintenance/v1',candidateRoot,
    configPath:path.join(path.dirname(config.publicKeyFile),'config.json'),sourceDir:SOURCE_ROOT,
    unitDir:userUnitDir,rotateTunnelToken:true,tunnelTokenFile};
  const manifestPath=path.join(candidateRoot,'manifest.json');
  await writeFile(manifestPath,JSON.stringify(manifest)+'\n',{mode:0o600,flag:'wx'});
  return {candidateRoot,manifestPath};
}
async function runTunnelTokenRotationCandidate({repoRoot,candidate,configPath,environment,killAtSecretCreate=false}){
  const wrapper=path.join(SOURCE_ROOT,'deploy/updater/codexia-updater');
  const preload=path.join(repoRoot,'deploy/updater/test-standalone-maintenance-preload.mjs');
  let env={...environment,CODEXIA_RUNTIME_MAINTENANCE_TUNNEL_ROTATION:'yes',
    NODE_OPTIONS:[environment.NODE_OPTIONS,`--import=${preload}`].filter(Boolean).join(' ')};
  if(killAtSecretCreate){
    const faultBin=path.join(candidate.candidateRoot,'fault-bin');
    await mkdir(faultBin,{mode:0o700});
    const podmanPath=execFileSync('which',['podman'],{encoding:'utf8'}).trim();
    const shim=['#!/bin/sh',`"${podmanPath}" "$@"`,'status=$?','if [ "$status" -ne 0 ]; then exit "$status"; fi',
      'if [ "$1" = secret ] && [ "$2" = create ]; then','  for argument do',
      '    if [ "$argument" = codexia-tunnel-token ]; then','      kill -KILL "$PPID"','      break','    fi','  done','fi','exit "$status"'].join('\n')+'\n';
    await writeFile(path.join(faultBin,'podman'),shim,{mode:0o700,flag:'wx'});
    env={...env,PATH:faultBin+path.delimiter+env.PATH};
  }
  const child=spawnSync('sh',[wrapper,'maintain',configPath,candidate.manifestPath],
    {encoding:'utf8',timeout:240000,maxBuffer:4*1024*1024,env});
  if(child.error)throw child.error;
  if(killAtSecretCreate){assert.equal(child.signal,'SIGKILL','Tunnel token fault injection did not stop after secret creation');}
  else assert.equal(child.status,0,`Tunnel token maintenance failed (${child.status}):\n${child.stdout}\n${child.stderr}`);
  return child;
}

async function proxyApiTokenStatus(token){
  const script="let token='';for await(const chunk of process.stdin)token+=chunk;token=token.replace(/\\n$/u,'');const r=await fetch('http://127.0.0.1:3000/api/v1/persistence/status',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});process.stdout.write(String(r.status));";
  const result=spawnSync('podman',['exec','-i','codexia-api-proxy','node','--input-type=module','-e',script],
    {encoding:'utf8',input:token,timeout:15000,maxBuffer:1024*1024});
  if(result.error)throw result.error;
  assert.equal(result.status,0,'Private proxy auth probe failed');
  return result.stdout.trim();
}

function readPodmanApiAuthTokenSecret(){
  const result=spawnSync('podman',['secret','inspect','--showsecret','codexia-auth-token'],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
  if(result.error)throw result.error;
  assert.equal(result.status,0,'Canonical API token secret could not be inspected');
  const [secret]=JSON.parse(result.stdout);
  assert.ok(typeof secret?.ID==='string'&&typeof secret?.SecretData==='string','Canonical API token secret identity is invalid');
  return secret;
}

async function recoverMaintenanceAtBoot({repoRoot,config,expectedImage,nonce,tunnelRotation=false,preflightRotation=false}){
  const watchedEnvironment=['NODE_OPTIONS','XDG_STATE_HOME','CODEXIA_RUNTIME_ACCEPTANCE_DISPOSABLE','CODEXIA_RUNTIME_MAINTENANCE_BOOT_RECOVERY',
    'CODEXIA_RUNTIME_MAINTENANCE_BACKUP_DIGEST','CODEXIA_RUNTIME_MAINTENANCE_IMAGE','CODEXIA_RUNTIME_MAINTENANCE_NONCE',
    'CODEXIA_RUNTIME_MAINTENANCE_TUNNEL_ROTATION','CODEXIA_RUNTIME_MAINTENANCE_PREFLIGHT_PASSWORD_ROTATION'];
  const managerEnvironment=run('systemctl',['--user','show-environment']).split('\n');
  const restore=Object.fromEntries(watchedEnvironment.map(name=>[name,managerEnvironment.find(line=>line.startsWith(name+'='))?.slice(name.length+1)??null]));
  const preload=path.join(repoRoot,'deploy/updater/test-standalone-maintenance-preload.mjs');
  run('systemctl',['--user','set-environment',`NODE_OPTIONS=--import=${preload}`,
    `XDG_STATE_HOME=${path.dirname(path.dirname(config.stateFile))}`,'CODEXIA_RUNTIME_ACCEPTANCE_DISPOSABLE=yes',
    'CODEXIA_RUNTIME_MAINTENANCE_BOOT_RECOVERY=yes',`CODEXIA_RUNTIME_MAINTENANCE_BACKUP_DIGEST=${BACKUP_DIGEST_FIXTURE}`,
    `CODEXIA_RUNTIME_MAINTENANCE_IMAGE=${expectedImage}`,`CODEXIA_RUNTIME_MAINTENANCE_NONCE=${nonce}`]);
  if(tunnelRotation)run('systemctl',['--user','set-environment','CODEXIA_RUNTIME_MAINTENANCE_TUNNEL_ROTATION=yes']);
  if(preflightRotation)run('systemctl',['--user','set-environment','CODEXIA_RUNTIME_MAINTENANCE_PREFLIGHT_PASSWORD_ROTATION=yes']);
  try{
    const unit='codexia-updater-boot.service';
    const previousInvocation=run('systemctl',['--user','show','--property=InvocationID','--value',unit]);
    run('systemctl',['--user','restart',unit],{timeout:240000});
    const currentInvocation=run('systemctl',['--user','show','--property=InvocationID','--value',unit]);
    assert.match(currentInvocation,/^[a-f0-9]{32}$/u,'Boot recovery invocation identity is unavailable');
    assert.notEqual(currentInvocation,previousInvocation,'Simulated boot did not start a fresh recovery invocation');
  }
  finally{await restoreBootManagerEnvironment(restore);}
}

async function runRotationCandidate({ repoRoot, candidate, configPath, environment, expectedStatus = 0, killAtSecretCreate = false }) {
  const wrapper = path.join(SOURCE_ROOT, 'deploy/updater/codexia-updater');
  const preload = path.join(repoRoot, 'deploy/updater/test-standalone-maintenance-preload.mjs');
  let env = {
    ...environment,
    CODEXIA_RUNTIME_MAINTENANCE_APP_PASSWORD_ROTATION: 'yes',
    CODEXIA_RUNTIME_MAINTENANCE_BACKUP_DIGEST: BACKUP_DIGEST_FIXTURE,
    NODE_OPTIONS: [environment.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(' '),
  };
  let observedFile;
  if (killAtSecretCreate) {
    const faultBin = path.join(candidate.root, 'fault-bin');
    await mkdir(faultBin, { mode: 0o700 });
    observedFile = path.join(candidate.root, 'secret-created-before-process-death');
    const podmanPath = execFileSync('which', ['podman'], { encoding: 'utf8' }).trim();
    const shim = [
      '#!/bin/sh',
      `"${podmanPath}" "$@"`,
      'status=$?',
      'if [ "$status" -ne 0 ]; then exit "$status"; fi',
      'if [ "$1" = secret ] && [ "$2" = create ]; then',
      '  for argument do',
      '    if [ "$argument" = codexia-postgres-app-password ]; then',
      `      printf '%s\\n' created > "${observedFile}"`,
      '      kill -KILL "$PPID"',
      '      break',
      '    fi',
      '  done',
      'fi',
      'exit "$status"',
    ].join('\n') + '\n';
    await writeFile(path.join(faultBin, 'podman'), shim, { mode: 0o700, flag: 'wx' });
    env = {
      ...env, PATH: faultBin + path.delimiter + env.PATH,
      CODEXIA_RUNTIME_MAINTENANCE_KILL_AT: 'after-new-secret-create',
    };
  }
  const child = spawnSync('sh', [wrapper, 'maintain', configPath, candidate.manifestPath], {
    encoding: 'utf8', timeout: 240000, maxBuffer: 4 * 1024 * 1024, env,
  });
  if (child.error) throw child.error;
  if (killAtSecretCreate) {
    assert.equal(child.signal, 'SIGKILL', `Rotation did not die after replacing the canonical secret: ${child.stdout}\n${child.stderr}`);
    assert.equal((await readFile(observedFile, 'utf8')).trim(), 'created');
  } else if (expectedStatus === 0 && child.status !== 0) {
    throw new Error(`PostgreSQL password rotation failed (${child.status}):\n${child.stdout}\n${child.stderr}`);
  } else if (expectedStatus !== 0) assert.notEqual(child.status, 0, 'Rotation unexpectedly succeeded');
  return child;
}

async function startStableRotationProxy({ repoRoot, config, proxyQuadlet, originalProxyText, expectedImage, nonce }) {
  const pinnedProxy = originalProxyText.match(/^Image=(ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64})$/mu)?.[1];
  assert.ok(pinnedProxy, 'Stable proxy fixture requires the original digest-pinned proxy image');
  const source = `[Unit]\nDescription=Disposable Codexia stable proxy for PostgreSQL rotation ${nonce}\n` +
    `[Container]\nImage=${pinnedProxy}\nContainerName=codexia-api-proxy\nNetwork=codexia.network\n` +
    `Volume=${path.join(repoRoot, 'deploy/updater/proxy.mjs')}:/config/proxy.mjs:ro,Z\n` +
    `Volume=${path.dirname(config.stateFile)}:/config/state:ro,Z\n` +
    `User=0\nEntrypoint=node\nExec=/config/proxy.mjs\nReadOnly=true\nNoNewPrivileges=true\nDropCapability=all\n` +
    `Tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m\nLabel=codexia.runtime-contract-test=${nonce}\n` +
    `PodmanArgs=--image-volume=ignore\n[Service]\nRestart=on-failure\nRestartSec=1\nTimeoutStartSec=30\n[Install]\nWantedBy=default.target\n`;
  await atomicWrite(proxyQuadlet, source);
  try {
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'restart', 'codexia-api-proxy.service']);
    await waitForUnit('codexia-api-proxy.service', 'active');
  } catch (error) {
    await atomicWrite(proxyQuadlet, originalProxyText);
    run('systemctl', ['--user', 'daemon-reload']);
    throw error;
  }
  return async () => {
    let stopError;
    try { await run('systemctl', ['--user', 'stop', 'codexia-api-proxy.service']); }
    catch (error) { stopError = error; }
    await atomicWrite(proxyQuadlet, originalProxyText);
    run('systemctl', ['--user', 'daemon-reload']);
    if (stopError) throw stopError;
  };
}

async function restoreBootManagerEnvironment(values) {
  for (const [name, value] of Object.entries(values)) {
    run('systemctl', ['--user', value === null ? 'unset-environment' : 'set-environment', ...(value === null ? [name] : [`${name}=${value}`])]);
  }
}

async function probeRemoteAppPassword(password, suffix) {
  const secretName = `codexia-rotation-auth-${suffix}`;
  const secretDirectory = await mkdtemp(path.join(os.tmpdir(), 'codexia-postgres-auth-probe-'));
  await chmod(secretDirectory, 0o700);
  const passwordFile = path.join(secretDirectory, 'password');
  let secretCreated = false;
  try {
    await writeFile(passwordFile, password, { mode: 0o600, flag: 'wx' });
    await chmod(passwordFile, 0o600);
    const fileInfo = await lstat(passwordFile);
    assert.ok(fileInfo.isFile() && !fileInfo.isSymbolicLink() && fileInfo.uid === UID && (fileInfo.mode & 0o777) === 0o600,
      'Isolated PostgreSQL authentication probe file is not private');
    const created = spawnSync('podman', ['secret', 'create', secretName, passwordFile], {
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(created.status, 0, `Could not stage isolated PostgreSQL authentication probe: ${created.stderr}`);
    secretCreated = true;
    return spawnSync('podman', ['run', '--rm', '--network', 'codexia-data', '--secret',
      `${secretName},type=mount,target=/run/secrets/probe-password`, '--entrypoint', 'sh', POSTGRES_IMAGE,
      '-ec', 'export PGPASSWORD="$(cat /run/secrets/probe-password)"; exec psql -X -w -qAt -h codexia-db -U codexia -d codexia -c "SELECT 1"'], {
      encoding: 'utf8', timeout: 30000,
    });
  } finally {
    try {
      if (secretCreated) run('podman', ['secret', 'rm', secretName]);
    } finally {
      await rm(secretDirectory, { recursive: true, force: true });
    }
  }
}

async function exercisePostgresPasswordRotation({ repoRoot, config, userUnitDir, workDir, nonce, expectedImage, originalProxyText, proxyQuadlet, environment }) {
  const restoreProxy = await startStableRotationProxy({ repoRoot, config, proxyQuadlet, originalProxyText, expectedImage, nonce });
  const markerPath = path.join(path.dirname(config.stateFile), 'maintenance', 'in-progress.json');
  const privateDir = path.dirname(config.publicKeyFile);
  let originalState = null;
  let candidate = null;
  let interruptedCandidate = null;
  try {
  originalState = await loadControllerState(config.stateFile);
  assert.ok(['committed', 'idle'].includes(originalState.journal.phase), 'Rotation fixture requires a committed controller');
  const pausedState = { ...originalState, paused: true };
  await atomicWrite(config.stateFile, JSON.stringify(pausedState) + '\n');
  const database = new PodmanStandaloneHost(config);
  const databaseIdentity = await database.passwordRotationDatabaseId();
  runAppPasswordQuery('CREATE TABLE IF NOT EXISTS public.runtime_rotation_probe(value text PRIMARY KEY);\n' +
    'INSERT INTO public.runtime_rotation_probe(value) VALUES (\'' + nonce + '\') ON CONFLICT DO NOTHING;\n');

  const publishedPassword = randomBytes(32).toString('hex');
  candidate = await createPasswordRotationCandidate({ stateDir: path.dirname(config.stateFile), config, userUnitDir, password: publishedPassword });
  const oldSecretId = JSON.parse(run('podman', ['secret', 'inspect', 'codexia-postgres-app-password']))[0].ID;
  await runRotationCandidate({ repoRoot, candidate, configPath: path.join(path.dirname(config.publicKeyFile), 'config.json'), stateDir: path.dirname(config.stateFile), environment });
  await assert.rejects(lstat(path.join(path.dirname(config.stateFile), 'maintenance', 'in-progress.json')), { code: 'ENOENT' }, 'Successful rotation retained its recovery marker');
  const newSecretId = JSON.parse(run('podman', ['secret', 'inspect', 'codexia-postgres-app-password']))[0].ID;
  assert.notEqual(newSecretId, oldSecretId, 'Immutable Podman secret ID did not change on rotation');
  assert.equal(await database.passwordRotationDatabaseId(), databaseIdentity, 'Successful rotation replaced the PostgreSQL identity');
  assert.equal(await database.verifyPostgresAppPassword(publishedPassword), undefined);
  assert.equal(runAppPasswordQuery('SELECT value FROM public.runtime_rotation_probe;'), nonce, 'Application data changed during rotation');
  const publishedAuth = await probeRemoteAppPassword(publishedPassword, randomUUID());
  assert.equal(publishedAuth.status, 0, `New PostgreSQL app password did not authenticate: ${publishedAuth.stderr}`);
  assert.equal(publishedAuth.stdout.trim(), '1', 'New PostgreSQL app password did not return the authenticated probe result');
  const oldAuth = await probeRemoteAppPassword(await readFile(path.join(workDir, 'postgres-app-password.initial'), 'utf8'), randomUUID());
  assert.notEqual(oldAuth.status, 0, 'Old PostgreSQL app password still authenticated after rotation');
  assert.match(`${oldAuth.stdout ?? ''}${oldAuth.stderr ?? ''}`, /password authentication failed/iu, 'Stale password rejection did not come from PostgreSQL authentication');
  assert.equal((await readFile(config.routeFile, 'utf8')).trim(), 'blue');
  assert.equal(systemdState('codexia-slot-blue.service'), 'active');
  assert.equal(systemdState('codexia-db.service'), 'active');
  assert.equal((await loadControllerState(config.stateFile)).paused, true, 'Rotation changed the paused journal state');
  await assertTimerState('active', 'enabled');

  const currentSecretId = newSecretId;
  const interruptedPassword = randomBytes(32).toString('hex');
  interruptedCandidate = await createPasswordRotationCandidate({ stateDir: path.dirname(config.stateFile), config, userUnitDir, password: interruptedPassword });
  const interruption = await runRotationCandidate({ repoRoot, candidate: interruptedCandidate, configPath: path.join(path.dirname(config.publicKeyFile), 'config.json'), stateDir: path.dirname(config.stateFile), environment, killAtSecretCreate: true });
  assert.equal(interruption.signal, 'SIGKILL');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.equal(marker.format, 'codexia-maintenance-postgres-app-password/v1');
  assert.equal((await readFile(config.routeFile, 'utf8')).trim(), 'blocked');
  assert.equal((await loadControllerState(config.stateFile)).paused, true);
  assert.ok(['inactive', 'failed'].includes(systemdState('codexia-slot-blue.service')));
  assert.ok(['inactive', 'failed'].includes(systemdState('codexia-db.service')));
  await assertTimerState('inactive', 'enabled');

  const watchedEnvironment = ['NODE_OPTIONS', 'XDG_STATE_HOME', 'CODEXIA_RUNTIME_ACCEPTANCE_DISPOSABLE', 'CODEXIA_RUNTIME_MAINTENANCE_BOOT_RECOVERY',
    'CODEXIA_RUNTIME_MAINTENANCE_BACKUP_DIGEST', 'CODEXIA_RUNTIME_MAINTENANCE_IMAGE', 'CODEXIA_RUNTIME_MAINTENANCE_NONCE'];
  const managerEnv = run('systemctl', ['--user', 'show-environment']).split('\n');
  const restore = Object.fromEntries(watchedEnvironment.map(name => [name, managerEnv.find(line => line.startsWith(name + '='))?.slice(name.length + 1) ?? null]));
  const preload = path.join(repoRoot, 'deploy/updater/test-standalone-maintenance-preload.mjs');
  run('systemctl', ['--user', 'set-environment',
    `NODE_OPTIONS=--import=${preload}`, `XDG_STATE_HOME=${path.dirname(path.dirname(config.stateFile))}`,
    'CODEXIA_RUNTIME_ACCEPTANCE_DISPOSABLE=yes',
    'CODEXIA_RUNTIME_MAINTENANCE_BOOT_RECOVERY=yes',
    `CODEXIA_RUNTIME_MAINTENANCE_BACKUP_DIGEST=${BACKUP_DIGEST_FIXTURE}`,
    `CODEXIA_RUNTIME_MAINTENANCE_IMAGE=${expectedImage}`, `CODEXIA_RUNTIME_MAINTENANCE_NONCE=${nonce}`]);
  try {
    run('systemctl', ['--user', 'start', 'codexia-updater-boot.service'], { timeout: 240000 });
  } finally {
    await restoreBootManagerEnvironment(restore);
  }
  await assert.rejects(lstat(markerPath), { code: 'ENOENT' }, 'Boot recovery retained the password marker');
  assert.equal((await readFile(config.routeFile, 'utf8')).trim(), 'blue', 'Boot recovery did not restore ingress');
  assert.equal(await database.passwordRotationDatabaseId(), databaseIdentity, 'Boot recovery changed the physical database identity');
  assert.equal(await database.verifyPostgresAppPassword(publishedPassword), undefined, 'Boot recovery did not restore the previous SQL role credential');
  assert.equal(runAppPasswordQuery('SELECT value FROM public.runtime_rotation_probe;'), nonce, 'Boot recovery changed persistent application data');
  const recoveredAuth = await probeRemoteAppPassword(publishedPassword, randomUUID());
  assert.equal(recoveredAuth.status, 0, `Recovered PostgreSQL app password did not authenticate: ${recoveredAuth.stderr}`);
  const failedNewAuth = await probeRemoteAppPassword(interruptedPassword, randomUUID());
  assert.notEqual(failedNewAuth.status, 0, 'Interrupted PostgreSQL app password authenticated after rollback');
  assert.match(`${failedNewAuth.stdout ?? ''}${failedNewAuth.stderr ?? ''}`, /password authentication failed/iu, 'Interrupted password was rejected for a reason other than PostgreSQL authentication');
  const recoveredSecretId = JSON.parse(run('podman', ['secret', 'inspect', 'codexia-postgres-app-password']))[0].ID;
  assert.notEqual(recoveredSecretId, currentSecretId, 'Boot recovery did not recreate the immutable prior Podman secret');
  assert.equal(systemdState('codexia-db.service'), 'active');
  assert.equal(systemdState('codexia-slot-blue.service'), 'active');
  assert.equal((await loadControllerState(config.stateFile)).paused, true, 'Boot recovery changed the paused journal state');
  await assertTimerState('active', 'enabled');
  const proxied = JSON.parse(run('podman', ['exec', 'codexia-api-proxy', 'node', '--input-type=module', '-e',
    'const r=await fetch("http://127.0.0.1:3000/api/version",{signal:AbortSignal.timeout(3000)});if(!r.ok)process.exit(1);process.stdout.write(JSON.stringify({slot:r.headers.get("x-codexia-upstream-slot"),version:await r.json()}));']));
  assert.equal(proxied.slot, 'blue', 'Proxy did not route to the recovered writer');
  assert.equal(proxied.version.name, 'codexia');

  } finally {
    let restoreError;
    try { await restoreProxy(); } catch (error) { restoreError = error; }
    const recoveryPending = await lstat(markerPath).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error));
    if (originalState && !recoveryPending) {
      await atomicWrite(config.stateFile, JSON.stringify(originalState) + '\n');
    }
    for (const root of [candidate?.root, interruptedCandidate?.root]) {
      if (root) await rm(root, { recursive: true, force: true });
    }
    for (const artifact of [candidate?.artifactDirectory, interruptedCandidate?.artifactDirectory]) {
      if (artifact) await rm(artifact, { recursive: true, force: true });
    }
    await rm(path.join(path.dirname(config.stateFile), 'controller-backup-proof.json'), { force: true });
    await rm(path.join(privateDir, 'maintenance'), { recursive: true, force: true });
    if (recoveryPending) {
      process.stderr.write(`Preserving PostgreSQL rollback snapshot while recovery marker remains: ${markerPath}\n`);
    } else {
      await rm(path.join(privateDir, 'maintenance-snapshots'), { recursive: true, force: true });
    }
    assert.equal(await readFile(proxyQuadlet, 'utf8'), originalProxyText, 'Proxy fixture did not restore the production Quadlet text');
    if (restoreError) throw restoreError;
  }
}

async function exercisePreflightPasswordRotation({repoRoot,config,userUnitDir,workDir,expectedImage,originalProxyText,proxyQuadlet,environment,nonce}){
  const restoreProxy=await startStableRotationProxy({repoRoot,config,proxyQuadlet,originalProxyText,expectedImage,nonce});
  const stateDir=path.dirname(config.stateFile);
  const markerPath=path.join(stateDir,'maintenance','in-progress.json');
  let candidate;
  let interrupted;
  let interruptedBeforeSecret;
  try{
    const database=new PodmanStandaloneHost(config);
    const state=await loadControllerState(config.stateFile);
    const databaseIdentity=await database.passwordRotationDatabaseId();
    const databaseContainerId=()=>JSON.parse(run('podman',['inspect','--type','container','codexia-db']))[0].Id;
    const initialDatabaseContainerId=databaseContainerId();
    const appPassword=JSON.parse(run('podman',['secret','inspect','--showsecret','codexia-postgres-app-password']))[0].SecretData;
    const oldPassword=JSON.parse(run('podman',['secret','inspect','--showsecret','codexia-postgres-preflight-password']))[0].SecretData;
    const oldSecretId=JSON.parse(run('podman',['secret','inspect','codexia-postgres-preflight-password']))[0].ID;
    assert.match(oldPassword,/^[a-f0-9]{64}$/u,'Invalid fixture preflight password');
    runAppPasswordQuery('CREATE TABLE public.runtime_preflight_rotation_probe(value text PRIMARY KEY);\n' +
      'INSERT INTO public.runtime_preflight_rotation_probe(value) VALUES (\''+nonce+'\');\n');
    const provision=await readFile(path.join(repoRoot,'deploy/updater/provision-preflight-role.sql'),'utf8');
    runWithSensitiveInput('podman',['exec','-i','codexia-db','sh','-ec',
      'export PGPASSWORD="$(cat /run/secrets/admin-password)"; exec psql -X -w -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U codexia_admin -d codexia'],
      '\\set preflight_password '+oldPassword+'\n'+provision);
    await database.verifyPostgresPreflightPassword(oldPassword);
    const rejectPreflightPassword=password=>assert.rejects(database.verifyPostgresPreflightPassword(password,{secretRequired:false}),
      /password authentication failed/iu);
    const replacement=randomBytes(32).toString('hex');
    candidate=await createPreflightPasswordRotationCandidate({stateDir,config,userUnitDir,password:replacement});
    await runPreflightPasswordRotationCandidate({repoRoot,candidate,configPath:candidate.manifest.configPath,environment});
    await assert.rejects(lstat(markerPath),{code:'ENOENT'},'Successful preflight rotation retained its recovery marker');
    const rotatedSecret=JSON.parse(run('podman',['secret','inspect','--showsecret','codexia-postgres-preflight-password']))[0];
    assert.notEqual(rotatedSecret.ID,oldSecretId,'Immutable preflight Podman secret did not change');
    assert.equal(rotatedSecret.SecretData,replacement);
    await database.verifyPostgresPreflightPassword(replacement);
    await database.verifyPostgresAppPassword(appPassword);
    await rejectPreflightPassword(oldPassword);
    assert.equal(await database.passwordRotationDatabaseId(),databaseIdentity,'Preflight rotation changed the database identity');
    assert.equal(databaseContainerId(),initialDatabaseContainerId,'Preflight rotation restarted PostgreSQL');
    assert.deepEqual(await loadControllerState(config.stateFile),state,'Preflight rotation changed the controller state');
    assert.equal((await readFile(config.routeFile,'utf8')),'blue\n','Preflight rotation changed the committed route');
    assert.equal(systemdState('codexia-slot-blue.service'),'active');
    assert.equal(systemdState('codexia-db.service'),'active');
    await assertTimerState('active','enabled');

    const interruptedPassword=randomBytes(32).toString('hex');
    interrupted=await createPreflightPasswordRotationCandidate({stateDir,config,userUnitDir,password:interruptedPassword});
    await runPreflightPasswordRotationCandidate({repoRoot,candidate:interrupted,configPath:interrupted.manifest.configPath,environment,killAfterSql:true});
    const marker=JSON.parse(await readFile(markerPath,'utf8'));
    assert.equal(marker.format,'codexia-maintenance-postgres-preflight-password/v1');
    assert.equal(marker.phase,'applying');
    assert.equal((await readFile(config.routeFile,'utf8')),'blocked\n','Preflight SQL interruption did not keep the route fenced');
    await database.verifyPostgresPreflightPassword(interruptedPassword,{secretRequired:false});
    await rejectPreflightPassword(replacement);
    assert.equal((await loadControllerState(config.stateFile)).paused,state.paused,'Preflight interruption changed pause state');
    assert.ok(['inactive','failed'].includes(systemdState('codexia-slot-blue.service')));
    assert.equal(systemdState('codexia-db.service'),'active','SQL-only interruption stopped the database before secret replacement');
    await assertTimerState('inactive','enabled');

    await recoverMaintenanceAtBoot({repoRoot,config,expectedImage,nonce,preflightRotation:true});
    await assert.rejects(lstat(markerPath),{code:'ENOENT'},'Boot recovery retained the preflight password marker');
    assert.equal((await readFile(config.routeFile,'utf8')),'blue\n','Boot recovery did not restore the committed route');
    assert.equal(await database.passwordRotationDatabaseId(),databaseIdentity,'Boot recovery changed the database identity');
    await database.verifyPostgresPreflightPassword(replacement);
    await database.verifyPostgresAppPassword(appPassword);
    await rejectPreflightPassword(interruptedPassword);
    const recoveredSecret=JSON.parse(run('podman',['secret','inspect','--showsecret','codexia-postgres-preflight-password']))[0];
    assert.equal(recoveredSecret.ID,rotatedSecret.ID,'SQL-only recovery replaced the original immutable preflight secret');
    assert.equal(recoveredSecret.SecretData,replacement,'Boot recovery restored a different prior preflight secret');
    assert.deepEqual(await loadControllerState(config.stateFile),state,'Boot recovery changed the controller state');
    assert.equal(systemdState('codexia-slot-blue.service'),'active');
    assert.equal(systemdState('codexia-db.service'),'active');
    await assertTimerState('active','enabled');

    const interruptedAfterSecret=randomBytes(32).toString('hex');
    interruptedBeforeSecret=interrupted;
    const afterSecretCandidate=await createPreflightPasswordRotationCandidate({stateDir,config,userUnitDir,password:interruptedAfterSecret});
    interrupted=afterSecretCandidate;
    await runPreflightPasswordRotationCandidate({repoRoot,candidate:afterSecretCandidate,
      configPath:afterSecretCandidate.manifest.configPath,environment,killAfterSecret:true});
    const afterSecretMarker=JSON.parse(await readFile(markerPath,'utf8'));
    assert.equal(afterSecretMarker.phase,'applying');
    assert.equal((await readFile(config.routeFile,'utf8')),'blocked\n','Secret-replacement interruption did not keep the route fenced');
    assert.ok(['inactive','failed'].includes(systemdState('codexia-slot-blue.service')));
    assert.equal(systemdState('codexia-db.service'),'active','Secret replacement stopped PostgreSQL');
    const interruptedSecret=JSON.parse(run('podman',['secret','inspect','--showsecret','codexia-postgres-preflight-password']))[0];
    assert.equal(interruptedSecret.SecretData,interruptedAfterSecret,'Secret-replacement interruption did not persist the new secret object');
    await assertTimerState('inactive','enabled');
    await recoverMaintenanceAtBoot({repoRoot,config,expectedImage,nonce,preflightRotation:true});
    await assert.rejects(lstat(markerPath),{code:'ENOENT'},'Recovery after secret replacement retained its marker');
    assert.equal((await readFile(config.routeFile,'utf8')),'blue\n');
    assert.equal(await database.passwordRotationDatabaseId(),databaseIdentity,'Recovery after secret replacement changed database identity');
    await database.verifyPostgresPreflightPassword(replacement);
    await rejectPreflightPassword(interruptedAfterSecret);
    const afterSecretRecovered=JSON.parse(run('podman',['secret','inspect','--showsecret','codexia-postgres-preflight-password']))[0];
    assert.notEqual(afterSecretRecovered.ID,interruptedSecret.ID,'Recovery after secret replacement did not recreate the prior secret');
    assert.equal(afterSecretRecovered.SecretData,replacement);
    assert.equal(databaseContainerId(),initialDatabaseContainerId,'Interrupted preflight rotation restarted PostgreSQL');
    assert.equal(runAppPasswordQuery('SELECT value FROM public.runtime_preflight_rotation_probe;'),nonce,
      'Application data changed during preflight rotation or recovery');
    assert.equal(systemdState('codexia-slot-blue.service'),'active');
    assert.equal(systemdState('codexia-db.service'),'active');
    await assertTimerState('active','enabled');
  }finally{
    let restoreError;
    try{await restoreProxy();}catch(error){restoreError=error;}
    const recoveryPending=await lstat(markerPath).then(()=>true,error=>error.code==='ENOENT'?false:Promise.reject(error));
    for(const entry of [candidate,interruptedBeforeSecret,interrupted]){
      if(entry?.root)await rm(entry.root,{recursive:true,force:true});
      if(entry?.artifactDirectory)await rm(entry.artifactDirectory,{recursive:true,force:true});
    }
    await rm(path.join(stateDir,'controller-backup-proof.json'),{force:true});
    if(recoveryPending)process.stderr.write(`Preserving PostgreSQL preflight rollback snapshot while marker remains: ${markerPath}\n`);
    else await rm(path.join(path.dirname(config.publicKeyFile),'maintenance-snapshots'),{recursive:true,force:true});
    if(restoreError)throw restoreError;
  }
}

async function exerciseApiAuthTokenRotation({repoRoot,config,workDir,expectedImage,environment,originalProxyText,proxyQuadlet,nonce}){
  const stateBeforePause=await loadControllerState(config.stateFile);
  const restoreProxy=await startStableRotationProxy({repoRoot,config,proxyQuadlet,originalProxyText,expectedImage,nonce});
  try{
  const configPath=path.join(path.dirname(config.publicKeyFile),'config.json');
  if(!stateBeforePause.paused){
    run('sh',[path.join(SOURCE_ROOT,'deploy/updater/codexia-updater'),'pause',configPath],{env:environment});
  }
  const state=await loadControllerState(config.stateFile);
  assert.equal(state.paused,true,'API token rotation fixture requires a paused controller');
  const initialSecret=readPodmanApiAuthTokenSecret();
  const previousToken=initialSecret.SecretData;
  const initialSecretId=initialSecret.ID;
  const host=new PodmanStandaloneHost(config);
  await host.verifyApiAuthToken(state.journal.active.slot,previousToken,200);
  assert.equal(await proxyApiTokenStatus(previousToken),'200','Stable fixture proxy did not authenticate the original API token');
  const replacementToken=randomBytes(32).toString('hex');
  const candidate=await createApiAuthTokenCandidate({config,token:replacementToken});
  try{
    await runApiAuthTokenRotationCandidate({repoRoot,candidate,configPath:path.join(path.dirname(config.publicKeyFile),'config.json'),environment});
    await assert.rejects(lstat(path.join(path.dirname(config.stateFile),'maintenance','in-progress.json')),{code:'ENOENT'},'Successful API token rotation retained a recovery marker');
    const rotatedSecret=readPodmanApiAuthTokenSecret();
    assert.notEqual(rotatedSecret.ID,initialSecretId,'Immutable API token secret ID did not change');
    await host.verifyApiAuthToken(state.journal.active.slot,replacementToken,200);
    await host.verifyApiAuthToken(state.journal.active.slot,previousToken,401);
    assert.equal(await proxyApiTokenStatus(replacementToken),'200');
    assert.equal(await proxyApiTokenStatus(previousToken),'401');
    assert.equal((await readFile(config.routeFile,'utf8')).trim(),state.journal.active.slot);
    assert.equal((await loadControllerState(config.stateFile)).paused,true,'API token rotation changed pause state');
    await assertTimerState('active','enabled');

    const interruptedToken=randomBytes(32).toString('hex');
    const interrupted=await createApiAuthTokenCandidate({config,token:interruptedToken});
    try{
      await runApiAuthTokenRotationCandidate({repoRoot,candidate:interrupted,configPath:path.join(path.dirname(config.publicKeyFile),'config.json'),environment,killAtSecretCreate:true});
      const marker=JSON.parse(await readFile(path.join(path.dirname(config.stateFile),'maintenance','in-progress.json'),'utf8'));
      assert.equal(marker.format,'codexia-maintenance-api-auth-token/v1');
      assert.equal(marker.phase,'applying');
      assert.equal((await readFile(config.routeFile,'utf8')).trim(),'blocked');
      assert.ok(['inactive','failed'].includes(systemdState(`codexia-slot-${state.journal.active.slot}.service`)));
      await assertTimerState('inactive','enabled');

      await recoverMaintenanceAtBoot({repoRoot,config,expectedImage,nonce:process.env.CODEXIA_RUNTIME_MAINTENANCE_NONCE});
      await assert.rejects(lstat(path.join(path.dirname(config.stateFile),'maintenance','in-progress.json')),{code:'ENOENT'},'Boot recovery retained the API token marker');
      assert.equal((await readFile(config.routeFile,'utf8')).trim(),state.journal.active.slot);
      await host.verifyApiAuthToken(state.journal.active.slot,replacementToken,200);
      await host.verifyApiAuthToken(state.journal.active.slot,interruptedToken,401);
      assert.equal(await proxyApiTokenStatus(replacementToken),'200');
      assert.equal(await proxyApiTokenStatus(interruptedToken),'401');
      assert.equal((await loadControllerState(config.stateFile)).paused,true,'API token recovery changed pause state');
      await assertTimerState('active','enabled');
    }finally{await rm(interrupted.candidateRoot,{recursive:true,force:true});}

    const completedToken=randomBytes(32).toString('hex');
    const completed=await createApiAuthTokenCandidate({config,token:completedToken});
    try{
      await runApiAuthTokenRotationCandidate({repoRoot,candidate:completed,configPath:path.join(path.dirname(config.publicKeyFile),'config.json'),environment,killAtCompletedMarker:true});
      const completedMarker=JSON.parse(await readFile(path.join(path.dirname(config.stateFile),'maintenance','in-progress.json'),'utf8'));
      assert.equal(completedMarker.phase,'completed');
      assert.equal((await readFile(config.routeFile,'utf8')).trim(),state.journal.active.slot);
      await assertTimerState('active','enabled');
      await recoverMaintenanceAtBoot({repoRoot,config,expectedImage,nonce:process.env.CODEXIA_RUNTIME_MAINTENANCE_NONCE});
      await assert.rejects(lstat(path.join(path.dirname(config.stateFile),'maintenance','in-progress.json')),{code:'ENOENT'},'Committed boot recovery retained the API token marker');
      await host.verifyApiAuthToken(state.journal.active.slot,completedToken,200);
      await host.verifyApiAuthToken(state.journal.active.slot,replacementToken,401);
      assert.equal(await proxyApiTokenStatus(completedToken),'200');
      assert.equal(await proxyApiTokenStatus(replacementToken),'401');
      await assertTimerState('active','enabled');
    }finally{await rm(completed.candidateRoot,{recursive:true,force:true});}
  }finally{await rm(candidate.candidateRoot,{recursive:true,force:true});}
  }finally{
    const recoveryPending=await lstat(path.join(path.dirname(config.stateFile),'maintenance','in-progress.json'))
      .then(()=>true,error=>error.code==='ENOENT'?false:Promise.reject(error));
    if(!recoveryPending){
      await atomicWrite(config.stateFile,JSON.stringify(stateBeforePause)+'\n');
      const privateDir=path.dirname(config.publicKeyFile);
      for(const directory of [path.join(privateDir,'maintenance','candidates'),path.join(privateDir,'maintenance'),path.join(privateDir,'maintenance-snapshots')]){
        try{await rmdir(directory);}catch(error){if(error.code!=='ENOENT')throw error;}
      }
    }
    await restoreProxy();
  }
}

async function exerciseTunnelTokenRotation({repoRoot,config,userUnitDir,workDir,expectedImage,environment,nonce,originalProxyText,proxyQuadlet}){
  const restoreProxy=await startStableRotationProxy({repoRoot,config,proxyQuadlet,originalProxyText,expectedImage,nonce});
  const markerPath=path.join(path.dirname(config.stateFile),'maintenance','in-progress.json');
  const tunnelUnitFile=path.join(userUnitDir,'codexia-tunnel.service');
  const oldToken='fixture-tunnel-token-old-'+randomBytes(12).toString('hex');
  const newToken='fixture-tunnel-token-new-'+randomBytes(12).toString('hex');
  const interruptedToken='fixture-tunnel-token-interrupted-'+randomBytes(12).toString('hex');
  const secretInput=path.join(workDir,'synthetic-tunnel-token-input');
  let created=false;
  let unitCreated=false;
  const readSecret=()=>JSON.parse(run('podman',['secret','inspect','--showsecret','codexia-tunnel-token']))[0];
  try{
    const exists=spawnSync('podman',['secret','exists','codexia-tunnel-token'],{stdio:'ignore'});
    assert.notEqual(exists.status,0,'Tunnel-token integration fixture requires an unused canonical secret name');
    await writeFile(secretInput,oldToken,{mode:0o600,flag:'wx'});
    run('podman',['secret','create','codexia-tunnel-token',secretInput]);
    created=true;
    await rm(secretInput,{force:true});
    await writeFile(tunnelUnitFile,'[Unit]\nDescription=Disposable synthetic Tunnel service\n[Service]\nType=simple\nExecStart=/usr/bin/sleep infinity\nRestart=no\n',{mode:0o600,flag:'wx'});
    unitCreated=true;
    run('systemctl',['--user','daemon-reload']);
    run('systemctl',['--user','start','codexia-tunnel.service']);
    const stateBefore=await loadControllerState(config.stateFile);
    const initialSecretId=readSecret().ID;
    const candidate=await createTunnelTokenCandidate({config,userUnitDir,token:newToken});
    try{
      await runTunnelTokenRotationCandidate({repoRoot,candidate,configPath:path.join(path.dirname(config.publicKeyFile),'config.json'),environment});
      await assert.rejects(lstat(markerPath),{code:'ENOENT'},'Successful Tunnel token rotation retained its marker');
      const rotated=readSecret();
      assert.notEqual(rotated.ID,initialSecretId,'Tunnel Podman secret ID did not change');
      assert.equal(rotated.SecretData,newToken,'Tunnel secret did not receive the protected replacement');
      assert.equal(systemdState('codexia-tunnel.service'),'active','Tunnel service did not return to its prior active state');
      assert.equal((await loadControllerState(config.stateFile)).paused,stateBefore.paused,'Tunnel token rotation changed pause state');
      assert.equal((await readFile(config.routeFile,'utf8')).trim(),stateBefore.journal.active.slot,'Tunnel token rotation changed the API route');
      await assertTimerState('active','enabled');
      await new PodmanStandaloneHost(config).probe(stateBefore.journal.active.slot,stateBefore.installed);

      const interrupted=await createTunnelTokenCandidate({config,userUnitDir,token:interruptedToken});
      try{
        await runTunnelTokenRotationCandidate({repoRoot,candidate:interrupted,configPath:path.join(path.dirname(config.publicKeyFile),'config.json'),
          environment,killAtSecretCreate:true});
        const pending=JSON.parse(await readFile(markerPath,'utf8'));
        assert.equal(pending.format,'codexia-maintenance-tunnel-token/v1');
        assert.equal(readSecret().SecretData,interruptedToken,'Fault injection missed the post-secret boundary');
        assert.equal(systemdState('codexia-tunnel.service'),'inactive','Interrupted Tunnel remained active after its secret changed');
        run('systemctl',['--user','start','codexia-tunnel.service']);
        assert.equal(systemdState('codexia-tunnel.service'),'inactive','Rotation startup fence admitted Tunnel before boot recovery');
        await assertTimerState('inactive','enabled');
        await recoverMaintenanceAtBoot({repoRoot,config,expectedImage,nonce,tunnelRotation:true});
        await assert.rejects(lstat(markerPath),{code:'ENOENT'},'Tunnel boot recovery retained its marker');
        assert.equal(readSecret().SecretData,newToken,'Boot recovery did not restore the prior Tunnel token');
        assert.equal(systemdState('codexia-tunnel.service'),'active','Boot recovery did not restore the Tunnel service');
        assert.equal((await readFile(config.routeFile,'utf8')).trim(),stateBefore.journal.active.slot,'Boot recovery changed the API route');
        assert.equal((await loadControllerState(config.stateFile)).paused,stateBefore.paused,'Tunnel boot recovery changed pause state');
        await assertTimerState('active','enabled');
        await new PodmanStandaloneHost(config).probe(stateBefore.journal.active.slot,stateBefore.installed);
      }finally{await rm(interrupted.candidateRoot,{recursive:true,force:true});}
    }finally{await rm(candidate.candidateRoot,{recursive:true,force:true});}
  }finally{
    const pending=await lstat(markerPath).then(()=>true,error=>error.code==='ENOENT'?false:Promise.reject(error));
    if(created&&!pending){
      const secret=readSecret();
      run('podman',['secret','rm',secret.ID]);
    }
    await rm(secretInput,{force:true});
    if(unitCreated&&!pending){
      if(systemdState('codexia-tunnel.service')==='active')run('systemctl',['--user','stop','codexia-tunnel.service']);
      await rm(tunnelUnitFile,{force:true});
      run('systemctl',['--user','daemon-reload']);
    }
    if(!pending){
      const privateDir=path.dirname(config.publicKeyFile);
      for(const directory of [path.join(privateDir,'maintenance','candidates'),path.join(privateDir,'maintenance'),path.join(privateDir,'maintenance-snapshots')]){
        try{await rmdir(directory);}catch(error){if(error.code!=='ENOENT')throw error;}
      }
    }
    await restoreProxy();
  }
}

async function main() {
  assert.notEqual(UID, 0, 'Must run as a non-root disposable service user');
  assert.notEqual(os.userInfo().username, 'codexia', 'Refusing the production Codexia service identity');
  assert.equal(process.env.CODEXIA_RUNTIME_ACCEPTANCE_DISPOSABLE, 'yes', 'Disposable runtime acceptance guard is absent');
  const marker = '/etc/codexia-iac-disposable-vm';
  const markerInfo = await lstat(marker);
  assert.ok(markerInfo.isFile() && !markerInfo.isSymbolicLink());
  assert.equal(markerInfo.uid, 0);
  assert.equal((await readFile(marker, 'utf8')).trim(), 'codexia-iac-disposable-vm/v1');
  const [, , , repoRootArg, quadletDirArg, userUnitDirArg, workDirArg] = process.argv;
  const repoRoot = path.resolve(repoRootArg);
  const quadletDir = path.resolve(quadletDirArg);
  const userUnitDir = path.resolve(userUnitDirArg);
  const workDir = path.resolve(workDirArg);
  const home = process.env.HOME;
  assert.ok(path.isAbsolute(home) && home !== '/home/codexia');
  assert.equal(process.env.XDG_CONFIG_HOME, path.join(home, '.config'));
  assert.equal(process.env.CODEXIA_RUNTIME_MAINTENANCE_REPO_ROOT, repoRoot);
  const stateBase = path.join(workDir, 'maintenance-state');
  const stateDir = path.join(stateBase, 'codexia-updater');
  const privateDir = path.join(home, '.config', 'codexia-updater');
  const configPath = path.join(privateDir, 'config.json');
  const routeFile = path.join(stateDir, 'route');
  const publicKeyFile = path.join(privateDir, 'channel-public.pem');
  const githubTokenFile = path.join(privateDir, 'github-read-token');
  const proxyQuadlet = path.join(quadletDir, 'codexia-api-proxy.container');
  const oldRuntime = validateRuntimeContract({
    format: 'codexia-runtime/v1', profile: 'core', modelCachePath: null,
    tmpfs: { tempSize: '64m', moduleCacheSize: '128m' },
    resources: { memoryMaxBytes: 2 * 1024 ** 3, cpuQuotaPercent: 100 },
  });
  const newRuntime = validateRuntimeContract({ ...oldRuntime, resources: { ...oldRuntime.resources, cpuQuotaPercent: FAILURE_CPU } });
  const config = fixtureConfig({ home, stateDir, quadletDir, runtime: oldRuntime });
  const release = {
    format: 'codexia-update-release/v1', channel: 'stable', state: 'published', version: '0.1.0',
    sourceSha: 'a'.repeat(40), image: 'ghcr.io/yohn-jp/codexia-backend@sha256:' + 'a'.repeat(64),
    platform: 'linux/amd64', profile: 'core', migrationFingerprint: 'sha256:' + 'c'.repeat(64),
    persistenceFormat: 1, apiEpoch: 1,
  };
  const initialState = { ...initialControllerState(release, 'blue', null), paused: false };
  // The running rotation proxy needs a real RepoDigest for exact runtime
  // attestation. This is the immutable core image from certified release
  // backend-v0.1.342; the synthetic d…d placeholder below cannot be pulled.
  const proxyDigest = 'ghcr.io/yohn-jp/codexia-backend@sha256:c426ce5958440536f9a65f2f08161bdc709e4c8b8264680844f7a3080280f92f';
  const nonce = process.env.CODEXIA_RUNTIME_MAINTENANCE_NONCE;
  assert.match(nonce ?? '', /^[a-f0-9]{32}$/u, 'Synthetic maintenance ownership nonce is missing');
  const proxyText = `[Container]\nImage=${proxyDigest}\nContainerName=codexia-api-proxy\nNetwork=codexia.network\nLabel=codexia-runtime-contract-test=${nonce}\n`;
  const originalServiceUnit = await readFile(path.join(repoRoot, 'deploy/updater/codexia-updater.service.example'), 'utf8');
  const baselineServiceUnit = originalServiceUnit.replace('Description=Poll signed Codexia channel and perform exclusive update', `Description=Prior synthetic updater service ${nonce}`);
  const configBefore = JSON.stringify(config, null, 2) + '\n';
  const initialStateJson = JSON.stringify(initialState) + '\n';
  await writeFixtureSource(repoRoot);
  await writeOldVerifierShim(repoRoot);
  await assert.rejects(lstat(privateDir), { code: 'ENOENT' }, 'Refusing an existing private updater config directory');
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(configPath, configBefore, { mode: 0o600, flag: 'wx' });
  await writeFile(publicKeyFile, 'synthetic test public key\n', { mode: 0o600, flag: 'wx' });
  await writeFile(githubTokenFile, 'synthetic-no-network-token\n', { mode: 0o600, flag: 'wx' });
  await writeFile(routeFile, 'blue\n', { mode: 0o600, flag: 'wx' });
  await atomicWrite(path.join(stateDir, 'controller.json'), initialStateJson);
  assert.equal(await readFile(routeFile, 'utf8'), 'blue\n');

  const expectedImage = process.env.CODEXIA_RUNTIME_MAINTENANCE_IMAGE;
  assert.match(expectedImage ?? '', /^sha256:[a-f0-9]{64}$/u);
  const blueRuntimeFile = JSON.parse(await readFile(path.join(workDir, 'codexia-runtime-blue.json'), 'utf8'));
  assert.deepEqual(blueRuntimeFile, oldRuntime, 'Blue slot fixture runtime changed unexpectedly');
  const greenUnitPath = path.join(quadletDir, 'codexia-slot-green.container');
  const greenOld = await readFile(greenUnitPath, 'utf8');
  assert.equal(greenOld.match(/^ContainerName=(\S+)$/mu)?.[1], 'codexia-slot-green');
  await atomicWrite(greenUnitPath, imageConfig({ image: expectedImage, profile: 'core' }, { CODEXIA_BROWSER_AUTH: 'token' }, oldRuntime).replace('PLACEHOLDER', 'codexia-slot-green'));
  await writeFile(proxyQuadlet, proxyText, { mode: 0o600, flag: 'wx' });

  for (const unit of MAINTENANCE_UNIT_FILES) {
    const destination = path.join(userUnitDir, unit);
    await writeFile(destination, await readFile(path.join(repoRoot, 'deploy/updater', `${unit}.example`)), { mode: 0o600, flag: 'wx' });
    await chmod(destination, 0o600);
  }
  await writeFile(path.join(userUnitDir, 'codexia-updater.service'), baselineServiceUnit, { mode: 0o600 });
  // Use a disposable timer whose first firing is beyond this job's lifetime.
  const timerPath = path.join(userUnitDir, 'codexia-updater.timer');
  let timerText = await readFile(timerPath, 'utf8');
  timerText = timerText.replace('OnBootSec=5min', 'OnBootSec=24h').replace('OnUnitInactiveSec=5min', 'OnUnitInactiveSec=24h');
  await writeFile(timerPath, timerText, { mode: 0o600 });
  assert.equal(await readFile(path.join(userUnitDir, 'codexia-updater.service'), 'utf8'), baselineServiceUnit);

  const candidate = await createCandidate({
    repoRoot, stateDir, configPath, sourceDir: SOURCE_ROOT, unitDir: userUnitDir,
    quadletDir, candidateConfig: { ...config, runtime: newRuntime }, nonce,
  });
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', 'codexia-updater.timer']);
  await assertTimerState('active', 'enabled');
  await runLiveAnsibleTimerCheck({ repoRoot, workDir, enabled: true, shouldPass: true });
  await runLiveAnsibleTimerCheck({ repoRoot, workDir, enabled: false, shouldPass: false });

  const originalConfig = await readFile(configPath, 'utf8');
  const originalState = await loadControllerState(path.join(stateDir, 'controller.json'));
  const originalBlueUnit = await readFile(path.join(quadletDir, 'codexia-slot-blue.container'), 'utf8');
  const originalGreenUnit = await readFile(greenUnitPath, 'utf8');
  const originalServiceContent = await readFile(path.join(userUnitDir, 'codexia-updater.service'), 'utf8');
  const originalShim = await readFile(path.join(SOURCE_ROOT, 'deploy/updater/standalone-updater.mjs'), 'utf8');

  const testEntry = path.resolve(repoRoot, 'deploy/updater/test-standalone-maintenance-integration.mjs');
  const environment = {
    ...process.env,
    XDG_STATE_HOME: stateBase,
    CODEXIA_UPDATER_LOCK_DIRECTORY: stateDir,
    CODEXIA_RUNTIME_MAINTENANCE_REPO_ROOT: repoRoot,
    CODEXIA_RUNTIME_MAINTENANCE_IMAGE: expectedImage,
    CODEXIA_RUNTIME_MAINTENANCE_NONCE: nonce,
  };
  const lockFile = path.join(stateDir, 'host.lock');
  const holderMarker = path.join(workDir, 'host-lock-held');
  const holderChild = spawn('flock', ['--exclusive', '--nonblock', '--no-fork', lockFile, 'sh', '-c', 'touch -- "$1"; exec sleep 60', 'codexia-lock-holder', holderMarker], { env: environment, stdio: 'ignore' });
  const waitForFile = async filename => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { await lstat(filename); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Competing updater lock holder did not start');
  };
  await waitForFile(holderMarker);
  assert.equal(holderChild.exitCode, null, 'Host lock holder exited before the competing command');
  const contentionProbe = spawnSync('flock', ['--exclusive', '--nonblock', lockFile, process.execPath, '-e', 'process.exit(0)'], {
    encoding: 'utf8', timeout: 15000, env: environment,
  });
  assert.equal(contentionProbe.error, undefined, 'Kernel lock contention probe did not complete');
  assert.notEqual(contentionProbe.status, 0, 'A second updater acquired the already-held host lock');
  const wrapperResult = spawnSync('sh', [path.join(SOURCE_ROOT, 'deploy/updater/codexia-updater'), 'maintain-candidate', path.join(candidate.root, 'deploy/updater/standalone-updater.mjs'), configPath, path.join(candidate.root, 'manifest.json')], {
    encoding: 'utf8', timeout: 15000, env: environment,
  });
  assert.equal(wrapperResult.error, undefined, 'Contended wrapper check did not complete');
  assert.notEqual(wrapperResult.status, 0, 'Canonical updater wrapper bypassed an already-held host lock');
  assert.equal(holderChild.exitCode, null, 'Host lock holder exited before the canonical wrapper finished');
  holderChild.kill('SIGTERM');
  await new Promise(resolve => holderChild.once('exit', resolve));
  await rm(holderMarker, { force: true });
  assert.equal(await readFile(configPath, 'utf8'), originalConfig, 'A contended maintenance command changed config');
  assert.deepEqual(await loadControllerState(path.join(stateDir, 'controller.json')), originalState, 'A contended maintenance command changed controller state');
  assert.equal(await readFile(path.join(quadletDir, 'codexia-slot-blue.container'), 'utf8'), originalBlueUnit);

  const runLockedMaintenance = (fail = false) => {
    const args = ['--exclusive', '--nonblock', '--no-fork', lockFile, process.execPath, testEntry, '--maintain', candidate.manifestPath, fail ? 'expect-failure' : 'expect-success'];
    const result = spawnSync('flock', args, {
      encoding: 'utf8', timeout: 240000,
      env: { ...environment, ...(fail ? { CODEXIA_RUNTIME_MAINTENANCE_FAIL_CPU: String(FAILURE_CPU) } : {}) },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Locked maintenance child failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  };

  runLockedMaintenance(true);
  await assertTimerState('active', 'enabled');
  assert.equal(await readFile(configPath, 'utf8'), originalConfig, 'Failed maintenance did not restore the prior runtime configuration');
  assert.equal(await readFile(path.join(SOURCE_ROOT, 'deploy/updater/standalone-updater.mjs'), 'utf8'), originalShim, 'Failed maintenance did not restore the old source entrypoint');
  assert.equal(await readFile(path.join(userUnitDir, 'codexia-updater.service'), 'utf8'), originalServiceContent, 'Failed maintenance did not restore the prior updater unit');
  assert.equal(await readFile(path.join(quadletDir, 'codexia-slot-blue.container'), 'utf8'), originalBlueUnit, 'Failed maintenance did not restore the prior writer unit');
  assert.equal(await readFile(greenUnitPath, 'utf8'), originalGreenUnit, 'Failed maintenance did not restore the inactive slot unit');
  assert.deepEqual(await loadControllerState(path.join(stateDir, 'controller.json')), originalState, 'Failed maintenance changed the journal/checkpoint or pause state');
  assert.equal((await readFile(routeFile, 'utf8')), 'blue\n', 'Failed maintenance did not recover the original proxy route');
  await verifyFixture(configPath);
  run('podman', ['exec', CONTAINER, 'node', '--input-type=module', '-e',
    'import {readFileSync} from "node:fs";const nl=String.fromCharCode(10);for(const [p,v] of [["/data/runtime-contract-marker","data-marker-v1"+nl],["/history/runtime-contract-marker","history-marker-v1"+nl]])if(readFileSync(p,"utf8")!==v)throw new Error(p)']);

  runLockedMaintenance(false);
  await assertTimerState('active', 'enabled');
  const appliedConfig = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(appliedConfig.runtime, newRuntime, 'Successful maintenance did not retain its typed runtime change');
  assert.equal(await readFile(path.join(userUnitDir, 'codexia-updater.service'), 'utf8'), await readFile(path.join(repoRoot, 'deploy/updater/codexia-updater.service.example'), 'utf8'), 'Successful maintenance did not apply the reviewed updater unit');
  const appliedState = await loadControllerState(path.join(stateDir, 'controller.json'));
  assert.deepEqual(appliedState, originalState, 'Successful maintenance changed the journal/checkpoint or pause state');
  assert.equal((await readFile(routeFile, 'utf8')), 'blue\n', 'Successful maintenance changed the proxy route');
  await verifyFixture(configPath);
  await runLiveAnsibleTimerCheck({ repoRoot, workDir, enabled: true, shouldPass: true });
  await runLiveAnsibleTimerCheck({ repoRoot, workDir, enabled: false, shouldPass: false });

  run('systemctl', ['--user', 'restart', SERVICE], { timeout: 120000 });
  await waitForUnit(SERVICE, 'active');
  await verifyFixture(configPath);
  run('podman', ['exec', CONTAINER, 'node', '--input-type=module', '-e',
    'import {readFileSync} from "node:fs";const nl=String.fromCharCode(10);for(const [p,v] of [["/data/runtime-contract-marker","data-marker-v1"+nl],["/history/runtime-contract-marker","history-marker-v1"+nl]])if(readFileSync(p,"utf8")!==v)throw new Error(p)']);

  const interruptedRuntime = validateRuntimeContract({
    ...appliedConfig.runtime,
    resources: { ...appliedConfig.runtime.resources, cpuQuotaPercent: FAILURE_CPU + 25 },
  });
  const interruptedCandidate = await createCandidate({
    repoRoot, stateDir, configPath, sourceDir: SOURCE_ROOT, unitDir: userUnitDir,
    quadletDir, candidateConfig: { ...appliedConfig, runtime: interruptedRuntime }, nonce: nonce + '-boot-recovery',
  });
  await runInterruptedBootRecovery({
    repoRoot, workDir, stateDir, configPath, candidate: interruptedCandidate, environment,
    expectedState: appliedState, expectedRuntime: appliedConfig.runtime, interruption: 'after-write',
  });
  await runInterruptedBootRecovery({
    repoRoot, workDir, stateDir, configPath, candidate: interruptedCandidate, environment,
    expectedState: appliedState, expectedRuntime: appliedConfig.runtime, interruption: 'after-writer-drain',
  });

  // Credential-only transaction on the installed runtime: old/new endpoint
  // admission is synthetic, but the existing production transaction/recovery
  // logic, actual rootless timer, writer and private files are exercised.
  const probeKey=generateKeyPairSync('ed25519');
  const probeKeyFile=path.join(workDir,'fixture-probe-private.pem');
  await writeFile(probeKeyFile,probeKey.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
  await atomicWrite(publicKeyFile,probeKey.publicKey.export({type:'spki',format:'pem'}));
  const accessIdFile=path.join(privateDir,'access-client-id');
  const accessSecretFile=path.join(privateDir,'access-client-secret');
  const credentialConfig={...appliedConfig,accessClientIdFile:accessIdFile,accessClientSecretFile:accessSecretFile};
  await atomicWrite(configPath,JSON.stringify(credentialConfig,null,2)+'\n');
  const credentialFiles=[
    [githubTokenFile,'fixture-old-github','fixture-new-github'],
    [accessIdFile,'fixture-old-id','fixture-new-id'],
    [accessSecretFile,'fixture-old-secret','fixture-new-secret'],
  ];
  const credentialRoot=path.join(stateDir,'maintenance','candidates',nonce+'-credentials');
  await mkdir(path.join(credentialRoot,'credentials'),{recursive:true,mode:0o700});
  for(const [filename,oldValue,newValue] of credentialFiles){
    await atomicWrite(filename,oldValue+'\n');
    await atomicWrite(path.join(credentialRoot,'credentials',path.basename(filename)),newValue+'\n');
  }
  const credentialManifest=path.join(credentialRoot,'manifest.json');
  await atomicWrite(credentialManifest,JSON.stringify({format:'codexia-updater-maintenance/v1',candidateRoot:credentialRoot,
    configPath,sourceDir:SOURCE_ROOT,unitDir:userUnitDir,rotateProbeCredentials:true})+'\n');
  const credentialEnvironment={...environment,CODEXIA_RUNTIME_MAINTENANCE_PROBE_KEY:probeKeyFile,
    CODEXIA_RUNTIME_MAINTENANCE_BOOT_RECOVERY:'yes',
    NODE_OPTIONS:'--import='+pathToFileURL(path.join(repoRoot,'deploy/updater/test-standalone-maintenance-preload.mjs')).href};
  let writerBefore=JSON.parse(run('podman',['inspect','--type','container',CONTAINER]))[0].Id;
  const checkCredentials=async(useNew)=>{
    for(const [filename,oldValue,newValue] of credentialFiles){
      assert.ok((await readFile(filename,'utf8'))===(useNew?newValue:oldValue)+'\n','Credential rollback or installation mismatch');
      assert.equal((await lstat(filename)).mode&0o777,0o600);
    }
    assert.deepEqual(await loadControllerState(path.join(stateDir,'controller.json')),appliedState);
    assert.equal((await readFile(routeFile,'utf8')),'blue\n');
    assert.equal(JSON.parse(run('podman',['inspect','--type','container',CONTAINER]))[0].Id,writerBefore,'Credential maintenance restarted the writer');
    assert.equal(await readFile(configPath,'utf8'),JSON.stringify(credentialConfig,null,2)+'\n');
    await assertTimerState('active','enabled');
    await assert.rejects(lstat(path.join(stateDir,'maintenance','in-progress.json')),{code:'ENOENT'});
  };
  const runCredentialMaintenance=(outcome,failure)=>spawnSync('flock',['--exclusive','--nonblock','--no-fork',lockFile,
    process.execPath,testEntry,'--maintain',credentialManifest,outcome],{encoding:'utf8',timeout:240000,
    env:{...credentialEnvironment,...(failure?{CODEXIA_RUNTIME_MAINTENANCE_PROBE_FAILURE:failure}:{})}});
  const failedCredentials=runCredentialMaintenance('expect-failure','after-write');
  assert.equal(failedCredentials.status,0,'Credential failure did not restore the old values: '+failedCredentials.stderr);
  await checkCredentials(false);
  const crashedCredentials=runCredentialMaintenance('expect-interruption','crash');
  assert.equal(crashedCredentials.signal,'SIGKILL','Credential interruption was not injected after writing the new values');
  assert.ok((await lstat(path.join(stateDir,'maintenance','in-progress.json'))).isFile());
  assert.equal(await readFile(githubTokenFile,'utf8'),'fixture-new-github\n');
  // A stopped foreign slot must block recovery even while the committed writer is live.
  const foreignName='codexia-slot-green';
  const foreignId=run('podman',['create','--name',foreignName,expectedImage]);
  try{
    const refused=spawnSync('sh',[path.join(SOURCE_ROOT,'deploy/updater/codexia-updater'),'boot',configPath],
      {encoding:'utf8',timeout:240000,env:credentialEnvironment});
    assert.notEqual(refused.status,0,'Recovery accepted a stopped foreign slot alongside the committed writer');
    assert.equal((await readFile(routeFile,'utf8')),'blocked\n');
    assert.equal((await loadControllerState(path.join(stateDir,'controller.json'))).paused,true);
    assert.ok((await lstat(path.join(stateDir,'maintenance','in-progress.json'))).isFile());
    assert.equal(JSON.parse(run('podman',['inspect','--type','container',CONTAINER]))[0].Id,writerBefore,'Recovery restarted the committed writer');
    const foreign=JSON.parse(run('podman',['inspect','--type','container',foreignName]))[0];
    assert.equal(foreign.Id,foreignId);
    assert.equal(foreign.State.Running,false);
  }finally{
    run('podman',['rm',foreignId]);
  }
  const recoveredCredentials=spawnSync('sh',[path.join(SOURCE_ROOT,'deploy/updater/codexia-updater'),'boot',configPath],
    {encoding:'utf8',timeout:240000,env:credentialEnvironment});
  assert.equal(recoveredCredentials.status,0,'Credential interruption was not recovered by canonical boot: '+recoveredCredentials.stderr);
  await checkCredentials(false);

  // Reproduce the state after a VM/user-manager restart: the maintenance
  // process was killed after the writes and the old slot no longer exists.
  const rebootCredentials=runCredentialMaintenance('expect-interruption','crash');
  assert.equal(rebootCredentials.signal,'SIGKILL');
  assert.equal(await readFile(githubTokenFile,'utf8'),'fixture-new-github\n');
  await new PodmanStandaloneHost(credentialConfig).stopWriter('blue');
  assert.equal(spawnSync('podman',['container','exists',CONTAINER],{stdio:'ignore'}).status,1);
  // A native service that shadows the generated Quadlet is not authority
  // to restart the committed writer. Refuse it before its ExecStart runs.
  const shadow=path.join(userUnitDir,SERVICE);
  const canary=path.join(workDir,'unexpected-writer-unit-start');
  await writeFile(shadow,`[Service]\nType=oneshot\nExecStart=/usr/bin/touch ${canary}\n`,{mode:0o600,flag:'wx'});
  try{
    run('systemctl',['--user','daemon-reload']);
    const refused=spawnSync('sh',[path.join(SOURCE_ROOT,'deploy/updater/codexia-updater'),'boot',configPath],
      {encoding:'utf8',timeout:240000,env:credentialEnvironment});
    assert.notEqual(refused.status,0,'Recovery accepted a shadow writer unit');
    await assert.rejects(lstat(canary),{code:'ENOENT'});
    assert.equal(spawnSync('podman',['container','exists',CONTAINER],{stdio:'ignore'}).status,1);
    assert.equal((await readFile(routeFile,'utf8')),'blocked\n');
    assert.equal((await loadControllerState(path.join(stateDir,'controller.json'))).paused,true);
    assert.ok((await lstat(path.join(stateDir,'maintenance','in-progress.json'))).isFile());
  }finally{
    await rm(shadow);
    run('systemctl',['--user','daemon-reload']);
  }
  const recoveredAbsentWriter=spawnSync('sh',[path.join(SOURCE_ROOT,'deploy/updater/codexia-updater'),'boot',configPath],
    {encoding:'utf8',timeout:240000,env:credentialEnvironment});
  assert.equal(recoveredAbsentWriter.status,0,'Credential interruption with stopped writer failed boot recovery: '+recoveredAbsentWriter.stderr);
  const restartedWriter=JSON.parse(run('podman',['inspect','--type','container',CONTAINER]))[0].Id;
  assert.notEqual(restartedWriter,writerBefore,'Stopped writer was not recreated');
  writerBefore=restartedWriter;
  await checkCredentials(false);
  const successfulCredentials=runCredentialMaintenance('expect-success');
  assert.equal(successfulCredentials.status,0,'Credential transaction failed: '+successfulCredentials.stderr);
  await checkCredentials(true);
  await rm(credentialRoot,{recursive:true,force:true});
  await rm(probeKeyFile);

  await exercisePreflightPasswordRotation({repoRoot,config:appliedConfig,userUnitDir,workDir,expectedImage,environment,
    originalProxyText:proxyText,proxyQuadlet,nonce});
  await exercisePostgresPasswordRotation({
    repoRoot, config: appliedConfig, userUnitDir, workDir, nonce, expectedImage,
    originalProxyText: proxyText, proxyQuadlet, environment,
  });
  await exerciseApiAuthTokenRotation({repoRoot,config:appliedConfig,workDir,expectedImage,environment,
    originalProxyText:proxyText,proxyQuadlet,nonce});
  await exerciseTunnelTokenRotation({repoRoot,config:appliedConfig,userUnitDir,workDir,expectedImage,environment,nonce,
    originalProxyText:proxyText,proxyQuadlet});

  run('systemctl', ['--user', 'disable', '--now', 'codexia-updater.timer']);
  await assertTimerState('inactive', 'disabled');
  await runLiveAnsibleTimerCheck({ repoRoot, workDir, enabled: false, shouldPass: true });
  await runLiveAnsibleTimerCheck({ repoRoot, workDir, enabled: true, shouldPass: false });
  // Reuse the real fencing primitive: Quadlet may remove the container
  // while leaving the unit failed. Only reset after proving container absence.
  await new PodmanStandaloneHost(appliedConfig).stopWriter('blue');
  assert.equal(systemdState(SERVICE), 'inactive');
  const stopped = spawnSync('podman', ['container', 'exists', CONTAINER], { timeout: 15000, stdio: 'ignore' });
  if (stopped.error) throw stopped.error;
  assert.equal(stopped.status, 1, 'Cleanup must prove writer absence');
  // Exercise the actual common adapter, not the synthetic start override.
  const commonHost=new PodmanStandaloneHost(appliedConfig);
  const committed=(await loadControllerState(appliedConfig.stateFile)).installed;
  const commonSource=path.join(appliedConfig.quadletDirectory,'codexia-slot-blue.container');
  const originalSource=await readFile(commonSource,'utf8');
  const commonCanary=path.join(workDir,'common-writer-shadow-executed');
  const commonShadow=path.join(userUnitDir,SERVICE);
  await writeFile(commonShadow,`[Service]\nType=oneshot\nExecStart=/usr/bin/touch ${commonCanary}\n`,{mode:0o600,flag:'wx'});
  try{
    await assert.rejects(commonHost.startWriter('blue',committed),/reviewed Quadlet|generated Quadlet/);
    await assert.rejects(lstat(commonCanary),{code:'ENOENT'});
    assert.equal(spawnSync('podman',['container','exists',CONTAINER],{stdio:'ignore'}).status,1);
  }finally{
    await rm(commonShadow);
    await atomicWrite(commonSource,originalSource);
    run('systemctl',['--user','daemon-reload']);
  }
  const unknownSlot=run('podman',['create','--name','codexia-slot-green',expectedImage]);
  try{
    await assert.rejects(commonHost.startWriter('blue',committed),/Unexpected stopped or running slot container/);
    assert.equal(JSON.parse(run('podman',['inspect','--type','container',unknownSlot]))[0].Id,unknownSlot);
    assert.equal(await readFile(commonSource,'utf8'),originalSource);
  }finally{run('podman',['rm',unknownSlot]);}
  const unknownPreflight=run('podman',['create','--name','codexia-preflight-blue',expectedImage]);
  try{
    await assert.rejects(commonHost.prepare('blue',committed),/Preflight ownership is unverified/);
    assert.equal(JSON.parse(run('podman',['inspect','--type','container',unknownPreflight]))[0].Id,unknownPreflight);
  }finally{run('podman',['rm',unknownPreflight]);}
  run('systemctl', ['--user', 'daemon-reload']);
  for (const unit of MAINTENANCE_UNIT_FILES) {
    const filename = path.join(userUnitDir, unit);
    const expected = await readFile(path.join(repoRoot, 'deploy/updater', `${unit}.example`), 'utf8');
    const actual = await readFile(filename, 'utf8');
    assert.ok(actual === expected || unit === 'codexia-updater.timer' && actual.includes('OnBootSec=24h'), `Unexpected retained updater fixture unit: ${unit}`);
    const info = await lstat(filename);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === UID && (info.mode & 0o777) === 0o600, `Refusing to remove an unowned updater unit: ${filename}`);
    await rm(filename);
  }
  assert.equal(await readFile(proxyQuadlet, 'utf8'), proxyText, 'Refusing to remove an unexpected proxy Quadlet fixture');
  const proxyInfo = await lstat(proxyQuadlet);
  assert.ok(proxyInfo.isFile() && !proxyInfo.isSymbolicLink() && proxyInfo.uid === UID && (proxyInfo.mode & 0o777) === 0o600);
  await rm(proxyQuadlet);
  assert.deepEqual((await readdir(privateDir)).sort(), ['access-client-id', 'access-client-secret', 'channel-public.pem', 'config.json', 'github-read-token'], 'Unexpected file exists in the synthetic private config directory');
  for (const file of [configPath, publicKeyFile, githubTokenFile, accessIdFile, accessSecretFile]) {
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === UID && (info.mode & 0o777) === 0o600, `Refusing to remove an unowned private config file: ${file}`);
    await rm(file);
  }
  assert.deepEqual(await readdir(privateDir), [], 'Unexpected file remains after fixture cleanup');
  await rmdir(privateDir);
  for (const file of [routeFile, path.join(stateDir, 'controller.json'), path.join(stateDir, 'host.lock')]) await rm(file, { force: true });
  await rm(stateBase, { recursive: true, force: true });
  run('systemctl', ['--user', 'daemon-reload']);
  process.stdout.write('PASS: locked maintenance applies a runtime/source/unit candidate, rolls back a failed writer restart, recovers killed transactions through canonical boot before and after writer drain, fails closed on ambiguous markers, preserves journal/route/data, restores the real timer, and survives a service restart\n');
}

if (process.argv[2] === '--verify-old') {
  await verifyFixture(process.argv[3]);
} else if (process.argv[2] === '--maintain') {
  const [manifestPath, outcome] = process.argv.slice(3);
  assert.ok(path.isAbsolute(manifestPath));
  await performMaintenance(manifestPath, outcome);
} else if (process.argv[2] === '--run') {
  await main();
}
