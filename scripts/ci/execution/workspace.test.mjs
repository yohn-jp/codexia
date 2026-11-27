import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { WORKSPACES } from '../impact/contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runner = path.join(root, 'scripts/ci/execution/workspace.mjs');

function run(args, env = process.env) {
  return spawnSync(process.execPath, [runner, ...args], { cwd: root, env, encoding: 'utf8' });
}

function runProject(projectRoot, args, env = process.env) {
  return spawnSync(process.execPath, [path.join(projectRoot, 'scripts/ci/execution/workspace.mjs'), ...args], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  });
}

async function makeWorkspaceFixture(rootTestScript) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'codexia-ci-workspace-fixture-'));
  await mkdir(path.join(projectRoot, 'scripts/ci/execution'), { recursive: true });
  await mkdir(path.join(projectRoot, 'scripts/ci/impact'), { recursive: true });
  await mkdir(path.join(projectRoot, 'scripts/ci/evidence'), { recursive: true });
  await copyFile(path.join(root, 'scripts/ci/evidence/coverage-inputs.mjs'), path.join(projectRoot, 'scripts/ci/evidence/coverage-inputs.mjs'));
  await copyFile(runner, path.join(projectRoot, 'scripts/ci/execution/workspace.mjs'));
  await copyFile(path.join(root, 'scripts/ci/impact/contract.mjs'), path.join(projectRoot, 'scripts/ci/impact/contract.mjs'));
  await copyFile(path.join(root, 'scripts/ci/execution/parallel.mjs'), path.join(projectRoot, 'scripts/ci/execution/parallel.mjs'));

  const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  rootManifest.scripts.test = rootTestScript;
  await writeFile(path.join(projectRoot, 'package.json'), `${JSON.stringify(rootManifest, null, 2)}\n`);
  for (const workspace of WORKSPACES) {
    const manifestPath = path.join(workspace.path, 'package.json');
    const fixturePath = path.join(projectRoot, manifestPath);
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await copyFile(path.join(root, manifestPath), fixturePath);
  }

  const bin = path.join(projectRoot, 'bin');
  const pnpm = path.join(bin, 'pnpm');
  const record = path.join(projectRoot, 'pnpm-commands.jsonl');
  await mkdir(bin);
  await writeFile(pnpm, '#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.appendFileSync(process.env.CODEXIA_CI_PNPM_RECORD, JSON.stringify(process.argv.slice(2)) + "\\n");\n');
  await chmod(pnpm, 0o755);

  return {
    projectRoot,
    record,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      CODEXIA_CI_PNPM_RECORD: record,
    },
  };
}

test('coverage admits the current workspace and rejects a new unmapped package', async t => {
  const result = run(['coverage']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Coverage PASS/u);

  const fixture = await makeWorkspaceFixture('pnpm run test:scripts');
  t.after(() => rm(fixture.projectRoot, { recursive: true, force: true }));
  const init = spawnSync('git', ['init', '-q'], { cwd: fixture.projectRoot });
  assert.equal(init.status, 0, init.stderr?.toString());
  const unknown = path.join(fixture.projectRoot, 'packages/unmapped-fixture');
  await mkdir(unknown);
  await writeFile(path.join(unknown, 'package.json'), JSON.stringify({ name: '@codexia/unmapped-fixture' }));
  const unregistered = runProject(fixture.projectRoot, ['coverage'], fixture.env);
  assert.equal(unregistered.status, 1);
  assert.match(unregistered.stderr, /unregistered=\[packages\/unmapped-fixture\]/u);
});

test('coverage ignores package directories without a workspace manifest', async t => {
  const generated = await mkdtemp(path.join(root, 'packages/ci-coverage-no-manifest-'));
  try {
    const result = run(['coverage']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Coverage PASS/u);
  } finally {
    await rm(generated, { recursive: true, force: true });
  }
});

test('root unit execution delegates to the root script tests', async t => {
  const fixture = await makeWorkspaceFixture('pnpm run test:scripts');
  t.after(() => rm(fixture.projectRoot, { recursive: true, force: true }));
  const executed = runProject(fixture.projectRoot, ['unit', 'root'], fixture.env);
  assert.equal(executed.status, 0, executed.stderr);
  const commands = (await readFile(fixture.record, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(commands, [['run', 'test:scripts']]);
});

test('speaker preparation follows manifest dependencies independently of root test order', async t => {
  const rootTestScripts = [
    'pnpm --filter @codexia/module-speaker build && pnpm --filter @codexia/module-speaker test && pnpm --filter @codexia/module-runtime test',
    'pnpm --filter @codexia/module-speaker build && pnpm --filter @codexia/module-runtime test && pnpm --filter @codexia/module-speaker test',
  ];
  const observed = [];
  for (const rootTestScript of rootTestScripts) {
    const fixture = await makeWorkspaceFixture(rootTestScript);
    t.after(() => rm(fixture.projectRoot, { recursive: true, force: true }));
    const reportPath = path.join(fixture.projectRoot, 'prepare.json');
    const prepared = runProject(fixture.projectRoot, ['prepare', 'selected-group', reportPath], {
      ...fixture.env, CODEXIA_CI_GROUP_TASKS: '["unit-speaker"]', CODEXIA_CI_CONCURRENCY: '1',
    });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), [{ task: 'unit-speaker', exclusive: false }]);
    const executed = runProject(fixture.projectRoot, ['unit', 'speaker'], fixture.env);
    assert.equal(executed.status, 0, executed.stderr);
    observed.push((await readFile(fixture.record, 'utf8')).trim().split('\n').map(JSON.parse));
  }
  assert.deepEqual(observed[0], observed[1]);
  const commands = observed[0];
  const builtPackages = commands.filter(command => command.at(-1) === 'build').map(command => command[1]);
  assert.ok(builtPackages.includes('@codexia/module-nlp'));
  assert.ok(builtPackages.includes('@codexia/module-diagnostics'));
  assert.equal(builtPackages.includes('@codexia/module-speaker'), false);
  assert.deepEqual(commands.at(-1), ['--filter', '@codexia/module-speaker', 'run', 'test']);
  const speakerManifest = JSON.parse(await readFile(path.join(root, 'modules/speaker/package.json'), 'utf8'));
  assert.match(speakerManifest.scripts.test, /^pnpm run build && /u);
});

test('coverage and test typecheck reject TypeScript tests outside workspace src', async () => {
  const fixture = await mkdtemp(path.join(root, 'modules/speaker/.ci-coverage-probe-'));
  const source = path.join(fixture, 'unregistered.test.ts');
  await writeFile(source, 'export const coverageProbe: string = "unregistered";\n');
  try {
    const coverage = run(['coverage']);
    assert.notEqual(coverage.status, 0, coverage.stdout);
    assert.match(`${coverage.stdout}\n${coverage.stderr}`, /Unit target speaker does not execute these test files/u);
    assert.match(`${coverage.stdout}\n${coverage.stderr}`, /unregistered\.test\.ts/u);

    const typecheck = spawnSync(process.execPath, [path.join(root, 'scripts/ci/execution/typecheck-tests.mjs'), 'modules'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(typecheck.status, 0, typecheck.stdout);
    assert.match(`${typecheck.stdout}\n${typecheck.stderr}`, /TypeScript input omitted test sources for modules\/speaker/u);
    assert.match(`${typecheck.stdout}\n${typecheck.stderr}`, /unregistered\.test\.ts/u);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('real workspace preparation overlaps independent builds and blocks dependents after failure', async () => {
  const fixture = await makeWorkspaceFixture('pnpm run test:scripts');
  try {
    await copyFile(path.join(root, 'pnpm-workspace.yaml'), path.join(fixture.projectRoot, 'pnpm-workspace.yaml'));
    const probe = path.join(fixture.projectRoot, 'probe.cjs');
    const events = path.join(fixture.projectRoot, 'events.jsonl');
    await writeFile(probe, `
      const fs = require('node:fs');
      const path = require('node:path');
      const id = process.argv[2];
      const log = event => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({id, event}) + '\\n');
      log('start');
      if (id === 'persistence-postgres' && !fs.existsSync(path.join(__dirname, 'persistence-contracts.done'))) process.exit(3);
      const independent = ['contracts', 'persistence-contracts'];
      const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
      async function waitForIndependentPeer() {
        if (!independent.includes(id)) return;
        fs.writeFileSync(path.join(__dirname, id + '.started'), '');
        const timeoutMs = 10000;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (independent.every(peer => fs.existsSync(path.join(__dirname, peer + '.started')))) {
            log('barrier-release');
            return;
          }
          await pause(10);
        }
        const message = 'Timed out waiting for independent builds ' + independent.join(' and ') + ' within ' + timeoutMs + 'ms';
        log('barrier-timeout');
        process.stderr.write(message + '\\n');
        process.exit(4);
      }
      waitForIndependentPeer().then(() => {
        if (process.env.CODEXIA_FAIL_BUILD === id) process.exit(2);
        fs.writeFileSync(path.join(__dirname, id + '.done'), '');
        log('end');
      });
    `);
    // Prevent pnpm's automatic install from delaying the fake builds in this isolated workspace.
    await mkdir(path.join(fixture.projectRoot, 'node_modules'));
    for (const workspace of WORKSPACES) {
      await mkdir(path.join(fixture.projectRoot, workspace.path, 'node_modules'), { recursive: true });
      const manifestPath = path.join(fixture.projectRoot, workspace.path, 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.scripts.build = `node ${probe} ${workspace.id}`;
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
    const tasks = ['unit-api', 'unit-root', 'unit-contracts'];
    const reportPath = path.join(fixture.projectRoot, 'prepare.json');
    const env = { ...process.env, CODEXIA_CI_GROUP_TASKS: JSON.stringify(tasks), CODEXIA_CI_CONCURRENCY: '2' };
    const args = ['prepare', 'selected-group', reportPath];
    const success = runProject(fixture.projectRoot, args, env);
    assert.equal(success.status, 0, success.stderr);
    const successReport = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.deepEqual(successReport.map(entry => entry.task), tasks);
    const observedLines = (await readFile(events, 'utf8')).trim().split('\n');
    assert.ok(successReport.every(entry => !entry.error), `${JSON.stringify(successReport)}\n${success.stdout}\n${success.stderr}\n${observedLines.join('\n')}`);
    const observed = observedLines.map(JSON.parse);
    const started = observed.filter(event => event.event === 'start').map(event => event.id);
    assert.equal(new Set(started).size, started.length, 'tasks share a single build per workspace');
    assert.ok(observed.some(event => event.id === 'api' && event.event === 'end'), 'root tests prepare the API');
    assert.ok(observed.some(event => event.id === 'persistence-postgres' && event.event === 'end'));
    assert.equal(observed.filter(event => event.event === 'barrier-release').length, 2, 'the independent-build barrier releases only after both peers start');
    let active = 0;
    let maximum = 0;
    for (const event of observed) {
      if (event.event === 'start') active += 1;
      if (event.event === 'end') active -= 1;
      maximum = Math.max(maximum, active);
    }
    assert.equal(maximum, 2, 'independent builds overlap within the two-workspace limit');
    assert.equal(active, 0);
    for (const workspace of WORKSPACES) await rm(path.join(fixture.projectRoot, `${workspace.id}.done`), { force: true });
    for (const id of ['contracts', 'persistence-contracts']) await rm(path.join(fixture.projectRoot, `${id}.started`), { force: true });
    await rm(events);
    const failed = runProject(fixture.projectRoot, args, { ...env, CODEXIA_FAIL_BUILD: 'persistence-contracts' });
    assert.equal(failed.status, 0, failed.stderr);
    const failureReport = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.deepEqual(failureReport.map(entry => entry.task), tasks);
    assert.match(failureReport[0].error, /persistence-contracts/u);
    assert.match(failureReport[1].error, /persistence-contracts/u);
    assert.equal(failureReport[2].error, undefined);
    const failureEvents = (await readFile(events, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(failureEvents.some(event => event.id === 'persistence-postgres'), false);
    await rm(events);
    const databaseTasks = ['db-contract'];
    const databaseEnv = { ...env, CODEXIA_CI_GROUP_TASKS: JSON.stringify(databaseTasks) };
    const databasePreparation = runProject(fixture.projectRoot, args, databaseEnv);
    assert.equal(databasePreparation.status, 0, databasePreparation.stderr);
    const databaseReport = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.deepEqual(databaseReport.map(entry => entry.task), databaseTasks);
    assert.equal(databaseReport[0].error, undefined);
    const databaseEvents = (await readFile(events, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(databaseEvents.some(event => event.id === 'api' && event.event === 'end'));
    assert.ok(databaseEvents.some(event => event.id === 'persistence-postgres' && event.event === 'end'));
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('pre-profile builds cover the pnpm workspaces needed before building API and UI', async () => {
  const fixture = await makeWorkspaceFixture('pnpm run test:scripts');
  try {
    const result = runProject(fixture.projectRoot, ['build-workspace'], fixture.env);
    assert.equal(result.status, 0, result.stderr);
    const commands = (await readFile(fixture.record, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(commands.length, 1);
    const filters = commands[0].flatMap((arg, index) => arg === '--filter' ? [commands[0][index + 1]] : []);
    const installed = spawnSync('pnpm', ['list', '--recursive', '--depth=-1', '--json'], { cwd: root, encoding: 'utf8' });
    assert.ifError(installed.error);
    assert.equal(installed.status, 0, installed.stderr);
    const expected = JSON.parse(installed.stdout).filter(({ name, path: workspacePath }) =>
      name !== '@codexia/api' && ['packages', 'modules'].includes(path.relative(root, workspacePath).split(path.sep)[0]))
      .map(({ name }) => name);
    assert.deepEqual(filters.sort(), expected.sort());
    assert.deepEqual(commands[0].slice(0, 3), ['--recursive', '--sort', '--workspace-concurrency=2']);
    assert.deepEqual(commands[0].slice(-2), ['run', 'build']);
  } finally { await rm(fixture.projectRoot, { recursive: true, force: true }); }
});

test('local module test typecheck builds its workspace declarations before invoking the scoped checker', async t => {
  const fixture = await makeWorkspaceFixture('pnpm run test:scripts');
  t.after(() => rm(fixture.projectRoot, { recursive: true, force: true }));
  await writeFile(path.join(fixture.projectRoot, 'scripts/ci/execution/typecheck-tests.mjs'), `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    assert.deepEqual(process.argv.slice(2), ['modules']);
    const build = JSON.parse(readFileSync(process.env.CODEXIA_CI_PNPM_RECORD, 'utf8'));
    assert.equal(build.at(-1), 'build');
    assert.ok(build.includes('@codexia/module-nlp'));
    assert.ok(!build.includes('@codexia/api'));
  `);
  const result = spawnSync(process.execPath, ['--run', 'typecheck:tests', '--', 'modules'], {
    cwd: fixture.projectRoot, env: fixture.env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('root typecheck shares completed compiler builds and runs distinct checks', async t => {
  const fixture = await makeWorkspaceFixture('pnpm run test:scripts');
  t.after(() => rm(fixture.projectRoot, { recursive: true, force: true }));
  for (const [workspace, change] of [
    ['packages/contracts', { build: 'tsc -p tsconfig.json', typecheck: 'tsc -p tsconfig.json --noEmit' }],
    ['modules/search', { typecheck: 'tsc -p tsconfig.strict.json --noEmit' }],
    ['packages/module-runtime', { posttypecheck: 'node check-runtime.mjs' }],
  ]) {
    const manifestPath = path.join(fixture.projectRoot, workspace, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    Object.assign(manifest.scripts, change);
    await writeFile(manifestPath, JSON.stringify(manifest));
  }

  const result = runProject(fixture.projectRoot, ['typecheck'], fixture.env);
  assert.equal(result.status, 0, result.stderr);
  const commands = (await readFile(fixture.record, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(commands.map(command => command.at(-1)), ['build', 'typecheck']);
  const [build, typecheck] = commands.map(command =>
    new Set(command.flatMap((arg, index) => arg === '--filter' ? [command[index + 1]] : [])));
  for (const { path: workspacePath } of WORKSPACES) {
    const { name } = JSON.parse(await readFile(path.join(fixture.projectRoot, workspacePath, 'package.json'), 'utf8'));
    assert.ok(build.has(name) || typecheck.has(name), `Missing production check for ${name}`);
  }
  assert.ok(build.has('@codexia/contracts') && !typecheck.has('@codexia/contracts'));
  for (const name of ['@codexia/module-search', '@codexia/module-runtime']) {
    assert.ok(typecheck.has(name), `A distinct compiler command or lifecycle hook must run for ${name}`);
  }
  for (const name of ['@codexia/api', '@codexia/app']) assert.ok(!build.has(name) && typecheck.has(name));
});
