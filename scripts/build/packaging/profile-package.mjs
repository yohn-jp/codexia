#!/usr/bin/env node

import { access, cp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const modulePackagePrefix = '@codexia/module-';
const knownModules = ['story', 'diagnostics', 'nlp', 'semantic', 'speaker', 'assistant', 'publishing', 'mcp', 'search'];

function usage() {
  console.error('Usage: node scripts/build/packaging/profile-package.mjs --profile <core|full> --out <new-directory> [--server-only]');
  process.exit(2);
}

export function validateProfilePackage(profileName, profile, packageManifest, installedModules) {
  if (!['core', 'full'].includes(profileName) || profile?.profile !== profileName || !Array.isArray(profile.modules) ||
      profile.modules.some((id) => typeof id !== 'string' || !knownModules.includes(id)) ||
      new Set(profile.modules).size !== profile.modules.length) {
    throw new Error(`Invalid ${profileName} profile manifest`);
  }

  const missing = profile.modules.filter((id) => !installedModules.has(id));
  if (missing.length) {
    throw new Error(`Profile ${profileName} requires module packages that have not been produced: ${missing.join(', ')}`);
  }
  if (packageManifest?.name !== `@codexia/profile-${profileName}`) {
    throw new Error(`Profile ${profileName} package must be named @codexia/profile-${profileName}`);
  }

  const dependencies = { ...packageManifest.dependencies, ...packageManifest.optionalDependencies };
  if (dependencies['@codexia/api'] === undefined) {
    throw new Error(`Profile ${profileName} package must depend on @codexia/api`);
  }
  if (dependencies['@codexia/persistence-postgres'] === undefined) {
    throw new Error(`Profile ${profileName} package must depend on @codexia/persistence-postgres`);
  }
  const directModuleDependencies = Object.keys(dependencies)
    .filter((name) => knownModules.includes(name.startsWith(modulePackagePrefix) ? name.slice(modulePackagePrefix.length) : ''))
    .sort();
  const expectedDependencies = profile.modules.map((id) => `${modulePackagePrefix}${id}`).sort();
  if (JSON.stringify(directModuleDependencies) !== JSON.stringify(expectedDependencies)) {
    throw new Error(`Profile ${profileName} package module dependencies do not match its profile manifest`);
  }
  return { profileName, moduleIds: [...profile.modules] };
}

export function createBuildCommands(profileName, profile, { includeUi = true, includeApi = true } = {}) {
  // A single topologically sorted union avoids rebuilding shared dependencies
  // for each profile module and again for the API. Keep profile generation and
  // the profile-specific UI build behind the workspace build barrier.
  const roots = [
    '@codexia/contracts', '@codexia/persistence-contracts',
    '@codexia/module-runtime',
    ...profile.modules.map((id) => `${modulePackagePrefix}${id}...`),
  ];
  const commands = [{
    command: 'pnpm',
    args: ['--recursive', '--sort', '--workspace-concurrency=2', '--fail-if-no-match',
      ...roots.flatMap((name) => ['--filter', name]),
      // The API builds its schema from TypeSpec source. Its dev-only test
      // workspaces stay installed, but aren't profile build products.
      ...(includeApi ? ['--filter-prod', '@codexia/api...'] : []), 'run', 'build'],
  }];
  commands.push({ command: process.execPath, args: [path.join(root, 'scripts/build/packaging/profile-build.mjs'), '--profile', profileName] });
  if (includeUi) {
    commands.push({ command: 'pnpm', args: ['--filter', '@codexia/app', 'run', 'build'], env: { CODEXIA_PROFILE: profileName } });
  }
  return commands;
}

function parseArgs(argv) {
  let profileName;
  let serverOnly = false;
  let outputDirectory;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile' && argv[index + 1]) profileName = argv[++index];
    else if (argv[index] === '--out' && argv[index + 1]) outputDirectory = path.resolve(argv[++index]);
    else if (argv[index] === '--server-only') serverOnly = true;
    else if (argv[index] === '--help') usage();
    else usage();
  }
  if (!['core', 'full'].includes(profileName) || !outputDirectory) usage();
  return { profileName, serverOnly, outputDirectory };
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

async function installedModuleIds() {
  const ids = new Set();
  for (const entry of await readdir(path.join(root, 'modules'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = await readJson(path.join(root, 'modules', entry.name, 'package.json'));
      if (manifest.name?.startsWith(modulePackagePrefix)) ids.add(manifest.name.slice(modulePackagePrefix.length));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return ids;
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${String(result.status)}`);
}

async function ensureNewOutputDirectory(directory) {
  const relative = path.relative(root, directory);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Profile deployment output must be outside the workspace');
  }
  try {
    await access(directory);
    throw new Error(`Profile deployment output already exists: ${directory}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function main() {
  const { profileName, serverOnly, outputDirectory } = parseArgs(process.argv.slice(2));
  const profile = await readJson(path.join(root, 'profiles', `${profileName}.json`));
  const packageManifest = await readJson(path.join(root, 'profiles', profileName, 'package.json'));
  validateProfilePackage(profileName, profile, packageManifest, await installedModuleIds());
  await ensureNewOutputDirectory(outputDirectory);

  for (const step of createBuildCommands(profileName, profile, { includeUi: !serverOnly })) run(step.command, step.args, step.env);
  try {
    const storeArgs = process.env.CODEXIA_PNPM_STORE_DIR
      ? ['--store-dir', process.env.CODEXIA_PNPM_STORE_DIR]
      : [];
    run('pnpm', ['--filter', packageManifest.name, 'deploy', '--prod', '--frozen-lockfile', '--prefer-offline', ...storeArgs, outputDirectory]);
    await cp(path.join(root, 'profiles/launch.mjs'), path.join(outputDirectory, 'launch.mjs'));
    if (!serverOnly) await cp(path.join(root, 'app/dist'), path.join(outputDirectory, 'app/dist'), { recursive: true });
    run(process.execPath, [
      path.join(root, 'scripts/build/packaging/profile-build.mjs'), '--profile', profileName, '--verify-deploy', outputDirectory,
    ]);
    if (profileName === 'core') {
      const apiPackage = await realpath(path.join(outputDirectory, 'node_modules/@codexia/api'));
      const runtimeDists = [
        path.join(apiPackage, 'dist'),
        ...await Promise.all(['core', 'contracts', 'module-runtime'].map(async (name) => {
          const packageDirectory = await realpath(path.join(outputDirectory, 'node_modules/.pnpm/node_modules/@codexia', name));
          return path.join(packageDirectory, 'dist');
        })),
        ...(!serverOnly ? [path.join(outputDirectory, 'app/dist')] : []),
      ];
      run(process.execPath, [
        path.join(root, 'scripts/verification/dependencies/audit-runtime.mjs'),
        '--node-modules', path.join(outputDirectory, 'node_modules'),
        '--production',
        ...runtimeDists.flatMap((directory) => ['--dist', directory]),
      ]);
    }
    console.log(`Prepared ${profileName} production package at ${outputDirectory}`);
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Profile packaging failed');
    process.exitCode = 1;
  });
}
