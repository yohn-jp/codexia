#!/usr/bin/env node

import { readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readComponentVersion } from './component-release-version.mjs';
import { frontendOAuthConfigHash, readFrontendOAuthConfig } from './frontend-oauth-config.mjs';
import { createBuildCommands } from './profile-package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${String(result.status)}`);
}

async function main() {
  const oauthConfig = readFrontendOAuthConfig();
  const oauthConfigSha256 = frontendOAuthConfigHash();
  if (oauthConfig) process.env.VITE_CODEXIA_OAUTH_SCOPES = oauthConfig.scopes.join(' ');
  const profileName = process.env.CODEXIA_PROFILE ?? 'core';
  const profile = JSON.parse(await readFile(path.join(root, 'profiles', `${profileName}.json`), 'utf8'));
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/u.test(sourceSha) || !['core', 'full'].includes(profileName)) throw new Error('Invalid standalone frontend identity');
  const version = readComponentVersion('frontend');
  const { apiEpoch } = JSON.parse(await readFile(path.join(root, 'deploy/frontend-compatibility.json'), 'utf8'));
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version) || !Number.isSafeInteger(apiEpoch) || apiEpoch < 1) throw new Error('Invalid frontend compatibility version');
  for (const step of createBuildCommands(profileName, profile, { includeApi: false })) {
    run(step.command, step.args, step.env);
  }
  for (const name of ['_headers', '_redirects']) {
    await copyFile(path.join(root, 'edge/frontend/static', name), path.join(root, 'app/dist', name));
  }
  await writeFile(path.join(root, 'app/dist/desktop/update-identity.json'), JSON.stringify({ format: 'codexia-frontend-identity/v1', version, sourceSha, profile: profileName, apiEpoch, oauthConfigSha256 }) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Frontend build failed');
    process.exitCode = 1;
  });
}
