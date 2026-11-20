import assert from 'node:assert/strict';
import fsPromises, { lstat, readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fixtureSourceRoot = '/opt/codexia-updater';
const updaterEntry = path.join(fixtureSourceRoot, 'deploy/updater/standalone-updater.mjs');
const bootRecoveryEnabled = process.env.CODEXIA_RUNTIME_MAINTENANCE_BOOT_RECOVERY === 'yes';
const appPasswordRotationEnabled = process.env.CODEXIA_RUNTIME_MAINTENANCE_APP_PASSWORD_ROTATION === 'yes';
const apiAuthTokenRotationEnabled = process.env.CODEXIA_RUNTIME_MAINTENANCE_AUTH_TOKEN_ROTATION === 'yes';
const apiAuthTokenCompletionInterruptionEnabled = process.env.CODEXIA_RUNTIME_MAINTENANCE_KILL_AT === 'after-api-auth-completion-marker';

export function installApiAuthTokenCompletionInterruption(markerPath) {
  const originalUnlink = fsPromises.unlink;
  fsPromises.unlink = async function guardedCompletionUnlink(filename, ...args) {
    const candidate = path.resolve(String(filename));
    if (candidate.endsWith(`${path.sep}api-auth-token`)) {
      const marker = JSON.parse(await readFile(markerPath, 'utf8'));
      assert.equal(marker.format, 'codexia-maintenance-api-auth-token/v1');
      assert.equal(marker.phase, 'completed', 'Completion interruption reached token cleanup before durable completion');
      assert.equal(candidate, marker.rotation.previousTokenFile,
        'Completion interruption may stop only before prior-token snapshot cleanup');
      process.kill(process.pid, 'SIGKILL');
    }
    return Reflect.apply(originalUnlink, this, [filename, ...args]);
  };
  syncBuiltinESMExports();
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function oldSourceVerifierEntry(argv, env) {
  if (argv[2] !== 'verify' || !path.isAbsolute(argv[1] ?? '') || !path.isAbsolute(env.XDG_STATE_HOME ?? '')) return null;
  const stateHome = path.resolve(env.XDG_STATE_HOME);
  const entry = path.resolve(argv[1]);
  if (stateHome !== env.XDG_STATE_HOME || entry !== argv[1]) return null;

  const snapshotsRoot = path.join(stateHome, 'codexia-updater', 'maintenance', 'snapshots');
  if (!isInside(snapshotsRoot, entry)) return null;
  const relative = path.relative(snapshotsRoot, entry).split(path.sep);
  if (relative.length !== 5 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(relative[0]) ||
      relative[1] !== 'old-source' || relative[2] !== 'deploy' || relative[3] !== 'updater' || relative[4] !== 'standalone-updater.mjs') return null;
  return entry;
}

let adapterEntry = null;
if (bootRecoveryEnabled && path.resolve(process.argv[1] ?? '') === updaterEntry && process.argv[2] === 'boot') {
  adapterEntry = updaterEntry;
} else if ((appPasswordRotationEnabled || apiAuthTokenRotationEnabled) && path.resolve(process.argv[1] ?? '') === updaterEntry && process.argv[2] === 'maintain') {
  const manifestPath = path.resolve(process.argv[4] ?? '');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const privateCandidates = path.join(os.homedir(), '.config', 'codexia-updater', 'maintenance', 'candidates');
  if (appPasswordRotationEnabled) assert.ok(manifest.rotatePostgresAppPassword === true, 'Rotation adapter requires the explicit app-password request');
  if (apiAuthTokenRotationEnabled) assert.ok(manifest.rotateApiAuthToken === true, 'Rotation adapter requires the explicit API token request');
  assert.equal(path.dirname(manifestPath), manifest.candidateRoot, 'Rotation manifest differs from its private candidate directory');
  assert.equal(path.dirname(manifest.candidateRoot), privateCandidates, 'Rotation input escaped the private candidate staging tree');
  adapterEntry = updaterEntry;
} else if (bootRecoveryEnabled) {
  adapterEntry = oldSourceVerifierEntry(process.argv, process.env);
}

if (adapterEntry) {
  assert.equal(process.env.CODEXIA_RUNTIME_ACCEPTANCE_DISPOSABLE, 'yes', 'Disposable runtime acceptance guard is absent');
  assert.notEqual(process.getuid?.(), 0, 'Refusing the root identity for runtime maintenance adapters');
  assert.notEqual(os.userInfo().username, 'codexia', 'Refusing the production Codexia service identity');
  const markerPath = '/etc/codexia-iac-disposable-vm';
  const markerInfo = await lstat(markerPath);
  assert.ok(markerInfo.isFile() && !markerInfo.isSymbolicLink(), 'Disposable VM marker is not a regular file');
  assert.equal(markerInfo.uid, 0, 'Disposable VM marker is not root-owned');
  assert.equal((await readFile(markerPath, 'utf8')).trim(), 'codexia-iac-disposable-vm/v1', 'Disposable VM marker is invalid');

  const hostModule = await import(pathToFileURL(path.join(path.dirname(adapterEntry), 'standalone-host.mjs')).href);
  const testModule = await import(new URL('./test-standalone-maintenance-integration.mjs', import.meta.url));
  assert.equal(typeof testModule.installTestAdapters, 'function', 'Disposable runtime adapter is unavailable');
  testModule.installTestAdapters(hostModule.PodmanStandaloneHost);
}

if (apiAuthTokenRotationEnabled && apiAuthTokenCompletionInterruptionEnabled &&
    path.resolve(process.argv[1] ?? '') === updaterEntry && process.argv[2] === 'maintain') {
  const configPath = path.resolve(process.argv[3] ?? '');
  assert.equal(path.dirname(configPath), path.join(os.homedir(), '.config', 'codexia-updater'),
    'Completion interruption requires the disposable updater configuration');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const stateHome = path.resolve(process.env.XDG_STATE_HOME ?? '');
  assert.ok(path.isAbsolute(stateHome) && stateHome === process.env.XDG_STATE_HOME,
    'Completion interruption requires the exact disposable state directory');
  assert.equal(path.dirname(config.stateFile), path.join(stateHome, 'codexia-updater'),
    'Completion interruption state differs from the disposable updater');
  const markerPath = path.join(path.dirname(config.stateFile), 'maintenance', 'in-progress.json');
  installApiAuthTokenCompletionInterruption(markerPath);
}
