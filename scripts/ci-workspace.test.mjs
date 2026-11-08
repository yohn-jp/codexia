import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { WORKSPACES } from './ci-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(root, 'scripts/ci-workspace.mjs');

function run(args, env = process.env) {
  return spawnSync(process.execPath, [runner, ...args], { cwd: root, env, encoding: 'utf8' });
}

function runProject(projectRoot, args, env = process.env) {
  return spawnSync(process.execPath, [path.join(projectRoot, 'scripts/ci-workspace.mjs'), ...args], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  });
}

async function makeWorkspaceFixture(rootTestScript) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'codexia-ci-workspace-fixture-'));
  await mkdir(path.join(projectRoot, 'scripts'), { recursive: true });
  await copyFile(runner, path.join(projectRoot, 'scripts/ci-workspace.mjs'));
  await copyFile(path.join(root, 'scripts/ci-contract.mjs'), path.join(projectRoot, 'scripts/ci-contract.mjs'));

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

test('coverage maps every workspace test and typecheck scope to an executable target', () => {
  const result = run(['coverage']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /17 workspaces, 18 unit targets, 5 production typecheck groups, 3 test typecheck scopes/u);
  assert.match(result.stdout, /test\/spec files mapped to package scripts/u);
});

test('root unit preparation builds the API dependency closure before invoking root script tests', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codexia-ci-workspace-'));
  const bin = path.join(temporary, 'bin');
  const pnpm = path.join(bin, 'pnpm');
  const record = path.join(temporary, 'pnpm-commands.jsonl');
  await mkdir(bin);
  await writeFile(pnpm, '#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.appendFileSync(process.env.CODEXIA_CI_PNPM_RECORD, JSON.stringify(process.argv.slice(2)) + "\\n");\n');
  await chmod(pnpm, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    CODEXIA_CI_PNPM_RECORD: record,
  };
  try {
    const prepared = run(['prepare', 'unit', 'root'], env);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.match(prepared.stdout, /built API and its declared workspace dependencies/u);

    const executed = run(['unit', 'root'], env);
    assert.equal(executed.status, 0, executed.stderr);
    assert.match(executed.stdout, /using package\.json script test:scripts/u);

    const commands = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(commands, [
      ['--filter', '@codexia/api...', 'build'],
      ['run', 'test:scripts'],
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('grouped unit preparation builds shared dependencies once and retains root API preparation', async () => {
  const fixture = await makeWorkspaceFixture('pnpm run test:scripts');
  try {
    const prepared = runProject(fixture.projectRoot, ['prepare', 'unit-group', 'contracts,persistence-contracts,persistence-postgres,module-runtime,migration,core,api,root'], fixture.env);
    assert.equal(prepared.status, 0, prepared.stderr);
    const commands = (await readFile(fixture.record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const packages = commands.flatMap(command => command.flatMap((arg, index) => arg === '--filter' ? [command[index + 1]] : []));
    assert.equal(new Set(packages).size, packages.length);
    assert.ok(packages.includes('@codexia/contracts'));
    assert.ok(packages.includes('@codexia/core'));
    assert.equal(packages.at(-1), '@codexia/api');
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0].slice(0, 3), ['--recursive', '--sort', '--workspace-concurrency=2']);
    assert.deepEqual(commands[0].slice(-2), ['run', 'build']);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test('speaker unit tests own their worker build while preparation follows workspace dependencies', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codexia-ci-workspace-'));
  const bin = path.join(temporary, 'bin');
  const pnpm = path.join(bin, 'pnpm');
  const record = path.join(temporary, 'pnpm-commands.jsonl');
  await mkdir(bin);
  await writeFile(pnpm, '#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.appendFileSync(process.env.CODEXIA_CI_PNPM_RECORD, JSON.stringify(process.argv.slice(2)) + "\\n");\n');
  await chmod(pnpm, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    CODEXIA_CI_PNPM_RECORD: record,
  };
  try {
    const prepared = run(['prepare', 'unit', 'speaker'], env);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.match(prepared.stdout, /built dependency workspaces/u);

    const executed = run(['unit', 'speaker'], env);
    assert.equal(executed.status, 0, executed.stderr);

    const commands = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const builtPackages = commands.filter(command => command.includes('build')).flatMap(command => command.flatMap((arg, index) => arg === '--filter' ? [command[index + 1]] : []));
    assert.ok(builtPackages.includes('@codexia/module-nlp'));
    assert.ok(builtPackages.includes('@codexia/module-diagnostics'));
    assert.equal(builtPackages.includes('@codexia/module-speaker'), false);
    assert.deepEqual(commands.at(-1), ['--filter', '@codexia/module-speaker', 'run', 'test']);
    const speakerManifest = JSON.parse(await readFile(path.join(root, 'modules/speaker/package.json'), 'utf8'));
    assert.match(speakerManifest.scripts.test, /^pnpm run build && /u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('unit preparation is unchanged when root test orchestration order changes', async () => {
  const rootTestScripts = [
    'pnpm --filter @codexia/module-speaker build && pnpm --filter @codexia/module-speaker test && pnpm --filter @codexia/module-runtime test',
    'pnpm --filter @codexia/module-speaker build && pnpm --filter @codexia/module-runtime test && pnpm --filter @codexia/module-speaker test',
  ];
  const observed = [];
  const fixtures = [];
  try {
    for (const rootTestScript of rootTestScripts) {
      const fixture = await makeWorkspaceFixture(rootTestScript);
      fixtures.push(fixture.projectRoot);
      const prepared = runProject(fixture.projectRoot, ['prepare', 'unit', 'speaker'], fixture.env);
      assert.equal(prepared.status, 0, prepared.stderr);
      const executed = runProject(fixture.projectRoot, ['unit', 'speaker'], fixture.env);
      assert.equal(executed.status, 0, executed.stderr);
      observed.push((await readFile(fixture.record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)));
    }
    assert.deepEqual(observed[0], observed[1]);
    assert.deepEqual(observed[0].at(-1), ['--filter', '@codexia/module-speaker', 'run', 'test']);
  } finally {
    await Promise.all(fixtures.map((fixture) => rm(fixture, { recursive: true, force: true })));
  }
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

    const typecheck = spawnSync(process.execPath, [path.join(root, 'scripts/typecheck-tests.mjs'), 'modules'], {
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
      setTimeout(() => {
        if (process.env.CODEXIA_FAIL_BUILD === id) process.exit(2);
        fs.writeFileSync(path.join(__dirname, id + '.done'), '');
        log('end');
      }, 100);
    `);
    for (const workspace of WORKSPACES) {
      const manifestPath = path.join(fixture.projectRoot, workspace.path, 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.scripts.build = `node ${probe} ${workspace.id}`;
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
    const env = { ...process.env };
    const args = ['prepare', 'unit-group', 'api,root'];
    const success = runProject(fixture.projectRoot, args, env);
    assert.equal(success.status, 0, success.stderr);
    const observed = (await readFile(events, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(observed.some(event => event.id === 'persistence-postgres' && event.event === 'end'));
    let active = 0;
    let maximum = 0;
    for (const event of observed) {
      active += event.event === 'start' ? 1 : -1;
      maximum = Math.max(maximum, active);
    }
    assert.equal(maximum, 2, 'independent builds overlap within the two-workspace limit');
    assert.equal(active, 0);
    for (const workspace of WORKSPACES) await rm(path.join(fixture.projectRoot, `${workspace.id}.done`), { force: true });
    await rm(events);
    const failed = runProject(fixture.projectRoot, args, { ...env, CODEXIA_FAIL_BUILD: 'persistence-contracts' });
    assert.notEqual(failed.status, 0);
    const failureEvents = (await readFile(events, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(failureEvents.some(event => event.id === 'persistence-postgres'), false);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});
