#!/usr/bin/env node
// Bundle the static dashboard. Its browser client reads public Actions data directly.
import { cp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export { collectInventoryPage, collectRevision, identity, selectRuns } from './collection.mjs';

const SOURCE = fileURLToPath(new URL('./site/', import.meta.url));

async function main() {
  const directory = process.argv[2];
  if (!directory || process.argv.length > 4 || (process.argv[3] && process.argv[3] !== '--preview')) {
    throw new Error('Usage: collect.mjs AUDIT_SITE [--preview]');
  }
  const root = resolve(directory);
  const dest = join(root, 'ci');
  await mkdir(dest, { recursive: true });
  await cp(SOURCE, dest, { recursive: true });
  const dashboardModules = join(dest, 'dashboard');
  await mkdir(dashboardModules, { recursive: true });
  await cp(fileURLToPath(new URL('./collection.mjs', import.meta.url)), join(dashboardModules, 'collection.mjs'));
  await cp(fileURLToPath(new URL('../../../.github/workflows/verify.yml', import.meta.url)), join(dest, 'verify.yml'));
  await cp(fileURLToPath(new URL('../../../.github/workflows/verify-profile.yml', import.meta.url)), join(dest, 'verify-profile.yml'));
  await cp(fileURLToPath(new URL('./analysis.mjs', import.meta.url)), join(dashboardModules, 'analysis.mjs'));
  await cp(fileURLToPath(new URL('./diagnostics.mjs', import.meta.url)), join(dashboardModules, 'diagnostics.mjs'));
  await cp(fileURLToPath(new URL('./timing.mjs', import.meta.url)), join(dashboardModules, 'timing.mjs'));
  const impact = join(dest, 'impact');
  await mkdir(impact, { recursive: true });
  await cp(fileURLToPath(new URL('../impact/contract.mjs', import.meta.url)), join(impact, 'contract.mjs'));
  const evidence = join(dest, 'evidence');
  await mkdir(evidence, { recursive: true });
  await cp(fileURLToPath(new URL('../evidence/job-name.mjs', import.meta.url)), join(evidence, 'job-name.mjs'));
  console.log('CI dashboard assets bundled; the browser reads public Actions metadata on demand.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
