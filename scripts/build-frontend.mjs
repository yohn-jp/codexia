#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBuildCommands } from './profile-package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${String(result.status)}`);
}

async function main() {
  const profileName = process.env.CODEXIA_PROFILE ?? 'core';
  const profile = JSON.parse(await readFile(path.join(root, 'profiles', `${profileName}.json`), 'utf8'));
  for (const step of createBuildCommands(profileName, profile, { includeApi: false })) {
    run(step.command, step.args, step.env);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Frontend build failed');
    process.exitCode = 1;
  });
}
