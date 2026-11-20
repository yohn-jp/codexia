import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'codexia-updater-dispatch-'));
  const state = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  const runtime = path.join(root, 'runtime');
  const quadlet = path.join(root, '.config', 'containers', 'systemd');
  await mkdir(path.join(state, 'maintenance'), { recursive:true, mode:0o700 });
  await mkdir(bin, { mode:0o700 });
  await mkdir(runtime, { mode:0o700 });
  await mkdir(quadlet, { recursive:true, mode:0o700 });
  await writeFile(path.join(root, 'public.pem'), 'test\n', { mode:0o600 });
  await writeFile(path.join(state, 'route'), 'blocked\n', { mode:0o600 });
  await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nif [ "$3" = "show" ]; then printf active; else printf active; fi\n', { mode:0o700 });
  await chmod(path.join(bin, 'systemctl'), 0o700);
  const config = path.join(root, 'config.json');
  await writeFile(config, JSON.stringify({ format:'codexia-standalone-updater/v1', enabled:false, stateFile:path.join(state,'controller.json'), routeFile:path.join(state,'route'), publicKeyFile:path.join(root,'public.pem'), quadletDirectory:quadlet, githubTokenFile:path.join(root,'github-token'), frontendIdentityUrl:'https://example.invalid/desktop/update-identity.json', browserAuth:{ mode:'token' } })+'\n', { mode:0o600 });
  return { root, state, config, bin, runtime };
}

function run(command, config, state, bin) {
  return spawnSync(process.execPath, ['deploy/updater/standalone-updater.mjs', command, config], { cwd: process.cwd(), encoding:'utf8', env:{ ...process.env, HOME:path.dirname(bin), XDG_RUNTIME_DIR:state.replace(/\/state$/u,'/runtime'), PATH:bin+':'+process.env.PATH, CODEXIA_UPDATER_LOCK_DIRECTORY:state } });
}

test('ordinary boot with no maintenance marker reaches the normal no-state path', async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive:true, force:true }));
  const result = run('boot', value.config, value.state, value.bin);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No controller state/);
  assert.doesNotMatch(result.stderr, /in-progress\.json/);
});

test('schema maintenance refuses an unrelated pending maintenance marker', async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive:true, force:true }));
  await writeFile(path.join(value.state, 'maintenance', 'in-progress.json'), JSON.stringify({ format:'codexia-maintenance-transaction/v1' })+'\n', { mode:0o600 });
  const result = run('schema-maintenance', value.config, value.state, value.bin);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Pending runtime maintenance requires recovery/);
});
