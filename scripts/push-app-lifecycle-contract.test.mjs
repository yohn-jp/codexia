import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { publicError, readExactBackendProducerArtifacts } from './push-app-lifecycle.mjs';

const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('../.github/workflows/push-app-lifecycle.yml', import.meta.url), 'utf8'));
const backendWorkflow = parse(readFileSync(new URL('../.github/workflows/backend-release.yml', import.meta.url), 'utf8'));
const site = parse(readFileSync(new URL('../deploy/ansible/site.yml', import.meta.url), 'utf8'))[0];
const deploy = parse(readFileSync(new URL('../deploy/ansible/deploy.yml', import.meta.url), 'utf8'));

function completedBackendProducer() {
  const sourceSha = 'a'.repeat(40);
  const run = { id: 123, run_attempt: 1, status: 'completed', conclusion: 'success',
    event: 'pull_request', head_branch: 'audit/example', head_sha: sourceSha };
  const expected = { sourceSha, runId: run.id, currentAttempt: 1, event: run.event, workflowSha: sourceSha, headBranch: run.head_branch };
  const jobs = ['core', 'full'].map(profile => ({
    name: `Build and test backend OCI image (${profile})`,
    run_id: run.id, run_attempt: 1, head_sha: sourceSha, status: 'completed', conclusion: 'success',
    started_at: '2026-11-22T14:28:35Z', completed_at: '2026-11-22T14:31:22Z',
  }));
  const artifacts = ['core', 'full'].map((profile, index) => ({
    id: 20 + index, name: `codexia-backend-image-${sourceSha}-${profile}-attempt-1`, expired: false,
    created_at: '2026-11-22T14:31:03Z', digest: `sha256:${'b'.repeat(64)}`, size_in_bytes: 100,
    workflow_run: { id: run.id, head_sha: sourceSha },
  }));
  return { run, expected, jobs, artifacts };
}

test('a completed backend run waits for its own producer job window to become available', async () => {
  const { run, expected, jobs, artifacts } = completedBackendProducer();
  let jobReads = 0;
  const requests = [];
  const selected = await readExactBackendProducerArtifacts(run, expected, {
    async readCollection(resource, key) {
      requests.push(resource);
      if (key === 'artifacts') return artifacts;
      jobReads++;
      return jobReads === 1 ? [jobs[0], { ...jobs[1], completed_at: null }] : jobs;
    },
    async pause() {},
  });
  assert.equal(jobReads, 2);
  assert.ok(requests.every(resource => resource.startsWith('actions/runs/123/')));
  assert.deepEqual(selected.map(item => [item.profile, item.artifact.id]), [['core', 20], ['full', 21]]);
});

test('an unavailable producer window stays unresolved and invalid artifact evidence fails immediately', async () => {
  const { run, expected, jobs, artifacts } = completedBackendProducer();
  let polls = 0;
  await assert.rejects(readExactBackendProducerArtifacts(run, expected, {
    async readCollection(_resource, key) {
      if (key === 'artifacts') return artifacts;
      polls++;
      return [jobs[0], { ...jobs[1], completed_at: null }];
    },
    async pause() {},
  }), /Invalid backend producer time window/u);
  assert.equal(polls, 4);

  let pauses = 0;
  await assert.rejects(readExactBackendProducerArtifacts(run, expected, {
    async readCollection(_resource, key) {
      return key === 'jobs' ? jobs : [artifacts[0], { ...artifacts[1], digest: 'invalid' }];
    },
    async pause() { pauses++; },
  }), /Backend artifact digest is invalid/u);
  assert.equal(pauses, 0);
});

test('includes bounded command stderr in sanitized lifecycle failure evidence', () => {
  const error = Object.assign(new Error(`Command failed: ${'podman-argument '.repeat(100)}`), {
    stderr: Buffer.from(`registry refused request\ntoken=ghp_${'a'.repeat(24)}\n`),
  });
  const detail = publicError(error);
  assert.match(detail, /registry refused request/u);
  assert.match(detail, /token=\[REDACTED\]/u);
  assert.doesNotMatch(detail, /ghp_[a-z]+/u);
  assert.ok(detail.length <= 1200);
});

test('shell fixture publishes recent diagnostic lines with credentials redacted', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'codexia-lifecycle-log-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const original = join(scratch, 'full.log');
  const visible = join(scratch, 'visible.log');
  const script = readFileSync(new URL('../deploy/ansible/test-push-app-lifecycle.sh', import.meta.url), 'utf8');
  const redactLog = /^redact_log\(\) \{[\s\S]*?^\}/mu.exec(script)?.[0];
  assert.ok(redactLog, 'expected a standalone log filter in the lifecycle fixture');
  const entries = [
    ...Array.from({ length: 550 }, (_, index) => `startup log ${index}`),
    'database postgres://fixture:opaque-db-value@example.invalid/fixture',
    'authorization Bearer opaque-bearer-value',
    'token=opaque-token-value',
    'candidate exited before becoming ready',
  ];
  await writeFile(original, entries.join('\n') + '\n');
  const result = spawnSync('bash', ['-c', redactLog + '\nredact_log "$1" "$2"', '--', original, visible], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const output = await readFile(visible, 'utf8');
  assert.match(output, /candidate exited before becoming ready/u);
  assert.match(output, /postgres:\/\/fixture:\[REDACTED\]@example\.invalid/u);
  assert.doesNotMatch(output, /opaque-(?:db|bearer|token)-value/u);
  assert.ok(output.trimEnd().split('\n').length < entries.length);
});

test('app lifecycle CI is isolated, path limited, manually runnable, and has no production credentials', () => {
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
  assert.ok(Array.isArray(workflow.on.pull_request.paths));
  assert.ok(workflow.on.pull_request.paths.includes('packages/**'));
  assert.ok(workflow.on.pull_request.paths.includes('deploy/ansible/site.yml'));
  assert.ok(backendWorkflow.on.pull_request.paths.includes('deploy/ansible/**'));
  assert.ok(backendWorkflow.on.pull_request.paths.includes('deploy/postgres/**'));
  assert.equal(workflow.jobs.lifecycle['runs-on'], 'ubuntu-26.04');
  assert.equal(workflow.jobs.lifecycle.environment, undefined);
  assert.deepEqual(workflow.jobs.lifecycle.permissions, { contents: 'read', actions: 'read', 'pull-requests': 'read' });
  assert.equal(workflow.jobs.lifecycle.needs, undefined);
  assert.ok(workflow.jobs.lifecycle.steps.some(step => step.run === 'bash deploy/ansible/test-push-app-lifecycle.sh'));
  assert.ok(workflow.jobs.lifecycle.steps.some(step => step.uses?.startsWith('actions/upload-artifact@')));
  assert.match(workflow.jobs.lifecycle.steps.find(step => step.name === 'Install disposable host and filesystem capabilities').run, /docker info --format/u,
    'the disposable fixture must verify the host Docker builder before use');
});

test('every lifecycle PR path also produces an exact-source backend artifact', () => {
  const backendPaths = backendWorkflow.on.pull_request.paths;
  for (const pattern of new Set(workflow.on.pull_request.paths)) {
    if (pattern.startsWith('!')) {
      assert.ok(backendPaths.includes(pattern), pattern);
      continue;
    }
    // A broader producer filter is acceptable if it covers the whole consumer pattern.
    assert.ok(backendPaths.includes(pattern) || backendPaths.some(path =>
      path.endsWith('/**') ? pattern.startsWith(path.slice(0, -2)) :
        !pattern.includes('*') && matchesGlob(pattern, path)), pattern);
  }
});

test('runtime verification uses a separate proof stage and shares the production transaction implementation', () => {
  const accepted = site.tasks.find(task => task.name === 'Allow the disposable app lifecycle fixture stage');
  assert.ok(accepted);
  assert.match(accepted['ansible.builtin.assert'].that.join(' '), /deploy-lifecycle-fixture/u);
  assert.match(accepted['ansible.builtin.assert'].that.join(' '), /inventory_hostname == 'localhost'/u);
  assert.match(accepted['ansible.builtin.assert'].that.join(' '), /ansible_connection == 'local'/u);
  assert.ok(site.tasks.some(task => task.name === 'Run the shared deployment transaction for verified disposable OCI images' &&
    task['ansible.builtin.include_tasks']?.file === 'deploy-lifecycle-fixture.yml'));
  assert.ok(deploy.some(task => task['ansible.builtin.include_tasks'] === 'deploy-transaction.yml'));
  assert.ok(deploy[0]['ansible.builtin.assert'].that.includes('not (codexia_lifecycle_fixture | default(false) | bool)'));
  const transaction = parse(readFileSync(new URL('../deploy/ansible/deploy-transaction.yml', import.meta.url), 'utf8'));
  const prepare = parse(readFileSync(new URL('../deploy/ansible/deploy-prepare.yml', import.meta.url), 'utf8'));
  assert.equal(transaction[0]['ansible.builtin.include_tasks'], 'deploy-prepare.yml');
  const productionDigestGate = transaction.find(task => task.name === 'Require one canonical immutable digest for the installed API image');
  assert.ok(productionDigestGate.when.includes('not (codexia_lifecycle_fixture | default(false) | bool)'),
    'production must retain its unique canonical GHCR digest admission');
  const fixtureDigestGate = transaction.find(task => task.name === 'Require the exact immutable running image reference in the disposable registry');
  assert.ok(fixtureDigestGate, 'the disposable registry must admit only its exact immutable running image reference');
  assert.ok(fixtureDigestGate['ansible.builtin.assert'].that.some(condition => condition.includes('codexia_current_api_image_name.stdout in')));
  assert.match(fixtureDigestGate['ansible.builtin.assert'].that.join(' '), /localhost:5000\|ghcr/u,
    'the exact digest may retain its GHCR source name after the fixture registry rewrite');
  assert.ok(prepare.some(task => task.name === 'Install the interrupted deployment recovery helper'));
  const transactionCommand = transaction.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  assert.equal(typeof transactionCommand['ansible.builtin.shell'], 'object');
  assert.equal(typeof transactionCommand['ansible.builtin.shell'].cmd, 'string');
  assert.equal(transactionCommand.failed_when, false);
  const safeFailure = transaction.find(task => task.name === 'Report only an allowlisted deployment transaction failure stage');
  assert.ok(safeFailure, 'transaction failure diagnostics must not expose command output');
  assert.match(safeFailure['ansible.builtin.fail'].msg, /fresh database schema initialization/u);
  const fixture = parse(readFileSync(new URL('../deploy/ansible/deploy-lifecycle-fixture.yml', import.meta.url), 'utf8'));
  assert.ok(fixture.some(task => task['ansible.builtin.include_tasks'] === 'deploy-transaction.yml'));
  assert.equal(fixture.findIndex(task => task['ansible.builtin.include_tasks'] === 'deploy-prepare.yml'),
    fixture.findIndex(task => task.name === 'Recover interrupted disposable deployment before examining the active API') - 1);
  assert.ok(fixture.some(task => /verification evidence/u.test(task.name ?? '')));
  assert.ok(parse(readFileSync(new URL('../deploy/ansible/deploy-transaction.yml', import.meta.url), 'utf8'))
    .some(task => task.name === 'Admit the published candidate against installed API and deployed UI identities'));
});

test('rollback proof requires a candidate startup or readiness failure and a restored writer', () => {
  const script = readFileSync(new URL('../deploy/ansible/test-push-app-lifecycle.sh', import.meta.url), 'utf8');
  const rollback = script.slice(script.indexOf('before_failure='), script.indexOf('set_state failed_candidate_rollback PASS'));
  assert.match(rollback, /grep -Eq .*Deployment transaction failed during candidate API \(?startup\|readiness/u);
  assert.match(rollback, /rootless test ! -e .*deploy-transaction\.json/u);
  assert.match(script, /key==='failed-candidate-rollback'\|\|key==='better-auth-rollback'\)&&apiContainer===previous\.apiContainer/u);
});

test('Better Auth checkpoints identify their exact installed image, including the restored writer', () => {
  const script = readFileSync(new URL('../deploy/ansible/test-push-auth-lifecycle.sh', import.meta.url), 'utf8');
  assert.deepEqual([...script.matchAll(/^ {2}observe_runtime (\S+) (\S+)$/gmu)].map(match => match.slice(1)), [
    ['better-auth-activation', 'auth-primary'],
    ['better-auth-same-digest', 'auth-primary'],
    ['better-auth-compatible-update', 'auth-update'],
    ['better-auth-rollback', 'auth-update'],
  ]);
});

test('image selection binds the PR Full artifact and fails closed without a compatible verified release', () => {
  const source = readFileSync(new URL('./push-app-lifecycle.mjs', import.meta.url), 'utf8');
  const fixture = readFileSync(new URL('../deploy/ansible/test-push-app-lifecycle.sh', import.meta.url), 'utf8');
  assert.match(source, /selectBackendArtifacts/u);
  assert.match(source, /apiArrayPages\('releases'\)/u,
    'the GitHub releases endpoint must use its array response pagination contract');
  assert.match(source, /publicationRun\.head_sha === metadata\.publication\.workflowHeadSha/u,
    'a workflow_run publication binds the runner head SHA separately from the backend source SHA');
  assert.doesNotMatch(source, /publicationRun\.head_sha === metadata\.sourceSha/u);
  assert.match(source, /downloadArtifact/u);
  assert.match(source, /validatePushDeploymentCertificatePair/u);
  assert.match(source, /migrationFingerprint/u);
  assert.match(source, /apiEpoch/u);
  assert.match(source, /persistenceFormat/u);
  assert.match(source, /localhost:5000\/yohn-jp\/codexia-backend:lifecycle-/u);
  assert.match(fixture, /CAPABILITY_UNAVAILABLE/u);
  assert.match(fixture, /rootless_podman --version/u);
  assert.doesNotMatch(fixture, /\.Host\.Version/u);
  assert.match(fixture, /prefix = "localhost:5000"\nlocation = "localhost:5000"\ninsecure = true/u,
    'the isolated plain-HTTP registry must be explicitly insecure for rootless Podman pushes');
  assert.match(fixture, /trap 'record_failure .* ERR/u);
  assert.match(fixture, /capture_failure_runtime/u, 'failed deploys must collect runtime context before fixture cleanup');
  assert.match(fixture, /runtime-failure-bounded\.log/u, 'runtime diagnostics must be redacted before artifact upload');
  assert.match(fixture, /Cleanup check failed at script line/u, 'fixture cleanup failures must identify their failed check');
  assert.match(fixture, /cleanup-errors-bounded\.log/u, 'cleanup diagnostics must be included in the run artifact');
  assert.match(fixture, /Last sanitized fixture log/u);
  assert.match(fixture, /Cloudflare Tunnel unit/u);
  assert.match(fixture, /cloudflareTunnel:\{status:'NOT_STARTED'/u);
  assert.match(fixture, /apiContainer!==previous\.apiContainer/u);
});
