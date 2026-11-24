import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stageOwnerSetupAssets } from './owner-setup-assets.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codexia-owner-setup-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const frontend = join(directory, 'frontend');
  await mkdir(join(frontend, 'console/setup/assets'), { recursive: true });
  await mkdir(join(frontend, 'desktop'));
  await writeFile(join(frontend, 'desktop/index.html'), 'ordinary desktop');
  const entry = '<link rel="stylesheet" href="/console/setup/assets/styles-x.css">' +
    '<script type="module" src="/console/setup/assets/index-x.js"></script>';
  await writeFile(join(frontend, 'console/setup/index.html'), entry);
  await writeFile(join(frontend, 'console/setup/assets/index-x.js'), 'export {};');
  await writeFile(join(frontend, 'console/setup/assets/styles-x.css'), 'body {}');
  return { frontend, destination: join(directory, 'stage'), entry };
}

test('staging preserves certified setup bytes and excludes the rest of the frontend', async t => {
  const { frontend, destination, entry } = await fixture(t);
  await stageOwnerSetupAssets(frontend, destination);
  assert.deepEqual((await readdir(destination)).sort(), ['_headers', '_redirects', 'console']);
  assert.equal(await readFile(join(destination, 'console/setup/index.html'), 'utf8'), entry);
  assert.equal(await readFile(join(destination, 'console/setup/assets/index-x.js'), 'utf8'), 'export {};');
  assert.equal(await readFile(join(destination, '_redirects'), 'utf8'),
    '/console/setup /console/setup/index.html 200\n/console/setup/ /console/setup/index.html 200\n');
});

test('missing setup or unsafe certified asset trees are not staged', async t => {
  const { frontend, destination } = await fixture(t);
  const source = join(frontend, 'console/setup');
  await symlink(join(frontend, 'desktop/index.html'), join(source, 'assets/other-x.js'));
  await assert.rejects(stageOwnerSetupAssets(frontend, destination), /regular/u);
  await rm(source, { recursive: true });
  await assert.rejects(stageOwnerSetupAssets(frontend, destination));
});

test('a symlink cannot supply the setup entry or replace certified bytes', async t => {
  const { frontend, destination } = await fixture(t);
  const entry = join(frontend, 'console/setup/index.html');
  await rm(entry);
  await symlink(join(frontend, 'desktop/index.html'), entry);
  await assert.rejects(stageOwnerSetupAssets(frontend, destination), /regular HTML entry/u);
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});
