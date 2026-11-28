import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { publicError, readExactBackendProducerArtifacts, selectPriorPublication, selectLifecycleTransition } from './app.mjs';

const require = createRequire(new URL('../../../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('../../../.github/workflows/push-app-lifecycle.yml', import.meta.url), 'utf8'));
const backendWorkflow = parse(readFileSync(new URL('../../../.github/workflows/backend-release.yml', import.meta.url), 'utf8'));
const site = parse(readFileSync(new URL('../../../deploy/ansible/site.yml', import.meta.url), 'utf8'))[0];
const deploy = parse(readFileSync(new URL('../../../deploy/ansible/deploy.yml', import.meta.url), 'utf8'));

// GitHub paths filters are ordered: later negative and positive patterns can
// exclude or re-include an earlier match. Compare effective source selection,
// not only the textual spelling of a pattern.
function selectsPath(patterns, file) {
  let included = false;
  for (const pattern of patterns) {
    const exclude = pattern.startsWith('!');
    if (matchesGlob(file, exclude ? pattern.slice(1) : pattern)) included = !exclude;
  }
  return included;
}

test('rootless Podman changes into the private service home after dropping privileges', () => {
  const source = readFileSync(new URL('./app.mjs', import.meta.url), 'utf8');
  const rootless = source.split('function rootlessPodman(args, options = {}) {')[1]
    ?.split('export function publicError(error) {')[0];
  assert.ok(rootless, 'the rootless Podman invocation must be present');
  assert.ok(rootless.includes(`'/bin/bash', '-c', 'cd "$HOME" && exec "$@"'`),
    'the private home chdir must happen after sudo switches to the rootless service UID');
  assert.ok(rootless.includes("cwd: '/'"), 'runner must start sudo from a traversable working directory');
  assert.doesNotMatch(rootless, /cwd:\s*home/u, 'runner cannot enter a 0700 service home before invoking sudo');
});

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
  const script = readFileSync(new URL('../../../deploy/ansible/test-push-app-lifecycle.sh', import.meta.url), 'utf8');
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
  assert.ok(selectsPath(workflow.on.pull_request.paths, 'packages/api/src/server.ts'));
  assert.ok(selectsPath(workflow.on.pull_request.paths, 'deploy/ansible/site.yml'));
  assert.equal(selectsPath(workflow.on.pull_request.paths, 'packages/core/src/formatter.ts'), false);
  assert.equal(selectsPath(workflow.on.pull_request.paths, 'docs/deployment/PUSH-DEPLOYMENT.sdoc'), false);
  assert.ok(!workflow.on.pull_request.paths.includes('scripts/ci/impact/contract.mjs'),
    'generic CI planner edits must not launch the real-host lifecycle');
  assert.ok(backendWorkflow.on.pull_request.paths.includes('deploy/ansible/**'));
  assert.ok(backendWorkflow.on.pull_request.paths.includes('deploy/postgres/**'));
  assert.equal(workflow.jobs.lifecycle['runs-on'], 'ubuntu-26.04');
  assert.equal(workflow.jobs.lifecycle.environment, undefined);
  assert.deepEqual(workflow.jobs.lifecycle.permissions, { contents: 'read', actions: 'read', 'pull-requests': 'read' });
  assert.equal(workflow.jobs.lifecycle.needs, 'fixture');
  assert.deepEqual(workflow.jobs.lifecycle.strategy.matrix.scenario, ['app', 'auth']);
  assert.equal(workflow.jobs.lifecycle.strategy['fail-fast'], false);
  assert.deepEqual(workflow.jobs.fixture.permissions, { contents: 'read' });
  const producer = workflow.jobs.fixture.steps;
  assert.ok(producer.some(step => step.run === 'bash deploy/fixtures/sshfs-server/build.sh'));
  assert.ok(producer.some(step => step.uses?.startsWith('actions/upload-artifact@') && step.id === 'archive'));
  const consumer = workflow.jobs.lifecycle.steps;
  assert.ok(consumer.some(step => step.run === 'bash deploy/ansible/test-push-app-lifecycle.sh'));
  assert.ok(consumer.some(step => step.uses?.startsWith('actions/download-artifact@') &&
    step.with['artifact-ids'] === '${{ needs.fixture.outputs.artifact_id }}'));
  assert.ok(consumer.some(step => step.run?.includes('scripts/verification/artifacts/sshfs-fixture.mjs')));
  assert.ok(consumer.some(step => step.uses?.startsWith('actions/upload-artifact@') &&
    step.with.name.includes('${{ matrix.scenario }}')));
  assert.doesNotMatch(consumer.find(step => step.name === 'Install disposable host and filesystem capabilities').run,
    /docker info|docker build/u, 'lifecycle consumers must not rebuild the key-free fixture');
});

test('both lifecycle shells and the prebuild shell parse as executable Bash', () => {
  for (const filename of ['../../../deploy/ansible/test-push-app-lifecycle.sh',
    '../../../deploy/ansible/test-push-auth-lifecycle.sh', '../../../deploy/fixtures/sshfs-server/build.sh']) {
    const source = new URL(filename, import.meta.url);
    const result = spawnSync('bash', ['-n', source.pathname], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('lifecycle CI activates pinned Mitogen and profiles stage-specific Ansible work', () => {
  const lifecycle = workflow.jobs.lifecycle;
  const install = lifecycle.steps.find(step => step.name === 'Install disposable host and filesystem capabilities');
  assert.ok(install, 'the fixture must configure its Ansible controller');
  assert.match(install.run, /mitogen==0\.3\.55/u);
  assert.match(install.run, /ANSIBLE_STRATEGY=mitogen_linear/u);
  assert.match(install.run, /ANSIBLE_STRATEGY_PLUGINS=\$plugin_dir/u);
  assert.match(install.run, /mitogen_linear\.py/u);
  assert.match(install.run, /-m py_compile.*codexia_profile\.py/u);
  assert.doesNotMatch(install.run, /ansible-doc.*mitogen_linear/u,
    'Mitogen has no ansible-doc metadata; its pinned strategy file is the contract');
  assert.match(install.run, /ANSIBLE_CALLBACKS_ENABLED=codexia_profile/u);
  assert.ok(selectsPath(workflow.on.pull_request.paths, 'deploy/ansible/callback_plugins/codexia_profile.py'));

  const gather = site.tasks.find(task => task.name === 'Gather target host facts');
  assert.ok(gather, 'host fact collection remains explicit');
  assert.match(gather['ansible.builtin.setup'].gather_subset, /'distribution', 'architecture', 'service_mgr'/u);
  assert.match(gather['ansible.builtin.setup'].gather_subset, /'!all', '!min', 'user'/u);
  assert.doesNotMatch(gather['ansible.builtin.setup'].gather_subset, /\['all'\]/u,
    'repeated lifecycle deployment must not discover the entire host');

  const fixture = readFileSync(new URL('../../../deploy/ansible/test-push-app-lifecycle.sh', import.meta.url), 'utf8');
  assert.match(fixture, /grant_mitogen_traversal/u);
  assert.match(fixture, /setfacl -m "u:\$fixture_uid:--x"/u);
  assert.match(fixture, /setfacl -x "u:\$fixture_uid"/u);
  assert.match(fixture, /\[\[ -n "\$dir" \]\] \|\| dir=\//u,
    'Mitogen fixture directory traversal must terminate at the filesystem root');
  assert.match(fixture, /LIFECYCLE_ANSIBLE_TIMING stage=/u);
  const profile = readFileSync(new URL('../../../deploy/ansible/callback_plugins/codexia_profile.py', import.meta.url), 'utf8');
  assert.match(profile, /CODEXIA_ANSIBLE_TASK_TIME/u);
  assert.doesNotMatch(profile, /result\._result|module_args|env\[/u,
    'task timing must not expose secret-bearing arguments or results');
});

test('real app and Better Auth transitions execute independently and missing states cannot pass', () => {
  const fixture = readFileSync(new URL('../../../deploy/ansible/test-push-app-lifecycle.sh', import.meta.url), 'utf8');
  const image = readFileSync(new URL('../../../deploy/fixtures/sshfs-server/Dockerfile', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('../../../deploy/fixtures/sshfs-server/entrypoint.sh', import.meta.url), 'utf8');
  const producer = readFileSync(new URL('../../../deploy/fixtures/sshfs-server/build.sh', import.meta.url), 'utf8');
  assert.ok(fixture.includes('case "${CODEXIA_LIFECYCLE_SCENARIO:?}" in'));
  assert.ok(fixture.includes('run_application_lifecycle'));
  assert.ok(fixture.includes('run_better_auth_lifecycle'));
  const authShell = readFileSync(new URL('../../../deploy/ansible/test-push-auth-lifecycle.sh', import.meta.url), 'utf8');
  assert.match(authShell, /if \[\[ "\$\{1:-auth\}" == app \]\]; then\n    run_application_lifecycle/u,
    'only the app scenario should run generic application transitions');
  assert.match(authShell, /run_deploy auth-primary true '' auth-verified-activation/u,
    'the auth lane must activate its own initially empty database');
  assert.match(authShell, /seed_database_sentinel/u,
    'auth must independently prove PostgreSQL continuity');
  assert.ok(fixture.includes("r.status=required.length>0&&[...required,'fixture_cleanup'].every"));
  assert.ok(fixture.includes('Lifecycle report has unverified required transitions'));
  assert.ok(fixture.includes('run_deploy "$initial_key" false "$fault_dir"'));
  assert.ok(fixture.includes('scripts/verification/artifacts/sshfs-fixture.mjs'));
  assert.ok(fixture.includes('authorized_keys:ro'));
  assert.doesNotMatch(fixture, /docker build|docker save|docker pull/u);
  assert.match(producer, /docker build --platform linux\/amd64/u);
  assert.ok(producer.includes('codexia-backup@127.0.0.1 true'));
  assert.doesNotMatch(image, /COPY.*authorized_keys/u, 'per-run keys must never be packaged into the image');
  assert.ok(entry.includes('test -s /home/codexia-backup/.ssh/authorized_keys'));
});

test('lifecycle readiness uses real conditions without time-based sleep loops', () => {
  for (const name of [
    '../../../deploy/ansible/test-push-app-lifecycle.sh',
    '../../../deploy/ansible/test-push-auth-lifecycle.sh',
    '../../../deploy/ansible/deploy-transaction.yml',
    '../../../deploy/ansible/push-deployment-recover.sh',
    '../../../deploy/fixtures/sshfs-server/build.sh',
  ]) {
    const source = readFileSync(new URL(name, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bsleep\s+[0-9]+/u, name);
  }
  const api = readFileSync(new URL('../../../deploy/quadlet/codexia-api.container', import.meta.url), 'utf8');
  const db = readFileSync(new URL('../../../deploy/quadlet/codexia-db.container', import.meta.url), 'utf8');
  assert.match(api, /^Notify=healthy$/mu);
  assert.match(api, /^HealthStartupInterval=2s$/mu);
  const healthCommand = api.match(/^HealthCmd=(.+)$/mu)?.[1];
  const startupCommand = api.match(/^HealthStartupCmd=(.+)$/mu)?.[1];
  assert.ok(healthCommand && startupCommand, 'startup requires an explicit healthcheck command');
  assert.equal(startupCommand, healthCommand,
    'the faster startup readiness probe must be identical to the regular API readiness probe');
  assert.match(api, /^StartLimitBurst=3$/mu);
  assert.match(db, /^Tmpfs=\/run\/postgresql:rw,nosuid,nodev,noexec,size=16m$/mu);
  assert.doesNotMatch(db, /^Tmpfs=\/var\/run\/postgresql:/mu);
});

test('every selected lifecycle source also selects an exact-source backend artifact', () => {
  const consumerPaths = workflow.on.pull_request.paths;
  const producerPaths = backendWorkflow.on.pull_request.paths;
  const tracked = spawnSync('git', ['ls-files', '-z'], {
    cwd: new URL('../../../', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(tracked.status, 0, tracked.stderr);
  const candidates = new Set([
    ...tracked.stdout.split('\0').filter(Boolean),
    // Admit future files under broad deployment/auth globs, and reject
    // future unmapped producer paths before the fixture can run.
    'packages/api/src/new-auth-activation.ts',
    'packages/api/src/auth/authorize.ts',
    'packages/persistence-postgres/migrations/new-ledger.sql',
    'deploy/ansible/new-transaction.yml',
    'deploy/ansible/callback_plugins/new-profile.py',
    'deploy/backup/new-transfer.sh',
    'scripts/deployment/lifecycle/app-new.mjs',
    'modules/story/package.json',
    'docs/deployment/BACKUP-CONSOLE-OPERATIONS.sdoc',
    'packages/api/src/better-auth.test.ts',
  ]);
  let admitted = 0;
  for (const file of candidates) {
    if (!selectsPath(consumerPaths, file)) continue;
    admitted++;
    assert.ok(selectsPath(producerPaths, file),
      `Lifecycle would run without an exact-source backend artifact: ${file}`);
  }
  assert.ok(admitted > 0, 'the lifecycle source selection must not be empty');
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
  const transaction = parse(readFileSync(new URL('../../../deploy/ansible/deploy-transaction.yml', import.meta.url), 'utf8'));
  const prepare = parse(readFileSync(new URL('../../../deploy/ansible/deploy-prepare.yml', import.meta.url), 'utf8'));
  assert.equal(transaction[0]['ansible.builtin.include_tasks'], 'deploy-prepare.yml');
  const productionDigestGate = transaction.find(task => task.name === 'Require one canonical immutable digest for the installed API image');
  assert.ok(productionDigestGate.when.includes('not (codexia_lifecycle_fixture | default(false) | bool)'),
    'production must retain its unique canonical GHCR digest admission');
  const fixtureDigestGate = transaction.find(task => task.name === 'Require the exact immutable running image reference in the disposable registry');
  assert.ok(fixtureDigestGate, 'the disposable registry must admit only its exact immutable running image reference');
  assert.ok(fixtureDigestGate['ansible.builtin.assert'].that.some(condition => condition.includes('codexia_current_api_image_name.stdout in')));
  assert.match(fixtureDigestGate['ansible.builtin.assert'].that.join(' '), /match\(codexia_image_pattern\).+match\(.+codexia_fixture_image_repository/u,
    'the exact digest may retain its GHCR source name after the fixture registry rewrite');
  assert.ok(prepare.some(task => task.name === 'Install the interrupted deployment recovery helper'));
  const transactionCommand = transaction.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  assert.equal(typeof transactionCommand['ansible.builtin.shell'], 'object');
  assert.equal(typeof transactionCommand['ansible.builtin.shell'].cmd, 'string');
  assert.equal(transactionCommand.failed_when, false);
  const safeFailure = transaction.find(task => task.name === 'Report only an allowlisted deployment transaction failure stage');
  assert.ok(safeFailure, 'transaction failure diagnostics must not expose command output');
  assert.match(safeFailure['ansible.builtin.fail'].msg, /fresh database schema initialization/u);
  const fixture = parse(readFileSync(new URL('../../../deploy/ansible/deploy-lifecycle-fixture.yml', import.meta.url), 'utf8'));
  const fixtureMode = fixture.findIndex(task => task['ansible.builtin.set_fact']?.codexia_lifecycle_fixture === true);
  const fixtureTransaction = fixture.findIndex(task => task['ansible.builtin.include_tasks'] === 'deploy-transaction.yml');
  assert.ok(fixtureMode >= 0 && fixtureMode < fixtureTransaction,
    'the disposable lane must establish its verified scope before the shared transaction');
  const digestGate = transaction.find(task => task.name === 'Require the pulled image to retain the certified immutable digest');
  assert.equal(digestGate.when, undefined, 'both production and fixture must verify the observed image digest');
  assert.match(digestGate['ansible.builtin.assert'].that.join(' '), /codexia_fixture_image_repository/u);
  const identityGate = transaction.find(task => task.name === 'Require candidate image source, profile and database compatibility identity');
  assert.ok(identityGate['ansible.builtin.assert'].that.includes('codexia_candidate_identity == codexia_deployment_certificate.identity'));
  assert.equal(identityGate.when, undefined, 'the observed embedded identity must be bound in both lanes');
  assert.ok(parse(readFileSync(new URL('../../../deploy/ansible/deploy-transaction.yml', import.meta.url), 'utf8'))
    .some(task => task.name === 'Admit the published candidate against installed API and deployed UI identities'));
});

test('rollback proof requires a candidate startup or readiness failure and a restored writer', () => {
  const script = readFileSync(new URL('../../../deploy/ansible/test-push-app-lifecycle.sh', import.meta.url), 'utf8');
  const rollback = script.slice(script.indexOf('before_failure='), script.indexOf('set_state failed_candidate_rollback PASS'));
  assert.match(rollback, /grep -Eq .*Deployment transaction failed during candidate API \(?startup\|readiness/u);
  assert.match(rollback, /rootless test ! -e .*deploy-transaction\.json/u);
  assert.match(script, /key==='failed-candidate-rollback'\|\|key==='better-auth-rollback'\)&&apiContainer===previous\.apiContainer/u);
});

test('Better Auth checkpoints identify their exact installed image, including the restored writer', () => {
  const script = readFileSync(new URL('../../../deploy/ansible/test-push-auth-lifecycle.sh', import.meta.url), 'utf8');
  assert.deepEqual([...script.matchAll(/^ {2}observe_runtime (\S+) (\S+)$/gmu)].map(match => match.slice(1)), [
    ['better-auth-activation', 'auth-primary'],
    ['better-auth-same-digest', 'auth-primary'],
    ['private-backup-socket-restart', 'auth-primary'],
    ['better-auth-compatible-update', 'auth-update'],
    ['better-auth-rollback', 'auth-update'],
  ]);
});

test('only the newest strictly earlier release matching API and storage metadata is selected for certificate lookup', () => {
  const head = { sourceSha: 'a'.repeat(40), version: '1.0.101', apiEpoch: 2, persistenceFormat: 3 };
  function release(version, overrides = {}) {
    const metadata = { component: 'backend', version, sourceSha: 'b'.repeat(40), providedApiEpoch: 2, persistenceFormat: 3,
      producer: { sourceSha: 'c'.repeat(40) }, ...overrides };
    return { tag_name: 'backend-v' + version, draft: false, prerelease: false,
      body: ['```json', JSON.stringify(metadata), '```'].join('\n') };
  }
  const rejected = [release('1.0.101'), release('1.0.102'), release('1.0.96', { providedApiEpoch: 1 }),
    release('1.0.97', { persistenceFormat: 1 }), release('1.0.98', { producer: { sourceSha: head.sourceSha } }),
    { ...release('1.0.99'), draft: true }, { ...release('1.0.100'), body: 'missing release metadata' }];
  assert.equal(selectPriorPublication(rejected, head), undefined);
  assert.equal(selectPriorPublication([release('1.0.10'), ...rejected, release('1.0.9')], head).metadata.version, '1.0.10');
});

test('published transitions require an upwards version and matching certified database and API identities', () => {
  const head = { version: '1.0.101', profile: 'full', apiEpoch: 2, persistenceFormat: 3, migrationFingerprint: 'sha256:' + 'a'.repeat(64) };
  const prior = { ...head, version: '1.0.100' };
  assert.deepEqual(selectLifecycleTransition(head, prior), { from: 'prior', to: 'head', kind: 'published-upgrade' });
  assert.deepEqual(selectLifecycleTransition(head), { from: 'head', to: 'app-update', kind: 'test-only-digest' });
  for (const mismatch of [{ version: head.version }, { version: '1.0.102' }, { profile: 'core' },
    { apiEpoch: 3 }, { persistenceFormat: 4 }, { migrationFingerprint: 'sha256:' + 'b'.repeat(64) }]) {
    assert.throws(() => selectLifecycleTransition(head, { ...prior, ...mismatch }), /compatible database and API/u);
  }
});

test('image selection binds the exact-source Full artifact and verified publication proof', () => {
  const source = readFileSync(new URL('./app.mjs', import.meta.url), 'utf8');
  const fixture = readFileSync(new URL('../../../deploy/ansible/test-push-app-lifecycle.sh', import.meta.url), 'utf8');
  assert.match(source, /selectBackendArtifacts/u);
  assert.match(source, /paginateGitHubArray\(octokit\(\), octokit\(\)\.rest\.repos\.listReleases/u,
    'the GitHub releases endpoint must use Octokit array pagination');
  assert.match(source, /metadata\.publication\?\.workflowHeadSha \?\? metadata\.sourceSha/u);
  assert.match(source, /run\.head_sha === workflowHead/u, 'a publication must bind its recorded workflow head');
  assert.match(fixture, /run_deploy "\$initial_key" true/u);
  assert.match(fixture, /observe_runtime compatible-update "\$update_key"/u);
  assert.match(source, /downloadArtifact/u);
  assert.match(source, /validatePushDeploymentCertificatePair/u);
  assert.match(source, /migrationFingerprint/u);
  assert.match(source, /apiEpoch/u);
  assert.match(source, /persistenceFormat/u);
  assert.match(source, /backendImageName\(target\(\).repository\)/u);
  assert.match(source, /\$\{fixtureRegistry\(\)\}:lifecycle-/u);
  assert.match(fixture, /prefix = "\$image_repository"\nlocation = "\$fixture_image_repository"/u);
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
  assert.match(fixture, /managementConnector:\{status:'LOOPBACK_FIXTURE'/u,
    'the fixture must distinguish host readiness from live Cloudflare acceptance');
  assert.match(fixture, /codexia-api-gate status\)" == open/u);
  assert.match(fixture, /http:\/\/127\.0\.0\.1:18080\/health\/ready[^\n]+\n  assert_fixture_management_continues/u,
    'observed product readiness must use the publication socket alongside management continuity');
  assert.match(fixture, /apiContainer!==previous\.apiContainer/u);
});
