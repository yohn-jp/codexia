import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { resolveBaseCommit, selectBaseReference } from '../scripts/base-reference.mjs';
import { resolveOasdiffBinary } from '../scripts/oasdiff.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('oasdiff uses the immutable approved SHA from a pull request event', t => {
  const eventDirectory = mkdtempSync(path.join(os.tmpdir(), 'codexia-oasdiff-event-'));
  t.after(() => rmSync(eventDirectory, { recursive: true, force: true }));
  const eventPath = path.join(eventDirectory, 'event.json');
  const approvedSha = '9809fccf60fabd04aeb9dbc232defc8c3f079413';
  writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: approvedSha } } }));

  assert.equal(
    selectBaseReference({
      CODEXIA_OASDIFF_BASE_REF: undefined,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_BASE_REF: 'mutable-branch-name',
    }),
    approvedSha,
  );
});

test('oasdiff push runs use the immutable before SHA', t => {
  const eventDirectory = mkdtempSync(path.join(os.tmpdir(), 'codexia-oasdiff-push-event-'));
  t.after(() => rmSync(eventDirectory, { recursive: true, force: true }));
  const eventPath = path.join(eventDirectory, 'event.json');
  const beforeSha = '79e401bea8aab899ca571079711d591ed16907db';
  writeFileSync(eventPath, JSON.stringify({ before: beforeSha }));

  assert.equal(selectBaseReference({ GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: eventPath }), beforeSha);
});

test('oasdiff fails closed for a push event without a valid before SHA', t => {
  const eventDirectory = mkdtempSync(path.join(os.tmpdir(), 'codexia-oasdiff-push-invalid-'));
  t.after(() => rmSync(eventDirectory, { recursive: true, force: true }));
  const eventPath = path.join(eventDirectory, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ before: '0'.repeat(40) }));

  assert.throws(() => selectBaseReference({ GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: eventPath }), /invalid push before SHA/u);
});

test('oasdiff fetches an absent approved SHA in a disposable shallow clone', t => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'codexia-oasdiff-shallow-'));
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
  const source = path.join(temporaryDirectory, 'source');
  const remote = path.join(temporaryDirectory, 'remote.git');
  const shallow = path.join(temporaryDirectory, 'shallow');
  mkdirSync(source);

  const runIn = cwd => args => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const sourceGit = runIn(source);
  const mustSucceed = result => assert.equal(result.status, 0, result.stderr);
  mustSucceed(sourceGit(['init', '-b', 'main']));
  mustSucceed(
    sourceGit([
      '-c',
      'user.name=Contract Test',
      '-c',
      'user.email=contract@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'approved base',
    ]),
  );
  const baseSha = sourceGit(['rev-parse', 'HEAD']).stdout.trim();
  mustSucceed(
    sourceGit([
      '-c',
      'user.name=Contract Test',
      '-c',
      'user.email=contract@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'feature head',
    ]),
  );
  mustSucceed(spawnSync('git', ['clone', '--bare', source, remote], { encoding: 'utf8' }));
  mustSucceed(spawnSync('git', ['clone', '--depth=1', `file://${remote}`, shallow], { encoding: 'utf8' }));

  const shallowGit = runIn(shallow);
  assert.notEqual(shallowGit(['cat-file', '-e', `${baseSha}^{commit}`]).status, 0, 'base should be absent from depth-one checkout');
  assert.equal(resolveBaseCommit(baseSha, shallowGit), baseSha);
  assert.equal(shallowGit(['cat-file', '-e', `${baseSha}^{commit}`]).status, 0, 'approved base should be fetched');
});

test('oasdiff manual runs use approved main instead of the previous feature commit', () => {
  assert.equal(
    selectBaseReference({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF_NAME: 'codex/654-g1-contract',
    }),
    'origin/main',
  );
});

test('oasdiff fails closed when a pull request event has no valid base SHA', t => {
  const eventDirectory = mkdtempSync(path.join(os.tmpdir(), 'codexia-oasdiff-event-invalid-'));
  t.after(() => rmSync(eventDirectory, { recursive: true, force: true }));
  const eventPath = path.join(eventDirectory, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: 'main' } } }));

  assert.throws(
    () =>
      selectBaseReference({
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
      }),
    /invalid pull request base SHA/u,
  );
});

test('oasdiff allows an explicit local base override', () => {
  assert.equal(
    selectBaseReference({
      CODEXIA_OASDIFF_BASE_REF: '7e'.repeat(20),
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF_NAME: 'codex/654-g1-contract',
    }),
    '7e'.repeat(20),
  );
});

test('pinned oasdiff flags a deliberately breaking response schema', async () => {
  const binary = await resolveOasdiffBinary();
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /1\.39\.0/u);

  const result = spawnSync(
    binary,
    [
      'breaking',
      path.join(packageRoot, 'test', 'fixtures', 'oasdiff-base.openapi.yaml'),
      path.join(packageRoot, 'test', 'fixtures', 'oasdiff-breaking.openapi.yaml'),
      '--allow-external-refs=false',
      '--fail-on',
      'ERR',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /breaking/u);
});

test('oasdiff rejects a newly required property within the same API epoch', async t => {
  const binary = await resolveOasdiffBinary();
  const basePath = path.join(packageRoot, 'openapi', 'codexia.openapi.yaml');
  const candidateDirectory = mkdtempSync(path.join(os.tmpdir(), 'codexia-oasdiff-required-version-'));
  t.after(() => rmSync(candidateDirectory, { recursive: true, force: true }));
  const candidatePath = path.join(candidateDirectory, 'candidate.openapi.yaml');
  const candidate = parse(readFileSync(basePath, 'utf8'));
  const deleteOperation = candidate.paths['/api/v1/persistence/projects/{projectId}/documents/{documentId}'].delete;
  const requestSchema = deleteOperation.requestBody.content['application/json'].schema;
  assert.equal(requestSchema.$ref, '#/components/schemas/PersistenceDocumentDeleteRequest');
  const deleteRequestSchema = candidate.components.schemas.PersistenceDocumentDeleteRequest;
  const existingRequired = deleteRequestSchema.required ?? [];
  assert.ok(existingRequired.includes('expectedVersion'), 'the repaired OpenAPI requires the runtime version');
  deleteRequestSchema.properties.additionalVersion = { type: 'integer' };
  deleteRequestSchema.required = [...existingRequired, 'additionalVersion'];
  writeFileSync(candidatePath, stringify(candidate));

  const result = spawnSync(binary, ['breaking', basePath, candidatePath, '--allow-external-refs=false', '--fail-on', 'ERR'], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /new-required-request-property|request-property-became-required/u);
});
