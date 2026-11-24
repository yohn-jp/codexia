#!/usr/bin/env node
// Build each standalone Vite entry without POSIX-only inline environment assignments.
import { spawnSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));

for (const ui of ['launcher', 'desktop', 'mobile', 'oauth', 'owner-setup']) {
  const result = spawnSync(process.execPath, [viteCli, 'build'], {
    cwd: appRoot,
    env: { ...process.env, CODEXIA_UI: ui },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Vite ${ui} build exited with status ${String(result.status)}`);
  }
}

const setup = join(process.env.CODEXIA_VITE_BUILD_OUTPUT_ROOT ?? join(appRoot, 'dist'), 'console/setup');
renameSync(join(setup, 'owner-setup.html'), join(setup, 'index.html'));
