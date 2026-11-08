import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const audit = fileURLToPath(new URL('./audit-runtime-deps.mjs', import.meta.url));
test('Core audit distinguishes installed optional modules from its actual production closure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codexia-audit-'));
  const manifest = async (dir, value) => {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, dir, 'package.json'), JSON.stringify(value));
  };
  const run = (...extra) => spawnSync(process.execPath, [audit, '--node-modules', 'node_modules', ...extra], { cwd: root, encoding: 'utf8' });
  try {
    for (const name of ['core', 'api']) await manifest(`packages/${name}`, { name: `@codexia/${name}`, version: '1.0.0' });
    await manifest('app', { name: '@codexia/app', version: '1.0.0' });
    const optional = 'node_modules/.pnpm/optional/node_modules/@codexia/module-story';
    await manifest(optional, { name: '@codexia/module-story', version: '1.0.0' });
    assert.equal(run().status, 0, 'development installation alone must not enter Core closure');
    assert.notEqual(run('--production').status, 0, 'an optional package must be absent from Core production image');
    await mkdir(path.join(root, 'packages/core/node_modules/@codexia'), { recursive: true });
    await symlink(path.join(root, optional), path.join(root, 'packages/core/node_modules/@codexia/module-story'));
    await manifest('packages/core', { name: '@codexia/core', version: '1.0.0', dependencies: { '@codexia/module-story': '1.0.0' } });
    const dependency = run();
    assert.notEqual(dependency.status, 0);
    assert.match(dependency.stderr, /runtime dependency @codexia\/module-story/);
    await manifest('packages/core', { name: '@codexia/core', version: '1.0.0', peerDependencies: { '@codexia/module-story': '1.0.0' } });
    assert.notEqual(run().status, 0, 'peer-only runtime dependency must enter Core closure');
    await manifest('packages/core', { name: '@codexia/core', version: '1.0.0', peerDependencies: { 'absent-optional-peer': '1.0.0' }, peerDependenciesMeta: { 'absent-optional-peer': { optional: true } } });
    assert.equal(run().status, 0, 'missing optional peer does not enter closure');
    await manifest('packages/core', { name: '@codexia/core', version: '1.0.0' });
    await mkdir(path.join(root, 'compiled'), { recursive: true });
    await writeFile(path.join(root, 'compiled/index.js'), 'import "@codexia/module-story";');
    assert.notEqual(run('--dist', 'compiled').status, 0, 'undeclared compiled module imports are forbidden too');
  } finally { await rm(root, { recursive: true, force: true }); }
});
