import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fixtureSourceRoot = '/opt/codexia-updater';
const updaterEntry = path.join(fixtureSourceRoot, 'deploy/updater/standalone-updater.mjs');
if (path.resolve(process.argv[1] ?? '') === updaterEntry && process.argv[2] === 'boot') {
  assert.equal(process.env.CODEXIA_RUNTIME_ACCEPTANCE_DISPOSABLE, 'yes', 'Disposable runtime acceptance guard is absent');
  assert.notEqual(process.getuid?.(), 0, 'Refusing the root identity for runtime maintenance adapters');
  assert.notEqual(os.userInfo().username, 'codexia', 'Refusing the production Codexia service identity');
  const markerPath = '/etc/codexia-iac-disposable-vm';
  const markerInfo = await lstat(markerPath);
  assert.ok(markerInfo.isFile() && !markerInfo.isSymbolicLink(), 'Disposable VM marker is not a regular file');
  assert.equal(markerInfo.uid, 0, 'Disposable VM marker is not root-owned');
  assert.equal((await readFile(markerPath, 'utf8')).trim(), 'codexia-iac-disposable-vm/v1', 'Disposable VM marker is invalid');

  const hostModule = await import(pathToFileURL(path.join(fixtureSourceRoot, 'deploy/updater/standalone-host.mjs')).href);
  const testModule = await import(new URL('./test-standalone-maintenance-integration.mjs', import.meta.url));
  assert.equal(typeof testModule.installTestAdapters, 'function', 'Disposable runtime adapter is unavailable');
  testModule.installTestAdapters(hostModule.PodmanStandaloneHost);
}
