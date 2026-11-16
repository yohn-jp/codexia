import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
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
    assert.equal(systemdState(SERVICE), 'inactive', 'Writer-drain interruption did not stop the active writer');
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
  assert.match(expectedImage ?? '', /^sha256:[a-f0-9]{64}$/u, 'Synthetic local image identity is missing');

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
    await validateSlot(this.config, this.runtime, state, expectedImage);
    const observed = await this.observe();
    assert.deepEqual(observed.writers, [{ slot: state.journal.active.slot, image: state.installed.image }], 'Synthetic maintenance must retain exactly one active writer');
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
  installTestAdapters();
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const config = JSON.parse(await readFile(manifest.configPath, 'utf8'));
  const state = await loadControllerState(config.stateFile);
  const publicKey = await readFile(config.publicKeyFile, 'utf8');
  const store = { save: value => atomicWrite(config.stateFile, JSON.stringify(value) + '\n') };
  if (outcome === 'expect-failure') {
    await assert.rejects(maintainStandaloneUpdater({ config, manifestPath, publicKey, state, store }), /Updater maintenance failed; previous source\/config\/units were restored/u);
  } else if (outcome === 'expect-success') {
    const result = await maintainStandaloneUpdater({ config, manifestPath, publicKey, state, store });
    assert.equal(result.format, 'codexia-updater-maintenance/v1');
  } else if (outcome === 'expect-interruption') await maintainStandaloneUpdater({ config, manifestPath, publicKey, state, store });
  else throw new Error('Unknown synthetic maintenance test outcome');
}

async function assertTimerState(active, enabled) {
  const observed = {
    active: run('systemctl', ['--user', 'show', '--property=ActiveState', '--value', 'codexia-updater.timer']),
    enabled: run('systemctl', ['--user', 'show', '--property=UnitFileState', '--value', 'codexia-updater.timer']),
  };
  assert.deepEqual(observed, { active, enabled }, 'Locked maintenance changed updater polling state');
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
  const proxyDigest = 'ghcr.io/yohn-jp/codexia-backend@sha256:' + 'd'.repeat(64);
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

  run('systemctl', ['--user', 'disable', '--now', 'codexia-updater.timer']);
  await assertTimerState('inactive', 'disabled');
  await runLiveAnsibleTimerCheck({ repoRoot, workDir, enabled: false, shouldPass: true });
  await runLiveAnsibleTimerCheck({ repoRoot, workDir, enabled: true, shouldPass: false });
  run('systemctl', ['--user', 'stop', SERVICE]);
  await waitForUnit(SERVICE, 'inactive');
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
  for (const file of [configPath, publicKeyFile, githubTokenFile]) {
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === UID && (info.mode & 0o777) === 0o600, `Refusing to remove an unowned private config file: ${file}`);
    await rm(file);
  }
  assert.deepEqual((await readdir(privateDir)).sort(), ['channel-public.pem', 'github-read-token', 'config.json'], 'Unexpected file remains in the synthetic private config directory');
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
