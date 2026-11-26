#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_TYPECHECK_SCOPES, WORKSPACES } from '../impact/contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const compiler = createRequire(import.meta.url).resolve('typescript/package.json');
const tsc = path.join(path.dirname(compiler), 'bin', 'tsc');
const generatedDirectoryNames = new Set(['.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'out', 'target']);
const scopeWorkspaces = new Map([
  ['app-e2e', ['app']],
  ['packages', WORKSPACES.filter(({ path: workspacePath }) => workspacePath.startsWith('packages/')).map(({ id }) => id)],
  ['modules', WORKSPACES.filter(({ path: workspacePath }) => workspacePath.startsWith('modules/')).map(({ id }) => id)],
]);

function assertScopesAreComplete() {
  const declared = [...scopeWorkspaces.keys()].sort();
  const configured = [...TEST_TYPECHECK_SCOPES].sort();
  if (new Set(configured).size !== configured.length || JSON.stringify(configured) !== JSON.stringify(declared)) {
    throw new Error(`Test typecheck scopes do not match executable scopes: declared [${configured.join(', ')}], available [${declared.join(', ')}]`);
  }
  const assigned = [...scopeWorkspaces.values()].flat();
  const duplicate = assigned.find((id, index) => assigned.indexOf(id) !== index);
  const missing = WORKSPACES.map(({ id }) => id).filter((id) => !assigned.includes(id));
  const unknown = assigned.filter((id) => !WORKSPACES.some((workspace) => workspace.id === id));
  if (duplicate || missing.length || unknown.length) {
    throw new Error(`Test typecheck scope coverage is invalid: duplicate=${duplicate ?? 'none'}, missing=[${missing.join(', ')}], unknown=[${unknown.join(', ')}]`);
  }
}

async function listTypeScriptFiles(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && !generatedDirectoryNames.has(entry.name)) await visit(absolute);
      else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) files.push(absolute);
    }
  }
  await visit(directory);
  return files;
}

function isTestFile(filename) {
  return /\.(?:test|spec)\.(?:ts|tsx)$/u.test(filename);
}

function sourceIncludes(directory, configDirectory, files, testFiles) {
  const names = new Set(files.map(filename => path.resolve(configDirectory, filename)));
  const missing = testFiles.filter(filename => !names.has(filename));
  if (missing.length) throw new Error(`TypeScript input omitted test sources for ${directory}: ${missing.map(filename => path.relative(root, filename)).join(', ')}`);
  if (files.length === 0) throw new Error(`Test typecheck selected no TypeScript files in ${directory}`);
}

async function checkDirectory(directory, { configDirectory = directory, include, testFiles }) {
  const workspaceDirectory = path.join(root, configDirectory);
  const configPath = path.join(workspaceDirectory, 'tsconfig.json');
  try {
    await access(configPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Required TypeScript config is missing: ${path.relative(root, configPath)}`);
    throw error;
  }

  // Keep the derived config inside the workspace so native package/type resolution sees its dependencies.
  const temporary = await mkdtemp(path.join(workspaceDirectory, '.ci-test-types-'));
  try {
    const project = path.join(temporary, 'tsconfig.json');
    await writeFile(project, JSON.stringify({
      extends: '../tsconfig.json',
      compilerOptions: {
        noEmit: true,
        composite: false,
        incremental: false,
        declaration: false,
        declarationMap: false,
        rootDir: null,
        outDir: null,
        tsBuildInfoFile: null,
      },
      include: include.map(pattern => `../${pattern}`),
      exclude: [],
    }));

    const args = [tsc, '--project', project, '--pretty', 'false'];
    const shown = spawnSync(process.execPath, [...args, '--showConfig'], { cwd: root, encoding: 'utf8' });
    if (shown.error) throw shown.error;
    if (shown.status !== 0) {
      throw new Error(`Could not parse TypeScript config for ${path.relative(root, configPath)}\n${shown.stdout}${shown.stderr}`);
    }
    const { compilerOptions, files = [] } = JSON.parse(shown.stdout);
    sourceIncludes(directory, temporary, files, testFiles);

    if (!compilerOptions.jsx) args.push('--jsx', 'react-jsx');
    const checked = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    if (checked.error) throw checked.error;
    return { failed: checked.status !== 0, fileCount: files.length, testCount: testFiles.length };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function checkScope(scopeId) {
  assertScopesAreComplete();
  const workspaceIds = scopeWorkspaces.get(scopeId);
  if (!workspaceIds) throw new Error(`Unknown test typecheck scope ${scopeId}; expected one of ${TEST_TYPECHECK_SCOPES.join(', ')}`);

  const selected = workspaceIds.map((id) => WORKSPACES.find((workspace) => workspace.id === id));
  const results = [];
  if (scopeId === 'app-e2e') {
    const appDirectory = path.join(root, 'app');
    const appTests = (await listTypeScriptFiles(appDirectory)).filter(isTestFile);
    results.push(await checkDirectory(
      'app',
      { include: ['src/**/*.ts', 'src/**/*.tsx'], testFiles: appTests },
    ));

    const e2eDirectory = path.join(root, 'tests/e2e');
    const e2eFiles = await listTypeScriptFiles(e2eDirectory);
    const e2eTests = e2eFiles.filter(isTestFile);
    results.push(await checkDirectory(
      'tests/e2e',
      {
        configDirectory: 'app',
        include: ['../tests/e2e/**/*.ts', '../tests/e2e/**/*.tsx'],
        testFiles: e2eTests,
      },
    ));
  } else {
    for (const workspace of selected) {
      const testFiles = (await listTypeScriptFiles(path.join(root, workspace.path))).filter(isTestFile);
      results.push(await checkDirectory(
        workspace.path,
        { include: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts', 'test/**/*.tsx'], testFiles },
      ));
    }
  }

  const failed = results.some(({ failed: resultFailed }) => resultFailed);
  const fileCount = results.reduce((sum, result) => sum + result.fileCount, 0);
  const testCount = results.reduce((sum, result) => sum + result.testCount, 0);
  if (fileCount === 0 || testCount === 0) throw new Error(`Test typecheck scope ${scopeId} was empty (files=${fileCount}, tests=${testCount})`);
  console.log(`Test typecheck ${scopeId}: ${fileCount} TypeScript files, ${testCount} test/spec files, ${failed ? 'FAIL' : 'PASS'}.`);
  if (failed) process.exitCode = 1;
}

const [scopeId, ...extra] = process.argv.slice(2);
if (extra.length) throw new Error('Usage: node scripts/ci/execution/typecheck-tests.mjs [app-e2e|packages|modules]');
// API integration test sources import the app's public HTTP adapter.
if (!scopeId || scopeId === 'app-e2e' || scopeId === 'packages') {
  const generated = spawnSync('pnpm', ['--filter', '@codexia/app', 'run', 'generate:http'], { cwd: root, stdio: 'inherit' });
  if (generated.error) throw generated.error;
  if (generated.status !== 0) throw new Error('HTTP client generation failed before test typecheck');
}
if (scopeId) await checkScope(scopeId);
else {
  for (const scope of TEST_TYPECHECK_SCOPES) await checkScope(scope);
}
