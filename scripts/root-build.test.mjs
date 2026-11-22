import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRootBuildCommands } from './root-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

test('omitted and explicit Core profiles build the API and browser with a Core registry and no optional producers', async () => {
  const core = JSON.parse(await readFile(path.join(root, 'profiles/core.json'), 'utf8'));
  const full = JSON.parse(await readFile(path.join(root, 'profiles/full.json'), 'utf8'));
  const optionalPackages = new Set(['@codexia/migration', ...full.modules.map(id => '@codexia/module-' + id)]);
  for (const selection of [undefined, '', 'core']) {
    const commands = createRootBuildCommands(selection, core);
    const app = commands.findIndex(({ args }) => args.includes('@codexia/app'));
    const api = commands.findIndex(({ args }) => args.includes('@codexia/api...'));
    const registry = commands.findIndex(({ args }) =>
      args.some(argument => path.basename(argument) === 'profile-build.mjs') && args.includes('core'));
    const runtime = commands.findIndex(({ args }) => args.includes('@codexia/module-runtime'));
    assert.ok(runtime >= 0 && runtime < registry && registry < app && registry < api);
    assert.equal(commands[app].env?.CODEXIA_PROFILE, 'core');
    assert.ok(commands.every(({ args }) => args.every(argument => !optionalPackages.has(argument.replace(/\.\.\.$/u, '')))));
  }
});

test('Full root builds keep the existing workspace graph', () => {
  assert.equal(packageManifest.scripts.build, 'node scripts/root-build.mjs');
  assert.equal(typeof packageManifest.scripts['build:workspace'], 'string');
  assert.deepEqual(createRootBuildCommands('full'), [{
    command: 'pnpm',
    args: ['run', 'build:workspace'],
  }]);
});
