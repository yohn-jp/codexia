#!/usr/bin/env node
// Build each standalone Vite entry without POSIX-only inline environment assignments.
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));

export function buildViews({ viteConfig, prepared = false } = {}) {
  if (!prepared) {
    execFileSync(process.execPath, [fileURLToPath(new URL('./generate-http.mjs', import.meta.url))], { stdio: 'inherit' });
  }
  for (const ui of ['launcher', 'desktop', 'oauth']) {
    const result = spawnSync(process.execPath, [viteCli, 'build', ...(viteConfig ? ['--config', viteConfig] : [])], {
      cwd: appRoot,
      env: { ...process.env, CODEXIA_UI: ui },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Vite ${ui} build exited with status ${String(result.status)}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  buildViews({ prepared: process.argv.includes('--prepared') });
