#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedHttpOutputs } from '../evidence/coverage-inputs.mjs';
import { runDependencyBuilds } from './parallel.mjs';
import { CONFORMANCE_TASKS, TEST_TYPECHECK_SCOPES, TYPECHECK_TARGETS, UNIT_TARGETS, WORKSPACES } from '../impact/contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const generatedDirectoryNames = new Set(['.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'out', 'target']);
const workspaceById = new Map(WORKSPACES.map((workspace) => [workspace.id, workspace]));
const workspaceByName = new Map();
const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const packageManifests = new Map();

for (const workspace of WORKSPACES) {
  const manifestPath = path.join(root, workspace.path, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest.name || workspaceByName.has(manifest.name)) throw new Error(`Workspace package name is missing or duplicated at ${workspace.path}`);
  workspaceByName.set(manifest.name, workspace.id);
  packageManifests.set(workspace.id, manifest);
}

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd = root) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.signal) throw new Error(`${command} was terminated by ${result.signal}`);
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function dependenciesOf(id) {
  const manifest = packageManifests.get(id);
  const dependencies = new Set();
  for (const section of ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      const dependencyId = workspaceByName.get(name);
      if (dependencyId) dependencies.add(dependencyId);
    }
  }
  return [...dependencies];
}

function buildDependencies(ids) {
  const required = new Set();
  const scanned = new Set();
  const activeScan = new Set();
  function collect(id) {
    if (activeScan.has(id)) throw new Error(`Workspace build dependency cycle includes ${id}`);
    if (scanned.has(id)) return;
    activeScan.add(id);
    for (const dependencyId of dependenciesOf(id)) {
      required.add(dependencyId);
      collect(dependencyId);
    }
    activeScan.delete(id);
    scanned.add(id);
  }
  for (const id of ids) collect(id);

  const ordered = [];
  const built = new Set();
  const activeBuild = new Set();
  function order(id) {
    if (built.has(id)) return;
    if (activeBuild.has(id)) throw new Error(`Workspace build dependency cycle includes ${id}`);
    activeBuild.add(id);
    for (const dependencyId of dependenciesOf(id)) {
      if (required.has(dependencyId)) order(dependencyId);
    }
    activeBuild.delete(id);
    built.add(id);
    ordered.push(id);
  }
  for (const id of required) order(id);
  return ordered;
}

function runWorkspaceScript(targets, script) {
  for (const id of targets) {
    const manifest = packageManifests.get(id);
    if (!manifest.scripts?.[script]) fail(`Workspace ${manifest.name} has no ${script} script`);
  }
  if (targets.length === 0) return;
  // pnpm schedules only the selected closure, respecting workspace dependency edges.
  run('pnpm', ['--recursive', '--sort', '--workspace-concurrency=2',
    ...targets.flatMap(id => ['--filter', packageManifests.get(id).name]), 'run', script]);
}

function getUnitTarget(targetId) {
  const target = UNIT_TARGETS.find(({ id }) => id === targetId);
  if (!target) fail(`Unknown unit target ${targetId}; expected one of ${UNIT_TARGETS.map(({ id }) => id).join(', ')}`);
  return target;
}

function getTypecheckTarget(targetId) {
  const target = TYPECHECK_TARGETS.find(({ id }) => id === targetId);
  if (!target) fail(`Unknown production typecheck target ${targetId}; expected one of ${TYPECHECK_TARGETS.map(({ id }) => id).join(', ')}`);
  return target;
}

async function runUnit(targetId) {
  const target = getUnitTarget(targetId);
  if (target.path === '.') {
    if (target.id !== 'root' || !rootManifest.scripts?.['test:scripts']) fail('Root unit target requires package.json scripts.test:scripts');
    if (!rootManifest.scripts.test?.includes('pnpm run test:scripts')) fail('Root pnpm test must include the scripts test target');
    console.log('Unit target root: using package.json script test:scripts');
    run('pnpm', ['run', 'test:scripts']);
    return;
  }
  const workspace = WORKSPACES.find(({ id, path: workspacePath }) => id === target.id && workspacePath === target.path);
  if (!workspace) fail(`Unit target ${targetId} does not match a canonical workspace path`);
  const manifest = packageManifests.get(workspace.id);
  if (!manifest.scripts?.test) fail(`Workspace unit target ${targetId} has no package.json test script`);
  run('pnpm', ['--filter', manifest.name, 'run', 'test']);
}

function typecheckWorkspaceIds(targetId) {
  const target = getTypecheckTarget(targetId);
  const ids = target.workspaces;
  const invalid = ids.filter((id) => !workspaceById.has(id));
  if (invalid.length) fail(`Production typecheck target ${targetId} has unknown workspaces: ${invalid.join(', ')}`);
  return ids;
}

async function runTypecheck(targetId) {
  const ids = typecheckWorkspaceIds(targetId);
  for (const id of ids) {
    const manifest = packageManifests.get(id);
    if (manifest.scripts?.typecheck) run('pnpm', ['--filter', manifest.name, 'run', 'typecheck']);
    else if (manifest.scripts?.build) run('pnpm', ['--filter', manifest.name, 'run', 'build']);
    else fail(`Workspace ${manifest.name} has neither typecheck nor build script`);
  }
}

function testTypecheckWorkspaceIds(scope) {
  if (!TEST_TYPECHECK_SCOPES.includes(scope)) fail(`Unknown test typecheck scope ${scope}; expected one of ${TEST_TYPECHECK_SCOPES.join(', ')}`);
  return scope === 'app-e2e'
    ? ['app', 'api']
    : WORKSPACES.filter(({ path: workspacePath }) => scope === 'packages'
      ? workspacePath.startsWith('packages/')
      : workspacePath.startsWith('modules/')).map(({ id }) => id);
}

async function runTestTypecheck(scope) {
  testTypecheckWorkspaceIds(scope);
  run(process.execPath, ['scripts/ci/execution/typecheck-tests.mjs', scope]);
}


function buildWorkspace() {
  // Build the same 15 pre-profile packages as build:workspace, not profiles or the UI.
  const targets = WORKSPACES.filter(({ id }) => id !== 'app' && id !== 'api').map(({ id }) => id);
  runWorkspaceScript(targets, 'build');
  return targets;
}

function typecheckWorkspace() {
  const built = new Set(buildWorkspace());
  const remaining = WORKSPACES.filter(({ id }) => {
    const { scripts } = packageManifests.get(id);
    // Only a successful plain tsc invocation covers the same project checked with --noEmit.
    const checkedByBuild = built.has(id) && scripts.build === 'tsc -p tsconfig.json' &&
      scripts.typecheck === 'tsc -p tsconfig.json --noEmit' &&
      !scripts.postbuild && !scripts.pretypecheck && !scripts.posttypecheck;
    return !checkedByBuild;
  });
  runWorkspaceScript(remaining.map(({ id }) => id), 'typecheck');
}

function prerequisiteIds(task) {
  if (task === 'coverage') return [];
  if (task === 'db-contract' || Object.hasOwn(CONFORMANCE_TASKS, task)) return [...buildDependencies(['api']), 'api'];
  if (task.startsWith('unit-')) {
    const id = getUnitTarget(task.slice(5)).id;
    return id === 'root' ? [...buildDependencies(['api']), 'api'] : buildDependencies([id]);
  }
  if (task === 'safety' || task === 'test-types-app-e2e') {
    if (rootManifest.devDependencies?.['@codexia/api'] !== 'workspace:*') fail('API workspace dependency is required');
    return [...buildDependencies(['api']), 'api'];
  }
  if (task.startsWith('typecheck-')) return buildDependencies(typecheckWorkspaceIds(task.slice(10)));
  if (task.startsWith('test-types-')) return buildDependencies(testTypecheckWorkspaceIds(task.slice(11)));
  fail('Unknown type task ' + task);
}

async function prepareSelectedGroup(filename) {
  const tasks = JSON.parse(process.env.CODEXIA_CI_GROUP_TASKS ?? 'null');
  if (!Array.isArray(tasks) || !tasks.length || new Set(tasks).size !== tasks.length) fail('Invalid group task selection');
  const requirements = new Map(tasks.map(task => [task, prerequisiteIds(task)]));
  const targets = [...new Set([...requirements.values()].flat())];
  const build = async id => {
    const manifest = packageManifests.get(id);
    if (!manifest.scripts?.build) fail('Missing dependency build for ' + id);
    await new Promise((resolve, reject) => {
      console.log('$ pnpm --filter ' + manifest.name + ' run build');
      const child = spawn('pnpm', ['--filter', manifest.name, 'run', 'build'], { cwd: root, stdio: 'inherit', env: process.env });
      child.once('error', reject);
      child.once('close', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error('Build failed: ' + id + ' (' + (signal ?? code) + ')')));
    });
  };
  const limit = Number(process.env.CODEXIA_CI_CONCURRENCY ?? '2');
  const builds = await runDependencyBuilds(targets, dependenciesOf, build, limit);
  // These checks now materialize HTTP sources in the shared checkout before tsc.
  const httpWriters = new Set(['typecheck-app', 'typecheck-core-api', 'safety', 'test-types-app-e2e', 'test-types-packages']);
  const report = tasks.map(task => {
    const missing = requirements.get(task).filter(id => builds.get(id)?.status !== 'passed');
    const exclusive = httpWriters.has(task) ||
      (task.startsWith('typecheck-') && typecheckWorkspaceIds(task.slice(10)).some(id => !packageManifests.get(id).scripts?.typecheck));
    return { task, exclusive, ...(missing.length ? { error: 'Failed workspace prerequisites: ' + missing.join(', ') } : {}) };
  });
  await writeFile(filename, JSON.stringify(report));
}

async function listFiles(directory, { excludeGenerated = true } = {}) {
  const files = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && (!excludeGenerated || !generatedDirectoryNames.has(entry.name))) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await visit(directory);
  return files;
}

function normalizePath(value) {
  return value.split(path.sep).join('/').replace(/^\.\//u, '');
}

function testFilePattern(pattern, relativePath) {
  return path.posix.matchesGlob(relativePath, pattern);
}

function sourcePatternFromRunnerPattern(pattern) {
  const normalized = normalizePath(pattern);
  if (!normalized.startsWith('dist/')) return normalized;
  return normalized.replace(/^dist\//u, 'src/').replace(/\.js$/u, '.ts');
}

function runnerPatterns(script, label) {
  const segments = script.split(/\s*&&\s*/u).filter((part) => part.includes('--test'));
  if (segments.length === 0) fail(`${label} has no Node test runner command`);
  const patterns = segments.flatMap((segment) => {
    const tokens = segment.slice(segment.indexOf('--test') + '--test'.length).trim().split(/\s+/u).filter(Boolean);
    return tokens.map((token) => token.replace(/^['"]|['"]$/gu, '')).filter((token) => !token.startsWith('--'));
  });
  if (patterns.length === 0) fail(`${label} has no explicit test file pattern`);
  return patterns.map(sourcePatternFromRunnerPattern);
}

function isUnitTestFile(filename) {
  return /\.(?:test|spec)\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx)$/u.test(filename);
}

async function assertTestPatterns({ label, script, files, relativeTo }) {
  const patterns = runnerPatterns(script, label);
  const relativeFiles = files.map((filename) => normalizePath(path.relative(relativeTo, filename)));
  const missing = relativeFiles.filter((filename) => !patterns.some((pattern) => testFilePattern(pattern, filename)));
  if (missing.length) fail(`${label} does not execute these test files: ${missing.join(', ')}`);
  if (relativeFiles.length === 0) fail(`${label} has no test files`);
  return relativeFiles.length;
}

function assertUnique(values, label) {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate) fail(`${label} contains duplicate ${duplicate}`);
}

async function checkCoverage() {
  const committed = trackedHttpOutputs(root);
  if (committed.length) fail('HTTP contract build outputs must be untracked: ' + committed.join(', '));
  const actualWorkspacePaths = ['app'];
  for (const area of ['packages', 'modules']) {
    const entries = await readdir(path.join(root, area), { withFileTypes: true });
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      const packageEntries = await readdir(path.join(root, area, entry.name));
      if (packageEntries.includes('package.json')) actualWorkspacePaths.push(`${area}/${entry.name}`);
    }
  }
  const declaredPaths = WORKSPACES.map(({ path: workspacePath }) => workspacePath);
  const missingTargets = actualWorkspacePaths.filter((workspacePath) => !declaredPaths.includes(workspacePath));
  const unknownTargets = declaredPaths.filter((workspacePath) => !actualWorkspacePaths.includes(workspacePath));
  assertUnique(declaredPaths, 'WORKSPACES');
  if (missingTargets.length || unknownTargets.length) {
    fail(`Workspace manifest coverage mismatch: unregistered=[${missingTargets.join(', ')}], missing=[${unknownTargets.join(', ')}]`);
  }

  const unitIds = UNIT_TARGETS.map(({ id }) => id);
  const unitPaths = UNIT_TARGETS.map(({ path: workspacePath }) => workspacePath);
  assertUnique(unitIds, 'UNIT_TARGETS ids');
  assertUnique(unitPaths, 'UNIT_TARGETS paths');
  if (unitPaths.length !== declaredPaths.length + 1 || !unitPaths.includes('.')) fail('UNIT_TARGETS must cover every workspace exactly once and include the root scripts target');
  for (const workspace of WORKSPACES) {
    const target = UNIT_TARGETS.find(({ id, path: workspacePath }) => id === workspace.id && workspacePath === workspace.path);
    if (!target) fail(`UNIT_TARGETS has no path-matched target for ${workspace.id} (${workspace.path})`);
    const manifest = packageManifests.get(workspace.id);
    if (!manifest.scripts?.test) fail(`Workspace ${workspace.id} lacks package.json scripts.test`);
  }
  const rootTarget = UNIT_TARGETS.find(({ id, path: workspacePath }) => id === 'root' && workspacePath === '.');
  if (!rootTarget || !rootManifest.scripts?.['test:scripts'] || !rootManifest.scripts.test?.includes('pnpm run test:scripts')) {
    fail('The root unit target must use package.json scripts.test:scripts and remain part of pnpm test');
  }

  const typecheckedIds = TYPECHECK_TARGETS.flatMap(({ workspaces }) => workspaces);
  assertUnique(TYPECHECK_TARGETS.map(({ id }) => id), 'TYPECHECK_TARGETS ids');
  assertUnique(typecheckedIds, 'TYPECHECK_TARGETS workspace membership');
  const missingTypechecks = WORKSPACES.map(({ id }) => id).filter((id) => !typecheckedIds.includes(id));
  const unknownTypechecks = typecheckedIds.filter((id) => !workspaceById.has(id));
  if (missingTypechecks.length || unknownTypechecks.length) {
    fail(`Production typecheck coverage mismatch: missing=[${missingTypechecks.join(', ')}], unknown=[${unknownTypechecks.join(', ')}]`);
  }
  assertUnique(TEST_TYPECHECK_SCOPES, 'TEST_TYPECHECK_SCOPES');
  if (JSON.stringify([...TEST_TYPECHECK_SCOPES].sort()) !== JSON.stringify(['app-e2e', 'modules', 'packages'])) {
    fail(`Unexpected test typecheck scopes: ${TEST_TYPECHECK_SCOPES.join(', ')}`);
  }

  let testFiles = 0;
  for (const target of UNIT_TARGETS) {
    const packageRoot = path.join(root, target.path);
    const manifest = target.path === '.' ? rootManifest : packageManifests.get(target.id);
    const testScript = target.path === '.' ? manifest.scripts?.['test:scripts'] : manifest.scripts?.test;
    if (!testScript) fail(`Unit target ${target.id} has no package.json test script`);
    const testDirectory = path.join(packageRoot, target.path === '.' ? 'scripts' : '.');
    const selectedFiles = (await listFiles(testDirectory)).filter(isUnitTestFile);
    testFiles += await assertTestPatterns({
      label: `Unit target ${target.id}`,
      script: testScript,
      files: selectedFiles,
      relativeTo: packageRoot,
    });
  }

  console.log(`Coverage PASS: ${WORKSPACES.length} workspaces, ${UNIT_TARGETS.length} unit targets, ${TYPECHECK_TARGETS.length} production typecheck groups, ${TEST_TYPECHECK_SCOPES.length} test typecheck scopes, ${testFiles} test/spec files mapped to package scripts.`);
}

const [command, targetId, scopeOrTarget, ...extra] = process.argv.slice(2);
const usage = 'Usage: node scripts/ci/execution/workspace.mjs <build-workspace|prepare selected-group <report>|unit <target>|typecheck [target]|test-types <scope>|coverage>';
if (extra.length || !command) fail(usage);
if (command === 'build-workspace' && !targetId) buildWorkspace();
else if (command === 'prepare' && targetId === 'selected-group' && scopeOrTarget) await prepareSelectedGroup(scopeOrTarget);
else if (command === 'unit' && targetId && !scopeOrTarget) await runUnit(targetId);
else if (command === 'typecheck' && !targetId) typecheckWorkspace();
else if (command === 'typecheck' && targetId && !scopeOrTarget) await runTypecheck(targetId);
else if (command === 'test-types' && targetId && !scopeOrTarget) await runTestTypecheck(targetId);
else if (command === 'coverage' && !targetId && !scopeOrTarget) await checkCoverage();
else fail(usage);
