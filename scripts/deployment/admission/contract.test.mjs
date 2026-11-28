import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(new URL('../../../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('../../../.github/workflows/backend-release.yml', import.meta.url), 'utf8'));
const handoff = parse(readFileSync(new URL('../../../.github/workflows/backend-deployment-handoff.yml', import.meta.url), 'utf8'));
const preflight = parse(readFileSync(new URL('../../../.github/workflows/production-preflight.yml', import.meta.url), 'utf8'));
const site = parse(readFileSync(new URL('../../../deploy/ansible/site.yml', import.meta.url), 'utf8'))[0];
const transactionTasks = parse(readFileSync(new URL('../../../deploy/ansible/deploy-transaction.yml', import.meta.url), 'utf8'));

test('pull request backend validation cannot obtain production credentials or deploy', () => {
  const validation = workflow.jobs['build-test'];
  assert.ok(validation, 'backend PR validation job is required');
  assert.equal(validation.environment, undefined, 'PR validation must not attach a production Environment');
  assert.equal(validation.permissions['id-token'], undefined, 'PR validation must not receive a production identity');
  for (const step of validation.steps) {
    for (const value of Object.values(step.env ?? {})) {
      assert.doesNotMatch(String(value), /secrets\./u, 'PR validation must not read GitHub Environment secrets');
    }
  }
});

test('production deployment consumes the verified Full digest and provenance certificate after main publication', () => {
  const deploy = handoff.jobs['deploy-production'];
  assert.ok(deploy, 'certified production deployment job is required');
  assert.match(deploy.if, /github\.event_name == 'workflow_run'/u);
  assert.match(deploy.if, /github\.event\.workflow_run\.event == 'workflow_run'/u);
  assert.match(deploy.if, /github\.event\.workflow_run\.head_branch == 'main'/u);
  assert.match(deploy.if, /needs\.verify-handoff\.outputs\.certified-full-image != ''/u);
  assert.match(deploy.if, /needs\.verify-handoff\.outputs\.deployment-certificate != ''/u);

  const ssh = deploy.steps.find(step => step.name === 'Prepare pinned SSH identity');
  assert.ok(ssh, 'production deployment must prepare its dedicated SSH key and pinned host key');
  assert.equal(ssh.env.CODEXIA_DEPLOY_SSH_PRIVATE_KEY, '${{ secrets.CODEXIA_DEPLOY_SSH_PRIVATE_KEY }}');
  assert.equal(ssh.env.CODEXIA_DEPLOY_SSH_KNOWN_HOSTS, '${{ vars.CODEXIA_DEPLOY_SSH_KNOWN_HOSTS }}');
  assert.equal(ssh.env.CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET, '${{ vars.CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET }}');
  assert.equal(ssh.run, 'bash deploy/ansible/prepare-deploy-ssh.sh');

  const liveUi = deploy.steps.find(step => step.name === 'Verify deployed frontend epoch and Access boundary for certified backend recovery');
  assert.ok(liveUi, 'the job must admit the deployed frontend against the verified backend epoch before deployment');
  assert.equal(liveUi.env.CODEXIA_ACCESS_CLIENT_ID, '${{ secrets.CODEXIA_ACCESS_CLIENT_ID }}');
  assert.equal(liveUi.env.CODEXIA_EXPECTED_BACKEND_API_EPOCH, '${{ needs.verify-handoff.outputs.certified-full-api-epoch }}');
  assert.equal(liveUi.run, 'node scripts/release/frontend/verify-compatibility.mjs backend-preflight');
  const ansible = deploy.steps.find(step => step.name === 'Converge certified backend digest');
  assert.ok(ansible, 'production deployment must apply the digest through Ansible');
  assert.equal(ansible.env.CODEXIA_CERTIFIED_FULL_IMAGE, '${{ needs.verify-handoff.outputs.certified-full-image }}');
  assert.equal(ansible.env.CODEXIA_PROFILE, 'full');
  assert.doesNotMatch(JSON.stringify(ansible), /BACKUP_(DESTINATION|AGE_RECIPIENT)|codexia_backup_/u);
  assert.equal(ansible.env.CODEXIA_DEPLOYMENT_CERTIFICATE_B64, '${{ needs.verify-handoff.outputs.deployment-certificate }}');
  assert.equal(ansible.env.CODEXIA_INITIAL_INSTALL_APPROVED, "${{ vars.CODEXIA_INITIAL_INSTALL_APPROVED || 'false' }}");
  assert.equal(ansible.env.CODEXIA_DATABASE_INITIALIZATION_APPROVED, "${{ vars.CODEXIA_DATABASE_INITIALIZATION_APPROVED || 'false' }}");
  assert.equal(ansible.env.CODEXIA_DATABASE_ADOPTION_APPROVED, "${{ vars.CODEXIA_DATABASE_ADOPTION_APPROVED || 'false' }}");
});

test('the convergence step forwards the certified identity, private certificate and typed approvals to Ansible', t => {
  const converge = handoff.jobs['deploy-production'].steps.find(step => step.name === 'Converge certified backend digest');
  const directory = mkdtempSync(path.join(tmpdir(), 'codexia-handoff-converge-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'codexia-ansible', 'bin');
  const invocation = path.join(directory, 'ansible-invocation');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'ansible-playbook'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$RUNNER_TEMP/ansible-invocation"\n', { mode: 0o700 });
  symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const command of ['base64', 'cat', 'chmod']) {
    const lookup = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', command], { encoding: 'utf8' });
    assert.ifError(lookup.error);
    assert.equal(lookup.status, 0, `${command} must be installed`);
    symlinkSync(lookup.stdout.trim(), path.join(bin, command));
  }

  mkdirSync(path.join(directory, 'scripts', 'github'), { recursive: true });
  writeFileSync(path.join(directory, 'scripts', 'github', 'repository.mjs'),
    readFileSync(new URL('../../github/repository.mjs', import.meta.url)));
  const digest = `ghcr.io/yohn-jp/codexia-backend@sha256:${'a'.repeat(64)}`;
  const verified = 'b'.repeat(40);
  const producer = 'c'.repeat(40);
  const certificateBytes = Buffer.from('{"fixture":"certified release receipt"}\n');
  const admitted = {
    PATH: bin,
    RUNNER_TEMP: directory,
    GITHUB_STEP_SUMMARY: path.join(directory, 'summary'),
    GITHUB_REPOSITORY: 'yohn-jp/codexia', GITHUB_REPOSITORY_ID: '401', GITHUB_REPOSITORY_OWNER_ID: '502',
    CODEXIA_CERTIFIED_FULL_IMAGE: digest,
    CODEXIA_DEPLOYMENT_CERTIFICATE_B64: certificateBytes.toString('base64'),
    CODEXIA_VERIFIED_MAIN_SHA: verified,
    CODEXIA_SOURCE_SHA: producer,
    CODEXIA_PROFILE: 'full',
    CODEXIA_DEPLOYED_UI_EPOCH: '17',
    CODEXIA_INITIAL_INSTALL_APPROVED: 'true',
    CODEXIA_DATABASE_INITIALIZATION_APPROVED: 'false',
    CODEXIA_DATABASE_ADOPTION_APPROVED: 'false',
  };
  for (const [key, value] of Object.entries({
    CODEXIA_CERTIFIED_FULL_IMAGE: 'ghcr.io/yohn-jp/codexia-backend:latest',
    CODEXIA_DEPLOYMENT_CERTIFICATE_B64: '',
    CODEXIA_VERIFIED_MAIN_SHA: 'main',
    CODEXIA_SOURCE_SHA: 'main',
    CODEXIA_DEPLOYED_UI_EPOCH: '0',
    CODEXIA_INITIAL_INSTALL_APPROVED: 'yes',
    CODEXIA_DATABASE_INITIALIZATION_APPROVED: 'yes',
    CODEXIA_DATABASE_ADOPTION_APPROVED: 'yes',
  })) {
    const result = spawnSync('/bin/bash', ['-c', converge.run], {
      cwd: directory, env: { ...admitted, [key]: value }, encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, `invalid ${key} must be rejected`);
    assert.equal(existsSync(invocation), false, `invalid ${key} reached Ansible`);
  }

  for (const [installApproved, databaseApproved] of [[false, false], [true, false], [false, true], [true, true]]) {
    rmSync(invocation, { force: true });
    const env = {
      ...admitted,
      CODEXIA_INITIAL_INSTALL_APPROVED: String(installApproved),
      CODEXIA_DATABASE_INITIALIZATION_APPROVED: String(databaseApproved),
    };
    const result = spawnSync('/bin/bash', ['-c', converge.run], { cwd: directory, env, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const args = readFileSync(invocation, 'utf8').trimEnd().split('\n');
    assert.equal(args.length, 5);
    assert.equal(args[0], '-i');
    assert.equal(args[2], 'deploy/ansible/site.yml');
    assert.equal(args[3], '--extra-vars');
    assert.match(args[4], /^@/u);

    const inventory = parse(readFileSync(args[1], 'utf8'));
    assert.equal(inventory.all.hosts.codexia.codexia_stage, 'deploy');
    const { codexia_deployment_certificate_file: certificate, ...variables } =
      JSON.parse(readFileSync(args[4].slice(1), 'utf8'));
    assert.deepEqual(readFileSync(certificate), certificateBytes);
    assert.equal(statSync(certificate).mode & 0o777, 0o600);
    assert.deepEqual(variables, {
      codexia_image: digest,
      codexia_source_sha: producer,
      codexia_profile: 'full',
      codexia_verified_main_sha: verified,
      codexia_deployed_ui_epoch: 17,
      codexia_initial_install_approved: false,
      codexia_database_initialization_approved: false,
      codexia_database_adoption_approved: false,
    });
  }

  rmSync(invocation, { force: true });
  const manual = {
    ...admitted, CODEXIA_MANUAL_ACTIVATION: 'true', CODEXIA_DATABASE_INITIALIZATION_APPROVED: 'true',
    CODEXIA_BACKUP_DESTINATION: '', CODEXIA_BACKUP_AGE_RECIPIENT: '',
    GITHUB_SHA: 'd'.repeat(40), GITHUB_REPOSITORY: 'yohn-jp/codexia',
  };
  writeFileSync(path.join(bin, 'gh'), '#!/bin/bash\nprintf "%s\\n" "$GITHUB_SHA"\n', { mode: 0o700 });
  let result = spawnSync('/bin/bash', ['-c', converge.run], { cwd: directory, env: manual, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(invocation), false, 'manual invocation needs the verified R6 receipt');
  const binding = {
    hostId: 'a'.repeat(64), clusterId: '123', databaseOid: '456', settingsSha256: 'b'.repeat(64),
    ownerBindingSha256: 'sha256:' + 'c'.repeat(64), notBeforeMs: 1, notAfterMs: 2,
  };
  writeFileSync(path.join(directory, 'codexia-first-activation.json'), JSON.stringify(binding), { mode: 0o600 });
  result = spawnSync('/bin/bash', ['-c', converge.run], { cwd: directory, env: manual, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const vars = JSON.parse(readFileSync(path.join(directory, 'codexia-deploy-vars.json'), 'utf8'));
  assert.deepEqual(vars.codexia_expected_first_activation, binding);
  assert.equal(vars.codexia_backup_destination, undefined);
  assert.equal(vars.codexia_backup_recipient, undefined);
  assert.equal(vars.codexia_initial_install_approved, true);
  assert.equal(vars.codexia_database_initialization_approved, true);

  rmSync(invocation);
  const recovery = { ...manual, CODEXIA_FIRST_ACTIVATION_APPROVAL: 'PUBLISH_RESTORED_CODEXIA_BACKEND' };
  result = spawnSync('/bin/bash', ['-c', converge.run], { cwd: directory, env: recovery, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(invocation), false, 'R3 cannot use a verified R6 receipt');
  const restored = { ...binding, operationId: 'restore-fixture', evidenceSha256: 'c'.repeat(64) };
  writeFileSync(path.join(directory, 'codexia-recovery-activation.json'), JSON.stringify(restored), { mode: 0o600 });
  result = spawnSync('/bin/bash', ['-c', converge.run], { cwd: directory, env: recovery, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const recoveryVars = JSON.parse(readFileSync(path.join(directory, 'codexia-deploy-vars.json'), 'utf8'));
  assert.deepEqual(recoveryVars.codexia_expected_recovery_activation, restored);
  assert.equal(recoveryVars.codexia_expected_first_activation, undefined);
  assert.equal(recoveryVars.codexia_initial_install_approved, false);
  assert.equal(recoveryVars.codexia_database_initialization_approved, false);

  // An existing Better Auth owner is adopted through an independent reviewed
  // receipt and distinct approval; the fresh-install flags must stay false.
  rmSync(invocation);
  const adoption = { ...manual, CODEXIA_FIRST_ACTIVATION_APPROVAL: 'ADOPT_EXISTING_CODEXIA_BACKEND',
    CODEXIA_INITIAL_INSTALL_APPROVED: 'false', CODEXIA_DATABASE_INITIALIZATION_APPROVED: 'false',
    CODEXIA_DATABASE_ADOPTION_APPROVED: 'true' };
  result = spawnSync('/bin/bash', ['-c', converge.run], { cwd: directory, env: adoption, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, 'adoption cannot consume the first-install R6 receipt');
  assert.equal(existsSync(invocation), false);
  const adopted = { ...binding, preservationSha256: 'd'.repeat(64), secretSetSha256: 'e'.repeat(64) };
  writeFileSync(path.join(directory, 'codexia-adopt-activation.json'), JSON.stringify(adopted), { mode: 0o600 });
  result = spawnSync('/bin/bash', ['-c', converge.run], { cwd: directory, env: adoption, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const adoptionVars = JSON.parse(readFileSync(path.join(directory, 'codexia-deploy-vars.json'), 'utf8'));
  assert.deepEqual(adoptionVars.codexia_expected_adopt_activation, adopted);
  assert.equal(adoptionVars.codexia_database_adoption_approved, true);
  assert.equal(adoptionVars.codexia_initial_install_approved, false);
  assert.equal(adoptionVars.codexia_database_initialization_approved, false);
});

test('Ansible routes the push stage through the codexia runtime and host lock', () => {
  const route = site.tasks.find(task => task.name === 'Deploy the certified image under a serialized host lock');
  assert.ok(route, 'site.yml must route the push deployment stage');
  assert.equal(route['ansible.builtin.include_tasks'].file, 'deploy.yml');
  assert.equal(route.when, "codexia_stage == 'deploy'");

  assert.ok(site.tasks.every(task => !JSON.stringify(task).includes('codexia-updater')));

  const deployment = parse(readFileSync(new URL('../../../deploy/ansible/deploy.yml', import.meta.url), 'utf8'));
  assert.ok(deployment.some(task => task['ansible.builtin.include_tasks'] === 'deploy-transaction.yml'));
  assert.ok(transactionTasks.some(task => task.name === 'Admit the published candidate against installed API and deployed UI identities'));
  const candidateIdentity = transactionTasks.find(task => task.name === 'Require candidate image source, profile and database compatibility identity');
  assert.ok(candidateIdentity['ansible.builtin.assert'].that.includes('codexia_candidate_identity == codexia_deployment_certificate.identity'));
  const activeUnit = transactionTasks.find(task => task.name === 'Require the existing API unit before an image-only update');
  assert.ok(activeUnit, 'image-only updates must retain a concrete prior unit for rollback');
  assert.equal(activeUnit.when, 'codexia_current_container_exists.rc == 0');
  assert.equal(transactionTasks[0]['ansible.builtin.include_tasks'], 'deploy-prepare.yml');
  const prepare = parse(readFileSync(new URL('../../../deploy/ansible/deploy-prepare.yml', import.meta.url), 'utf8'));
  assert.match(prepare[0]['ansible.builtin.command'].stdin, /push-deployment-recover\.sh/u,
    'recovery must run before helpers or target state are changed');
  const recoveryScript = readFileSync(new URL('../../../deploy/ansible/push-deployment-recover.sh', import.meta.url), 'utf8');
  assert.match(recoveryScript, /deploy-transaction\.json/u);
  assert.match(recoveryScript, /rollback-api\.container/u);
  assert.match(recoveryScript, /flock --exclusive --nonblock/u);
  const transaction = transactionTasks.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  assert.ok(transaction, 'Ansible must keep the service change and rollback inside one locked transaction');
  assert.match(transaction['ansible.builtin.shell'].cmd, /flock --exclusive --nonblock/u);
  assert.match(transaction['ansible.builtin.shell'].cmd, /\$\{\{ '\{' \}\}#rollback_images/u,
    'bash array-length syntax must be escaped from Jinja comment parsing');
  assert.equal(transaction.args.executable, '/bin/bash');
  assert.equal(transaction.no_log, true, 'the deployment transaction must not log secret values');
  assert.equal(transaction.failed_when, false, 'the transaction result must be available for a separate sanitized failure report');
  const safeFailure = transactionTasks.find(task => task.name === 'Report only an allowlisted deployment transaction failure stage');
  assert.ok(safeFailure, 'failed transaction output must be summarized with fixed public labels');
  assert.match(safeFailure.when, /codexia_deploy_transaction\.rc/u);
  assert.match(safeFailure['ansible.builtin.fail'].msg, /fresh database schema initialization/u);
  assert.match(safeFailure['ansible.builtin.fail'].msg, /PostgreSQL connectivity/u);
  assert.match(safeFailure['ansible.builtin.fail'].msg, /container runtime or unclassified initializer error/u);
  assert.doesNotMatch(safeFailure['ansible.builtin.fail'].msg, /stderr\s*\}\}/u,
    'raw transaction stderr must never be rendered into an Ansible failure message');
  assert.match(transaction['ansible.builtin.shell'].cmd, /default\.target\.wants/u, 'the API must recover after a VM reboot');
  assert.match(transaction['ansible.builtin.shell'].cmd, /if \[\[ "\$had_unit" == true \]\]; then\n\s+if ! artifact=.*deploy-backup.*\n[\s\S]*?deploy-finish/u, 'updates must commit an encrypted off-VM backup under the same lock');
  assert.match(transaction['ansible.builtin.shell'].cmd, /restore_previous/u, 'failed candidate activation must restore the prior release');
  assert.match(transaction['ansible.builtin.shell'].cmd, /stop codexia-api\.service[\s\S]*running_image[\s\S]*candidate_image/u, 'candidate acceptance must follow successful shutdown and match the certified running digest');
  assert.match(transaction['ansible.builtin.shell'].cmd, /restored_image[\s\S]*rollback_image/u, 'rollback health must be bound to the prior digest snapshot');
  assert.match(transaction['ansible.builtin.shell'].cmd, /deploy-transaction\.json/u, 'a durable transaction intent must make interrupted deployments recoverable');
  assert.match(transaction['ansible.builtin.shell'].cmd, /current_image.*candidate_image/su, 'same-digest application must be idempotent');
  assert.match(transaction['ansible.builtin.shell'].cmd, /Candidate API readiness failed; deployment transaction remains pending if rollback is unverified/u);
});

test('manual first Backend activation uses protected admission and the existing deployment transaction', () => {
  assert.equal(handoff.on.workflow_dispatch.inputs.approval_phrase.required, true);
  const verify = handoff.jobs['verify-handoff'];
  const deploy = handoff.jobs['deploy-production'];
  assert.equal(verify.environment, undefined);
  assert.equal(verify.permissions['id-token'], undefined);
  assert.match(deploy.if, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(deploy.if, /inputs\.approval_phrase == 'ACTIVATE_CODEXIA_BACKEND'/u);
  assert.equal(deploy.concurrency.group, 'codexia-production');
  const checkout = deploy.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.match(checkout.with.ref, /github\.event_name == 'workflow_dispatch' && github\.sha/u);
  const admit = deploy.steps.find(step => step.name === 'Reverify the reviewed deployment plan after entering the production queue');
  const apply = deploy.steps.find(step => step.name === 'Converge certified backend digest');
  assert.ok(deploy.steps.indexOf(admit) < deploy.steps.indexOf(apply));
  assert.doesNotMatch(JSON.stringify(admit), /CUTOVER_(WORKER|FENCE)_TOKEN/u);
  assert.match(apply.run, /codexia_expected_first_activation/u);
  assert.match(apply.run, /deploy\/ansible\/site\.yml/u);

  const transaction = transactionTasks.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  const shell = transaction['ansible.builtin.shell'].cmd;
  const lock = shell.indexOf('flock --exclusive --nonblock 9');
  const binding = shell.indexOf('the prepared first activation database or owner changed');
  assert.ok(lock >= 0 && binding > lock && binding < shell.indexOf('deploy-backup'));
  const prepare = parse(readFileSync(new URL('../../../deploy/ansible/deploy-prepare.yml', import.meta.url), 'utf8'));
  assert.equal(prepare.find(task => task.name === 'Recover interrupted deployment before preparing target state').when,
    'codexia_expected_first_activation is not defined and codexia_expected_recovery_activation is not defined and codexia_expected_adopt_activation is not defined');
  assert.equal(prepare.find(task => task.name === 'Resume an interrupted backup before observing the installed API').when,
    'codexia_expected_recovery_activation is not defined and codexia_expected_adopt_activation is not defined');
});

test('locked production admission requires separate R6 or restored R3 evidence for a clean API slot', () => {
  const shell = transactionTasks.find(task => task.name === 'Apply or recover the API Quadlet under the host lock')['ansible.builtin.shell'].cmd;
  const gateStart = shell.indexOf('if [[ "$had_unit" == false && "$require_production_admission" == true && "$first_activation" == null && "$recovery_activation" == null && "$adoption_activation" == null ]]; then');
  const gateEnd = shell.indexOf('first_activation_window_current(){', gateStart);
  assert.ok(gateStart > shell.indexOf('flock --exclusive --nonblock 9') &&
    gateEnd > gateStart && gateEnd < shell.indexOf('deploy-backup'));
  const gate = shell.slice(gateStart, gateEnd);
  const prefix = 'set -eu\nstale_admission(){ printf "%s\\n" "$1" >&2; exit 1; }\n';
  for (const [hadUnit, production, evidence, recovery, adoption, expected] of [
    ['false', 'true', 'null', 'null', 'null', 1],
    ['false', 'true', '{}', 'null', 'null', 0],
    ['false', 'true', 'null', '{}', 'null', 0],
    ['false', 'true', 'null', 'null', '{}', 0],
    ['true', 'true', 'null', 'null', 'null', 0],
    ['false', 'false', 'null', 'null', 'null', 0],
  ]) {
    const result = spawnSync('bash', ['-c', prefix + gate], {
      encoding: 'utf8', env: { ...process.env, had_unit: hadUnit, require_production_admission: production,
        first_activation: evidence, recovery_activation: recovery, adoption_activation: adoption },
    });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stderr);
    if (expected) assert.match(result.stderr, /first activation requires an approved R6 plan/u);
  }
});

test('locked fresh activation requires the installation marker to bind the database and candidate', t => {
  const { cmd: shell } = transactionTasks.find(task =>
    task.name === 'Apply or recover the API Quadlet under the host lock')['ansible.builtin.shell'];
  const start = shell.indexOf('for marker in owner-setup.installation');
  const end = shell.indexOf('live_runtime=', start);
  assert.ok(start > shell.indexOf('flock --exclusive --nonblock 9') && end > start);
  const gate = shell.slice(start, end)
    .replace(/\{\{ .*owner-setup\.container.* \}\}/u, '"$FIXTURE/owner-setup.container"');
  const fixture = mkdtempSync(path.join(tmpdir(), 'codexia-fresh-intent-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const image = 'ghcr.io/yohn-jp/codexia-backend@sha256:' + 'a'.repeat(64);
  for (const [name, value] of [
    ['owner-setup.installation', '123'],
    ['owner-setup.promoted', 'activation-ready'],
    ['owner-setup.container', 'Image=' + image],
  ]) writeFileSync(path.join(fixture, name), value + '\n', { mode: 0o600 });
  const intent = path.join(fixture, 'owner-setup.intent');
  const verify = () => spawnSync('bash', ['-c', [
    'set -eu', 'state_dir="$FIXTURE"; approved_cluster=123; approved_database=456; candidate_image="$IMAGE"',
    'stale_admission(){ echo "$1" >&2; exit 1; }', gate,
  ].join('\n')], { env: { ...process.env, FIXTURE: fixture, IMAGE: image, CODEXIA_TARGET_REPOSITORY: 'yohn-jp/codexia',
    CODEXIA_TARGET_REPOSITORY_ID: '401', CODEXIA_TARGET_OWNER_ID: '502' }, encoding: 'utf8' });
  assert.match(verify().stderr, /prepared owner markers are unavailable/u);
  writeFileSync(intent, 'yohn-jp/codexia:401:502:123:789:' + image + '\n', { mode: 0o600 });
  assert.match(verify().stderr, /fresh installation identity changed/u);
  writeFileSync(intent, 'yohn-jp/codexia:401:502:123:456:' + image + '\n', { mode: 0o600 });
  const approved = verify();
  assert.equal(approved.status, 0, approved.stderr);
});

test('first activation checks the real transaction window at readiness and rolls back before publication', t => {
  const shell = transactionTasks.find(task => task.name === 'Apply or recover the API Quadlet under the host lock')['ansible.builtin.shell'].cmd;
  const clockStart = shell.indexOf('first_activation_window_current(){');
  const clockEnd = shell.indexOf('if [[ "$first_activation" != null ]]; then', clockStart);
  const transactionStart = shell.indexOf('restore_previous(){');
  const transactionEnd = shell.indexOf('if ! node - "$candidate_image" "$current_image"', transactionStart);
  assert.ok(clockStart >= 0 && clockEnd > clockStart && transactionStart > clockEnd && transactionEnd > transactionStart);
  const clock = shell.slice(clockStart, clockEnd);
  const transaction = shell.slice(transactionStart, transactionEnd)
    .replaceAll("{{ '{{' }}", '{{').replaceAll("{{ '}}' }}", '}}');
  assert.match(transaction, /require_activation_window_or_restore\nif ! install -m 0600/u);
  assert.match(transaction, /require_activation_window_or_restore\nif ! gate_control open/u);

  const directory = mkdtempSync(path.join(tmpdir(), 'codexia-first-activation-window-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const prefix = [
    'set -eu -o pipefail',
    'state_dir="$FIXTURE"',
    'active_unit="$FIXTURE/active.container"',
    'candidate_unit="$FIXTURE/candidate.container"',
    'api_wants_link="$FIXTURE/api.service"',
    'transaction_intent="$FIXTURE/deploy-transaction.json"',
    'release_state="$FIXTURE/deployed-release.json"',
    'trace="$FIXTURE/trace"',
    'had_unit=false; gate_was_open=false; release_present=false',
    'api_link_created=true',
    'gate_control() { printf "gate %s\n" "$1" >> "$trace"; if [[ "$SCENARIO" == restore-close-failure && "$1" == close && -f "$FIXTURE/gate-state" ]]; then return 1; fi; printf "%s\n" "$1" > "$FIXTURE/gate-state"; }',
    'curl() { [[ "$*" == *"http://127.0.0.1:18081/health/ready" ]] && grep -qx close "$FIXTURE/gate-state"; }',
    'candidate_image=fixture-image; first_activation="{}"; recovery_activation=null; adoption_activation=null; approved_not_before=1000; approved_not_after=2000',
    'clock=1500; backup_control=control_fixture; backup_run_id=; backup_pending_id=',
    'if [[ "$SCENARIO" == recovery-* ]]; then first_activation=null; recovery_activation="{}"; fi',
    'check_recovery_record() { [[ "$clock" == 1500 ]]; }',
    'stale_admission() { echo "$1" >&2; exit 1; }',
    'control_fixture() { printf "Unexpected Console command: %s\\n" "$*" >&2; exit 98; }',
    'date() { if [[ -f "$FIXTURE/clock" ]]; then cat "$FIXTURE/clock"; else printf "%s\\n" "$clock"; fi; }',
    'run_auth_cli() { echo auth >> "$trace"; }',
    'install_wants_links() { :; }',
    'podman() { case "$*" in *State.Health.Status*) echo healthy;; *ImageName*) echo "$candidate_image";; run*) echo ledger >> "$trace"; if [[ "$SCENARIO" == pre-start ]]; then echo 2001 > "$FIXTURE/clock"; fi;; *) return 99;; esac; }',
    'systemctl() { printf "%s\\n" "$*" >> "$trace"; if [[ "$*" == "--user start codexia-api.service" && ( "$SCENARIO" == startup || "$SCENARIO" == stop-failure || "$SCENARIO" == recovery-stale || "$SCENARIO" == restore-close-failure ) ]]; then clock=2001; fi; if [[ "$*" == "--user stop codexia-api.service" && "$SCENARIO" == stop-failure ]]; then return 1; fi; }',
    'test -f "$candidate_unit"',
  ].join('\n') + '\n';
  for (const scenario of ['pre-start', 'startup', 'stop-failure', 'restore-close-failure', 'within-window', 'recovery-current', 'recovery-stale']) {
    const fixture = path.join(directory, scenario);
    mkdirSync(fixture);
    for (const name of ['candidate.container', 'api.service', 'deploy-transaction.json',
      'owner-setup.installation', 'owner-setup.promoted', 'database-sentinel', 'backup-sentinel']) {
      writeFileSync(path.join(fixture, name), name);
    }
    const result = spawnSync('bash', ['-c', prefix + clock + transaction], {
      encoding: 'utf8', env: { ...process.env, FIXTURE: fixture, SCENARIO: scenario },
    });
    assert.ifError(result.error);
    const success = scenario === 'within-window' || scenario === 'recovery-current';
    assert.equal(result.status, success ? 0 : 1, scenario + ': ' + result.stderr);
    const calls = readFileSync(path.join(fixture, 'trace'), 'utf8');
    assert.match(calls, /^ledger$/mu);
    assert.doesNotMatch(result.stderr, /Unexpected Console command/u);
    assert.equal(calls.includes('--user start codexia-api.service'), scenario !== 'pre-start');
    assert.equal(calls.includes('gate open'), success);
    const closeGate = calls.indexOf('gate close');
    const startApi = calls.indexOf('--user start codexia-api.service');
    const stopApi = calls.indexOf('--user stop codexia-api.service');
    const openGate = calls.indexOf('gate open');
    assert.ok(closeGate >= 0 && (startApi < 0 || closeGate < startApi));
    if (success) assert.ok(openGate > startApi);
    if (scenario === 'restore-close-failure') assert.equal(stopApi, -1, 'an unverified gate must prevent shutdown');
    else if (!success && startApi >= 0) assert.ok(stopApi > startApi);
    assert.equal(readFileSync(path.join(fixture, 'gate-state'), 'utf8').trim(), success ? 'open' : 'close');
    if (!success) assert.match(result.stderr, scenario === 'recovery-stale'
      ? /restored target or approval changed before publication/u
      : /First activation approval window expired before publication/u);
    const retained = success || scenario === 'stop-failure' || scenario === 'restore-close-failure';
    assert.equal(existsSync(path.join(fixture, 'active.container')), retained);
    for (const name of ['deploy-transaction.json', 'api.service']) {
      assert.equal(existsSync(path.join(fixture, name)), retained, scenario + ': ' + name);
    }
    for (const name of ['owner-setup.installation', 'owner-setup.promoted', 'database-sentinel', 'backup-sentinel']) {
      assert.equal(readFileSync(path.join(fixture, name), 'utf8'), name);
    }
  }

  // The ordinary compatible-update and disposable-fixture paths carry no R6
  // window. Invalid or unavailable clock evidence fails closed only for R6.
  for (const [evidence, current, expected] of [['null', 'invalid', 0], ['{}', '999', 1],
    ['{}', '1000', 0], ['{}', '2000', 0], ['{}', '2001', 1], ['{}', 'invalid', 1]]) {
    const result = spawnSync('bash', ['-c', 'set -eu\napproved_not_before=1000; approved_not_after=2000\ndate(){ printf "%s\\n" "$CLOCK"; }\n' + clock + '\nfirst_activation_window_current'], {
      encoding: 'utf8', env: { ...process.env, first_activation: evidence, adoption_activation: 'null', CLOCK: current },
    });
    assert.ifError(result.error);
    assert.equal(result.status, expected, evidence + ': ' + current);
  }
});

test('rollback clears candidate start-limit failures before restarting the prior API', () => {
  const transaction = transactionTasks.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  const shell = transaction['ansible.builtin.shell'].cmd;
  const restore = shell.slice(shell.indexOf('restore_previous(){'), shell.indexOf('if { [[ "$tunnel_present" == true ]]'));
  const install = restore.indexOf('install -m 0600 "$state_dir/rollback-api.container" "$active_unit"');
  const reload = restore.indexOf('systemctl --user daemon-reload', install);
  const reset = restore.indexOf('systemctl --user reset-failed codexia-api.service', reload);
  const start = restore.indexOf('systemctl --user start codexia-api.service', reset);
  const health = restore.indexOf('podman inspect --format', start);
  assert.ok(install >= 0 && reload > install && reset > reload && start > reset && health > start,
    'rollback must restore and reload the prior unit, reset candidate start-limit state, then start and verify health');

  const recovery = readFileSync(new URL('../../../deploy/ansible/push-deployment-recover.sh', import.meta.url), 'utf8');
  const recoveryInstall = recovery.indexOf('install -m 0600 -- "$state_dir/rollback-api.container" "$active_unit"');
  const recoveryReload = recovery.indexOf('systemctl --user daemon-reload', recoveryInstall);
  const recoveryReset = recovery.indexOf('systemctl --user reset-failed codexia-api.service', recoveryReload);
  const recoveryStart = recovery.indexOf('systemctl --user start codexia-api.service', recoveryReset);
  const recoveryHealth = recovery.indexOf('podman inspect --format', recoveryStart);
  assert.ok(recoveryInstall >= 0 && recoveryReload > recoveryInstall && recoveryReset > recoveryReload &&
    recoveryStart > recoveryReset && recoveryHealth > recoveryStart,
    'interrupted transaction recovery must clear start limits only after restoring the prior unit');
});

test('deployment requires the rootless base runtime under the lock before activation', () => {
  const transaction = transactionTasks.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  const shell = transaction['ansible.builtin.shell'].cmd;
  const start = shell.indexOf('if ! podman volume exists codexia-history');
  const end = shell.indexOf("current_container=''", start);
  assert.ok(start > shell.indexOf('flock --exclusive --nonblock') && end > start);
  assert.ok(end < shell.indexOf('mkdir -p "$wants_dir"'));
  const preflight = shell.slice(start, end).replaceAll('{% raw %}', '').replaceAll('{% endraw %}', '');
  const fixtureCommands = `
    set -eu -o pipefail
    unit_dir=/tmp/codexia-quadlets
    podman() {
      case "$1" in
        volume) [[ "$*" == 'volume exists codexia-history' && "$missing" != history ]];;
        inspect) [[ "$4" == codexia-db ]] && printf '%s\\n' "$db_health";;
        *) return 99;;
      esac
    }
    systemctl() {
      case "$*" in
        '--user is-active --quiet codexia-db.service') [[ "$missing" != db ]];;
        '--user show --property=SourcePath --value codexia-db.service') [[ "$missing" != db-source ]] && printf '%s\\n' "$unit_dir/codexia-db.container";;
        'is-active codexia-cloudflared.service') [[ "$missing" != management ]] && printf '%s\\n' active;;
        *) return 99;;
      esac
    }
  `;
  const safeFailure = transactionTasks.find(task => task.name === 'Report only an allowlisted deployment transaction failure stage');
  for (const [missing, dbHealth, gateState, error] of [
    ['history', 'healthy', 'closed', 'Deployment base runtime requires the rootless history volume'],
    ['db', 'healthy', 'closed', 'Deployment base runtime requires a healthy rootless PostgreSQL Quadlet'],
    ['', 'unhealthy', 'closed', 'Deployment base runtime requires a healthy rootless PostgreSQL Quadlet'],
    ['db-source', 'healthy', 'closed', 'Deployment base runtime requires the canonical generated PostgreSQL unit'],
    ['management', 'healthy', 'closed', 'Deployment requires the independent host Cloudflare connector'],
    ['gate', 'healthy', 'closed', 'Publication gate state is not canonical'],
    ['', 'healthy', 'invalid', 'Publication gate helper returned an invalid state'],
    ['', 'healthy', 'closed', ''],
    ['', 'healthy', 'open', ''],
  ]) {
    const result = spawnSync('bash', ['-c', fixtureCommands +
      'gate_control() { [[ "$missing" != gate ]] && printf "%s\n" "$GATE_STATE"; }\n' + preflight], {
      encoding: 'utf8',
      env: { ...process.env, missing, db_health: dbHealth, GATE_STATE: gateState },
    });
    assert.ifError(result.error);
    assert.equal(result.status, error ? 1 : 0, result.stderr);
    assert.equal(result.stderr.trim(), error);
    if (error && !error.includes('helper returned')) assert.ok(safeFailure['ansible.builtin.fail'].msg.includes(error));
  }
  assert.match(safeFailure['ansible.builtin.fail'].msg,
    /'encrypted backup' if 'Encrypted backup failed; candidate was not applied'/u);
});

test('production admission reuses canonical runtime validators and checks exact generated Quadlets', () => {
  const transactionStages = transactionTasks;
  const preflightTask = transactionStages.find(task => task.name ===
    'Reuse the canonical rootless base admission before production activation');
  assert.equal(preflightTask['ansible.builtin.include_tasks'], 'verify-deploy-base-runtime.yml');
  assert.equal(preflightTask.when, 'not (codexia_lifecycle_fixture | default(false) | bool)');
  const checks = parse(readFileSync(new URL('../../../deploy/ansible/verify-deploy-base-runtime.yml', import.meta.url), 'utf8'));
  const quadlets = checks.find(task => task.name === 'Inspect every canonical base Quadlet without following links');
  assert.deepEqual(quadlets.loop, [
    'codexia.network', 'codexia-data.network', 'codexia-postgres.volume', 'codexia-data.volume',
    'codexia-history.volume', 'codexia-db.container',
  ]);
  const fileAdmission = checks.find(task => task.name ===
    'Require every base Quadlet to match the reviewed repository source');
  assert.ok(fileAdmission['ansible.builtin.assert'].that.some(clause =>
    clause.includes("hash('sha256')")));
  const generatedOrigins = checks.find(task => task.name === 'Require PostgreSQL to originate from its canonical rootless Quadlet');
  assert.ok(generatedOrigins['ansible.builtin.assert'].that.some(clause =>
    clause.includes("codexia_deploy_base_db_source.stdout == quadlet_dir + '/codexia-db.container'")));
  const includes = checks.filter(task => task['ansible.builtin.include_tasks'])
    .map(task => task['ansible.builtin.include_tasks']);
  assert.deepEqual(includes, ['verify-base-db-container.yml']);
  assert.deepEqual(checks.find(task => task.name === 'Require the independent host Cloudflare connector')['ansible.builtin.command'].argv,
    ['systemctl', 'is-active', 'codexia-cloudflared.service']);
  const networks = checks.find(task => task.name === 'Verify the canonical private network isolation before deployment');
  assert.deepEqual(networks.loop.map(value => value.expected), ['codexia|bridge|false', 'codexia-data|bridge|true']);
  const shell = transactionStages.find(task => task.name === 'Apply or recover the API Quadlet under the host lock')['ansible.builtin.shell'].cmd;
  assert.match(shell, /systemctl --user show --property=SourcePath --value codexia-db\.service/u);
  assert.match(shell, /gate_state="\$\(gate_control status\)"/u);
});

test('first activation verifies the initialized database under both explicit approvals without Console backup', () => {
  const deployment = transactionTasks;
  const approval = deployment.find(task => task.name === 'Refuse implicit first activation without explicit verified schema approval');
  assert.deepEqual(approval['ansible.builtin.assert'].that, [
    'codexia_initial_install_approved | default(false) | bool',
    'codexia_database_initialization_approved | default(false) | bool',
    '(codexia_lifecycle_fixture | default(false) | bool) or (codexia_expected_first_activation | default(none)) is mapping',
  ]);
  const transaction = deployment.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  const shell = transaction['ansible.builtin.shell'].cmd;
  const freshMigration = shell.indexOf('verifyPostgresSchema');
  const startApi = shell.indexOf('systemctl --user start codexia-api.service', shell.indexOf('install -m 0600 "$candidate_unit" "$active_unit"'));
  assert.ok(freshMigration >= 0 && startApi > freshMigration,
    'first schema verification must precede API activation');
  assert.match(shell, /if \[\[ "\$had_unit" == true \]\]; then\n\s+if ! artifact=.*deploy-backup/u,
    'the pre-update backup applies only to an installed API');
  assert.match(shell, /podman run --rm --network codexia-data[\s\S]*--secret=codexia-postgres-app-password[\s\S]*candidate_image/u);
  assert.match(shell, /verifyPostgresSchema\(connectionString\)/u);
  assert.match(shell, /if \[\[ "\$had_unit" != true \]\]; then[\s\S]*verifyPostgresSchema/u);
  assert.doesNotMatch(shell, /DATABASE_MIGRATE_ON_START=1/u,
    'the one-shot schema verification must not enable recurring startup migrations');
  const persistencePackage = JSON.parse(readFileSync(new URL('../../../packages/persistence-postgres/package.json', import.meta.url), 'utf8'));
  const persistenceExports = readFileSync(new URL('../../../packages/persistence-postgres/src/index.ts', import.meta.url), 'utf8');
  assert.ok(persistencePackage.files.includes('dist') && persistencePackage.files.includes('migrations'),
    'the candidate image must carry the initializer and its reviewed migrations');
  assert.match(persistenceExports, /export \{[^}]*initializeFreshPostgresSchema[^}]*\} from "\.\/migrate\.js"/u);
});

test('failed fresh-schema verification restores a first activation without stopping an absent API service', () => {
  const tasks = transactionTasks;
  const transaction = tasks.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  const shell = transaction['ansible.builtin.shell'].cmd;
  const restore = shell.slice(shell.indexOf('restore_previous(){'), shell.indexOf('if { [[ "$tunnel_present" == true ]]'));
  assert.ok(restore.startsWith('restore_previous(){'), 'canonical rollback helper must be present');
  assert.match(restore, /if \[\[ "\$had_unit" == true \|\| -e "\$active_unit" \|\| -L "\$active_unit" \]\]; then[\s\S]*?systemctl --user stop codexia-api\.service/u,
    'a missing generated API unit must not make first-install recovery fail');
  assert.match(restore, /rm -f -- "\$active_unit"/u, 'fresh install rollback must remove the candidate unit');
  assert.match(restore, /rm -f -- "\$transaction_intent"/u, 'successful rollback must clear durable intent');
});

test('fresh auth staging initializes the application ledger before provisioning auth schema', () => {
  const authRuntime = parse(readFileSync(new URL('../../../deploy/ansible/auth-runtime.yml', import.meta.url), 'utf8'));
  const initialize = authRuntime.find(task => task['ansible.builtin.command']?.argv?.includes('initialize-application'));
  assert.equal(initialize.when, 'not codexia_auth_database_state_value.applicationLedgerExists');
  const provision = authRuntime.find(task => task['ansible.builtin.command']?.argv?.includes('converge'));
  assert.ok(authRuntime.indexOf(initialize) < authRuntime.indexOf(provision));
  const helper = readFileSync(new URL('../../../deploy/ansible/provision-auth-database.sh', import.meta.url), 'utf8');
  assert.match(helper, /flock --exclusive --nonblock[\s\S]*await initializeFreshPostgresSchema/u);
});

test('push rollout admits backups after API shutdown and verified product publication closure', () => {
  const deployment = readFileSync(new URL('../../../deploy/ansible/deploy-transaction.yml', import.meta.url), 'utf8');
  const backup = readFileSync(new URL('../../../deploy/backup/backup.sh', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../deploy/backup/backup-runner.sh', import.meta.url), 'utf8');
  assert.match(deployment, /systemctl --user stop codexia-api\.service[\s\S]*?deploy-backup/u);
  assert.match(runner, /backup-locked[\s\S]*--approved[\s\S]*--lock-file[\s\S]*--lock-fd 9/u);
  assert.match(backup, /Push deployment requires the API service to be inactive/u);
  assert.match(backup, /Push deployment requires the product publication gate to be closed/u);
  assert.match(backup, /Management Tunnel connector must remain active/u);
  assert.doesNotMatch(backup, /codexia-updater|--push-deployment/u);
});

test('push activation keeps one canonical API writer and opens publication after readiness', () => {
  const deploy = transactionTasks;
  const transaction = deploy.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  assert.ok(transaction, 'the app activation must remain one serialized transaction');
  const shell = transaction['ansible.builtin.shell'].cmd;

  const closeGate = shell.indexOf('! gate_control close ||', shell.indexOf('# Hold publication across reboot'));
  const createApiLink = shell.indexOf('! install_wants_links ||', closeGate);
  const stopApi = shell.indexOf('systemctl --user stop codexia-api.service', closeGate);
  const installCandidate = shell.indexOf('install -m 0600 "$candidate_unit" "$active_unit"');
  const startCandidate = shell.indexOf('systemctl --user start codexia-api.service', installCandidate);
  const readiness = shell.indexOf('if [[ "$candidate_health" != healthy ]]');
  const openGate = shell.indexOf('if ! gate_control open;', readiness);
  const commitRelease = shell.indexOf('mv -f -- "$release_state.tmp" "$release_state"');
  for (const [name, position] of Object.entries({ closeGate, createApiLink, stopApi, installCandidate, startCandidate, readiness, openGate, commitRelease })) {
    assert.notEqual(position, -1, `deployment transaction must include ${name}`);
  }
  assert.ok(closeGate < createApiLink && createApiLink < stopApi,
    'Product publication must close before creating the API activation link or stopping the writer');
  assert.ok(stopApi < installCandidate, 'the old writer must stop before the candidate unit is installed');
  assert.ok(installCandidate < startCandidate && startCandidate < readiness,
    'candidate readiness must be observed after starting its canonical API service');
  assert.ok(readiness < openGate && openGate < commitRelease,
    'Product publication and the release record must follow candidate readiness');

  const apiUnit = readFileSync(new URL('../../../deploy/quadlet/codexia-api.container', import.meta.url), 'utf8');
  const connectorUnit = readFileSync(new URL('../../../cmd/codexiactl/assets/codexia-cloudflared.service', import.meta.url), 'utf8');
  const socketUnit = readFileSync(new URL('../../../deploy/systemd/codexia-api.socket', import.meta.url), 'utf8');
  const databaseUnit = readFileSync(new URL('../../../deploy/quadlet/codexia-db.container', import.meta.url), 'utf8');
  assert.match(apiUnit, /^ContainerName=codexia-api$/mu);
  assert.match(apiUnit, /^Network=codexia\.network$/mu);
  assert.match(apiUnit, /^Network=codexia-data\.network$/mu);
  assert.match(apiUnit, /^Volume=codexia-data\.volume:\/data$/mu);
  assert.match(apiUnit, /^Volume=codexia-history\.volume:\/history$/mu);
  assert.match(apiUnit, /^PublishPort=127\.0\.0\.1:18081:3000\/tcp$/mu);
  assert.match(socketUnit, /^ListenStream=127\.0\.0\.1:18080$/mu);
  assert.doesNotMatch(connectorUnit, /codexia-(?:api|db)\.service/u);
  assert.doesNotMatch(shell, /systemctl[^\n]*(?:stop|start|restart|mask)[^\n]*codexia-cloudflared\.service/u);
  assert.match(databaseUnit, /^ContainerName=codexia-db$/mu);
  assert.match(databaseUnit, /^Volume=codexia-postgres\.volume:\/var\/lib\/postgresql\/data$/mu);
  assert.match(databaseUnit, /^Environment=POSTGRES_DB=codexia$/mu);
  assert.match(databaseUnit, /^Environment=POSTGRES_USER=codexia_admin$/mu);
  assert.doesNotMatch(shell, /(?:cp|install|rm|mv|ln)[^\n]*codexia-db\.container|codexia-postgres\.volume|podman volume (?!exists codexia-history\b)/u,
    'an image-only API rollout must leave canonical PostgreSQL storage untouched');

  const restore = shell.indexOf('restore_previous(){');
  const restoreStartApi = shell.indexOf('systemctl --user start codexia-api.service', restore);
  const restoreHealth = shell.indexOf('podman inspect --format', restoreStartApi);
  const restoreOpenGate = shell.indexOf('gate_control open', restoreHealth);
  assert.ok(restore !== -1 && restoreStartApi > restore && restoreHealth > restoreStartApi && restoreOpenGate > restoreHealth,
    'rollback must restore and health-check the previous API before restoring product publication');
});

test('Better Auth activation uses protected staged settings on a fresh or existing API', () => {
  const installedAuth = transactionTasks.find(task => task.name === 'Require an installed Better Auth API for image-only updates');
  assert.equal(installedAuth.when, 'codexia_current_container_exists.rc == 0');
  const staging = transactionTasks.find(task => task.name === 'Require private staged Better Auth settings before activation');
  assert.equal(staging.when, undefined);
  assert.ok(transactionTasks.indexOf(installedAuth) < transactionTasks.indexOf(staging));
  assert.ok(transactionTasks.some(task => task.name === 'Require complete public Better Auth settings without secret material in the environment file'));
  assert.ok(transactionTasks.some(task => task.name === 'Verify every staged Better Auth Podman secret exists before activation'));
  const candidate = transactionTasks.find(task => task.name === 'Render a digest-specific candidate Quadlet outside the active unit path');
  assert.match(candidate['ansible.builtin.copy'].content, /codexia-api\.container/u);
  assert.match(candidate['ansible.builtin.copy'].content, /AUTH_SETTINGS_DIGEST_PLACEHOLDER/u);
  assert.match(candidate['ansible.builtin.copy'].dest, /codexia_candidate_unit_filename/u);
  assert.match(candidate['ansible.builtin.copy'].content, /codexia_auth_runtime_oidc_configured/u);
  const settingsGuard = transactionTasks.find(task => task.name ===
    'Require complete public Better Auth settings without secret material in the environment file');
  const oidcRules = settingsGuard['ansible.builtin.assert'].that.filter(rule => rule.includes('CODEXIA_OIDC_'));
  assert.ok(oidcRules.some(rule => rule.includes("regex_findall('(?m)^CODEXIA_OIDC_ISSUER=')")));
  assert.ok(oidcRules.some(rule => rule.includes("regex_findall('(?m)^CODEXIA_OIDC_CLIENT_ID=')")));

  const validateOidcTuple = text => {
    const lines = text.split(/\r?\n/u);
    const issuerRows = lines.filter(line => line.startsWith('CODEXIA_OIDC_ISSUER='));
    const clientRows = lines.filter(line => line.startsWith('CODEXIA_OIDC_CLIENT_ID='));
    const validIssuer = issuerRows.filter(line => /^CODEXIA_OIDC_ISSUER=https:\/\/[^\s]+$/u.test(line));
    const validClient = clientRows.filter(line => /^CODEXIA_OIDC_CLIENT_ID=[a-zA-Z0-9._:/|+-]+$/u.test(line));
    return issuerRows.length === clientRows.length && issuerRows.length <= 1 &&
      validIssuer.length === issuerRows.length && validClient.length === clientRows.length;
  };
  assert.equal(validateOidcTuple('CODEXIA_PUBLIC_ORIGIN=https://codexia.example'), true, 'OIDC-free Passkey mode is valid');
  assert.equal(validateOidcTuple('CODEXIA_OIDC_ISSUER=https://idp.example'), false, 'partial OIDC tuple is rejected');
  assert.equal(validateOidcTuple('CODEXIA_OIDC_ISSUER=http://idp.example\nCODEXIA_OIDC_CLIENT_ID=codexia'), false,
    'malformed issuer cannot be treated as an absent tuple');
  assert.equal(validateOidcTuple('CODEXIA_OIDC_ISSUER=https://idp.example\nCODEXIA_OIDC_CLIENT_ID=bad client'), false,
    'malformed client ID cannot be treated as an absent tuple');
  assert.equal(validateOidcTuple('CODEXIA_OIDC_ISSUER=https://idp.example\nCODEXIA_OIDC_CLIENT_ID=codexia'), true,
    'complete OIDC compatibility tuple remains valid');
  assert.equal(validateOidcTuple('CODEXIA_OIDC_ISSUER=https://idp.example\nCODEXIA_OIDC_ISSUER=https://idp.example\nCODEXIA_OIDC_CLIENT_ID=codexia\nCODEXIA_OIDC_CLIENT_ID=codexia'), false,
    'duplicate OIDC values are rejected');

  const transaction = transactionTasks.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  const shell = transaction['ansible.builtin.shell'].cmd;
  const backup = shell.indexOf('deploy-backup');
  const verifyClients = shell.indexOf('/app/node_modules/@codexia/api/dist/verify-auth-clients.js', backup);
  const installCandidate = shell.indexOf('install -m 0600 "$candidate_unit" "$active_unit"');
  assert.ok(backup >= 0 && verifyClients > backup && installCandidate > verifyClients,
    'Better Auth client checks must follow encrypted backup and precede candidate installation');
  assert.match(shell, /authSettingsSha256/u);
  assert.match(shell, /restore_previous/u);

  const betterAuthUnit = readFileSync(new URL('../../../deploy/quadlet/codexia-api.container', import.meta.url), 'utf8');
  assert.doesNotMatch(betterAuthUnit, /CODEXIA_AUTH_TOKEN|codexia-auth-token/u);
  assert.match(betterAuthUnit, /^Environment=CODEXIA_AUTH_MODE=better-auth$/mu);
  assert.match(betterAuthUnit, /^Environment=CODEXIA_AUTH_SETTINGS_SHA256=AUTH_SETTINGS_DIGEST_PLACEHOLDER$/mu);

  const apiSource = readFileSync(new URL('../../../packages/api/src/server.ts', import.meta.url), 'utf8');
  const authRuntime = readFileSync(new URL('../../../packages/api/src/better-auth.ts', import.meta.url), 'utf8');
  const runbook = readFileSync(new URL('../../../docs/deployment/PUSH-DEPLOYMENT.sdoc', import.meta.url), 'utf8');
  assert.match(apiSource, /await betterAuth\.assertRegisteredClients\(\)/u, 'API startup must refuse incomplete persisted owner/client records');
  assert.match(authRuntime, /Configured Better Auth owner subject is not registered/u);
  assert.match(authRuntime, /has an unsupported scope/u, 'client registration checks must reject authority beyond the configured scope class');
  assert.match(runbook, /\[LINK: DOC-DEPLOYMENT-ANSIBLE-AUTH-RUNTIME-first-owner-through-the-browser, browser enrollment\]/u);
  assert.match(runbook, /`preflight_run_id`/u);
  assert.match(runbook, /`ACTIVATE_CODEXIA_BACKEND`/u);
  assert.match(runbook, /`CODEXIA_INITIAL_INSTALL_APPROVED=true` and `CODEXIA_DATABASE_INITIALIZATION_APPROVED=true`/u);
});

test('stale admission stops before touching activation links, transaction intent or services', () => {
  const transaction = transactionTasks.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  const shell = transaction['ansible.builtin.shell'].cmd;
  const lock = shell.indexOf('flock --exclusive --nonblock');
  const activation = shell.indexOf('mkdir -p "$wants_dir"');
  assert.ok(lock >= 0 && activation > lock, 'admission must be revalidated inside the host lock');
  const revalidation = shell.slice(lock, activation);
  assert.match(revalidation, /current_container[\s\S]*admitted_container/u);
  assert.match(revalidation, /sha256sum < "\$active_unit"[\s\S]*admitted_unit_sha256/u);
  assert.match(revalidation, /rollback_image[\s\S]*admitted_unit_image/u);
  assert.match(revalidation, /Stale deployment admission/u);
});

test('the disposable entry point exercises the same auth transaction', () => {
  const fixture = parse(readFileSync(new URL('../../../deploy/ansible/deploy-lifecycle-fixture.yml', import.meta.url), 'utf8'));
  assert.ok(fixture.some(task => task['ansible.builtin.include_tasks'] === 'deploy-transaction.yml'));
  const fixtureAdmission = fixture[0]['ansible.builtin.assert'].that;
  assert.ok(fixtureAdmission.some(condition => condition.includes("['head', 'prior', 'failed', 'app-update', 'auth-primary', 'auth-update', 'auth-failed']")));
  const transaction = transactionTasks.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  const shell = transaction['ansible.builtin.shell'].cmd;
  const noOp = shell.slice(shell.indexOf('cmp -s -- "$candidate_unit" "$active_unit"'), shell.indexOf('echo "UNCHANGED'));
  assert.match(noOp, /run_auth_cli \/app\/node_modules\/@codexia\/api\/dist\/verify-auth-clients\.js/u);
  assert.doesNotMatch(noOp, /migrate-auth|deploy-(check|start|backup)|systemctl --user stop/u);
});

test('both first-owner launchers require a clean API target under the deployment lock', t => {
  const home = mkdtempSync(path.join(tmpdir(), 'codexia-first-owner-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, '.local/bin');
  const state = path.join(home, '.local/state/codexia-deploy');
  const quadlet = path.join(home, '.config/containers/systemd');
  const auth = path.join(home, '.config/codexia-auth');
  for (const dir of [bin, state, quadlet, auth]) mkdirSync(dir, { recursive: true });
  const guard = path.join(bin, 'codexia-require-clean-api-target');
  copyFileSync(new URL('../../../deploy/ansible/require-clean-api-target.sh', import.meta.url), guard);
  chmodSync(guard, 0o700);
  const mock = (name, body) => writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  mock('id', 'echo codexia');
  mock('podman', `case "$1 $2" in
    'info --format') echo true;;
    'container exists') if [ "$3" = codexia-tunnel ]; then exit 1; else exit "$CONTAINER_STATUS"; fi;;
    'inspect --format') echo healthy;;
    'run --rm')
      flock --nonblock "$HOME/.local/state/codexia-deploy/host.lock" true && exit 89
      echo "STARTED $*";;
    *) exit 90;;
  esac`);
  mock('sudo', `[ "$*" = '-n /usr/local/sbin/codexia-api-gate status' ] && echo "$GATE_STATE"`);
  mock('systemctl', `case "$1 $2" in
    'is-active codexia-cloudflared.service') echo "$MANAGEMENT_STATE";;
    '--user show') printf '%s\\n' "$UNIT_STATE"; exit "$UNIT_STATUS";;
    '--user is-active') exit 0;;
    *) exit 90;;
  esac`);
  writeFileSync(path.join(auth, 'runtime.env'), [
    'CODEXIA_AUTH_PASSKEY_BOOTSTRAP_OWNER_ID=owner',
    'CODEXIA_AUTH_PASSKEY_BOOTSTRAP_OWNER_EMAIL=owner@example.test',
    'CODEXIA_AUTH_PASSKEY_BOOTSTRAP_OWNER_NAME=Owner',
  ].join('\n'), { mode: 0o600 });
  writeFileSync(path.join(auth, 'bootstrap.env'), [
    'CODEXIA_AUTH_BOOTSTRAP_ORIGIN=https://setup.example.test',
    'CODEXIA_AUTH_BOOTSTRAP_WEB_REDIRECT_URIS=https://app.example.test/desktop',
  ].join('\n'), { mode: 0o600 });
  for (const file of ['tls.crt', 'tls.key']) writeFileSync(path.join(auth, file), '', { mode: 0o600 });
  const env = {
    ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH,
    CODEXIA_IMAGE_REPOSITORY: 'ghcr.io/yohn-jp/codexia-backend',
    GATE_STATE: 'closed', MANAGEMENT_STATE: 'active',
    CONTAINER_STATUS: '1', UNIT_STATUS: '4', UNIT_STATE: 'LoadState=not-found\nActiveState=inactive',
  };
  const image = 'ghcr.io/yohn-jp/codexia-backend@sha256:' + 'a'.repeat(64);
  const unit = path.join(quadlet, 'codexia-api.container');
  for (const [source, cli] of [
    ['bootstrap-auth-registration.sh', 'bootstrap-auth.js'],
    ['grant-passkey-owner.sh', 'grant-passkey-owner.js'],
  ]) {
    const script = new URL('../../../deploy/ansible/' + source, import.meta.url).pathname;
    const run = (overrides = {}) => spawnSync('bash', [script, '--apply', image], {
      env: { ...env, ...overrides }, encoding: 'utf8',
    });
    for (const missingUnitStatus of ['0', '4']) {
      const fresh = run({ UNIT_STATUS: missingUnitStatus });
      assert.equal(fresh.status, 0, fresh.stderr);
      assert.ok(fresh.stdout.includes('STARTED ') && fresh.stdout.includes(cli));
    }
    const refused = overrides => {
      const result = run(overrides);
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stdout, /STARTED/u);
    };
    refused({ CONTAINER_STATUS: '0' }); // Includes a stopped container with no remaining unit.
    refused({ CONTAINER_STATUS: '125' });
    refused({ GATE_STATE: 'open' });
    refused({ MANAGEMENT_STATE: 'inactive' });
    refused({ UNIT_STATE: '', UNIT_STATUS: '1' }); // Unreachable user manager.
    refused({ UNIT_STATE: 'LoadState=loaded\nActiveState=inactive', UNIT_STATUS: '0' });
    refused({ UNIT_STATE: 'LoadState=not-found\nActiveState=active', UNIT_STATUS: '0' });
    writeFileSync(unit, 'Environment=CODEXIA_AUTH_TOKEN_FILE=/run/secrets/codexia-auth-token\n');
    refused({ CONTAINER_STATUS: '0', UNIT_STATE: 'LoadState=loaded\nActiveState=active', UNIT_STATUS: '0' });
    rmSync(unit);
    for (const marker of [unit, ...['deploy-transaction.json', 'deployed-release.json', 'rollback-api.container'].map(name => path.join(state, name))]) {
      symlinkSync('missing', marker);
      refused({});
      rmSync(marker);
    }
  }
});

test('the isolated registration launcher admits only complete OIDC or Passkey bootstrap tuples', () => {
  const launcher = readFileSync(new URL('../../../deploy/ansible/bootstrap-auth-registration.sh', import.meta.url), 'utf8');
  const validTuple = launcher.match(/^\s*!\s*\{\s*(\[\[[\s\S]*?\]\]\s*\|\|\s*\[\[[\s\S]*?\]\])\s*;\s*\}; then$/m);
  assert.ok(validTuple, 'the launcher must reject the valid-tuple predicate, not reject valid settings');
  const check = (runtimeOidc, bootstrapSubject, passkeyFields) => spawnSync('bash', ['-euc',
    `runtime_oidc=${runtimeOidc}; bootstrap_subject=${bootstrapSubject}; passkey_fields=${passkeyFields}; if { ${validTuple[1]}; }; then exit 0; else exit 1; fi`,
  ], { encoding: 'utf8' });
  for (const tuple of [['true', 'true', 0], ['false', 'false', 3]]) {
    assert.equal(check(...tuple).status, 0, `valid registration tuple was rejected: ${tuple.join('/')}`);
  }
  for (const tuple of [['true', 'false', 0], ['false', 'false', 2], ['true', 'true', 3]]) {
    assert.equal(check(...tuple).status, 1, `invalid registration tuple was accepted: ${tuple.join('/')}`);
  }
});

test('the recovery launcher audits sanitized counts without sending its one-use grant to the host journal', () => {
  const launcher = readFileSync(new URL('../../../deploy/ansible/grant-passkey-owner-recovery.sh', import.meta.url), 'utf8');
  const projection = launcher.match(/jq -ce '([^']+)'/u)?.[1];
  assert.ok(projection, 'the launcher must project a dedicated host audit event');
  assert.match(projection, /event:"passkey-owner-recovery"/u);
  assert.match(projection, /ownerId|owner_id/u);
  assert.match(projection, /sessionsRevoked/u);
  assert.match(projection, /accessGrantsRevoked/u);
  assert.match(projection, /refreshGrantsRevoked/u);
  assert.doesNotMatch(projection, /recoveryToken|\.token|token:/u, 'the journal projection must omit the one-use grant');
  assert.match(launcher, /logger --tag codexia-passkey-recovery/u);
  assert.match(launcher, /durably recorded in PostgreSQL/u);
});

test('production lifecycle preflight establishes Cloudflare SSH only for main in a protected Environment', () => {
  const job = preflight.jobs['lifecycle-host'];
  assert.match(job.if, /github.ref == 'refs\/heads\/main'/u, 'PR refs must not receive the deployment SSH secret');
  assert.match(job.if, /github.event.repository.name == 'codexia'/u);
  assert.match(job.if, /github.event.repository.default_branch == 'main'/u);
  assert.equal(job.permissions['id-token'], undefined, 'management uses a scoped Access Service Token');
  assert.ok(job.environment.includes('codexia-bootstrap') && job.environment.includes('codexia-production'));
  const ssh = job.steps.find(step => step.name === 'Prepare runtime pinned SSH');
  assert.ok(ssh);
  assert.equal(ssh.env.CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET, '${{ vars.CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET }}');
  assert.equal(ssh.env.CODEXIA_MANAGEMENT_HOSTNAME, '${{ env.CODEXIA_MANAGEMENT_HOSTNAME }}');
  assert.equal(ssh.env.CODEXIA_SSH_ACCESS_CLIENT_ID, undefined, 'transport tokens are only available to SSH child processes');
  assert.equal(ssh.run, 'bash deploy/ansible/prepare-deploy-ssh.sh');
  assert.ok(job.steps.some(step => step.name === 'Install checksum-pinned cloudflared client'));
  const access = job.steps.find(step => step.name === 'Verify independent bootstrap identity and noninteractive sudo');
  assert.equal(access.env.TUNNEL_SERVICE_TOKEN_ID, '${{ secrets.CODEXIA_SSH_ACCESS_CLIENT_ID }}');
  assert.equal(access.env.TUNNEL_SERVICE_TOKEN_SECRET, '${{ secrets.CODEXIA_SSH_ACCESS_CLIENT_SECRET }}');
});

test('the declared VM must resolve to a protected SSH pin in both diagnosis and deployment', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'codexia-ssh-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = path.join(directory, 'fixture');
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]).status, 0);
  const publicKey = readFileSync(key + '.pub', 'utf8').trim();
  const host = 'ssh.example.test';
  const pins = host + ' ' + publicKey;
  const script = new URL('../../../deploy/ansible/prepare-deploy-ssh.sh', import.meta.url).pathname;
  const targetContract = JSON.stringify({
    repository: 'yohn-jp/codexia', repositoryId: 401, ownerId: 502,
    sshHostname: host, sshPolicyId: 'policy-789',
  });
  const targetMismatchesManagementHostname = JSON.stringify({
    repository: 'yohn-jp/codexia', repositoryId: 401, ownerId: 502,
    sshHostname: 'other.example.test', sshPolicyId: 'policy-789',
  });
  function prepare(knownHosts, target) {
    const runner = mkdtempSync(path.join(directory, 'runner-'));
    const output = path.join(runner, 'output');
    const cloudflared = path.join(runner, 'cloudflared');
    writeFileSync(cloudflared, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const result = spawnSync('bash', [script], { encoding: 'utf8', env: {
      ...process.env, RUNNER_TEMP: runner, GITHUB_OUTPUT: output, CODEXIA_DEPLOY_HOST: target,
      CODEXIA_MANAGEMENT_HOSTNAME: host,
      GITHUB_REPOSITORY: 'yohn-jp/codexia', GITHUB_REPOSITORY_ID: '401', GITHUB_REPOSITORY_OWNER_ID: '502',
      CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET: targetContract,
      CODEXIA_DEPLOY_SSH_KNOWN_HOSTS: knownHosts, CODEXIA_DEPLOY_SSH_PRIVATE_KEY: readFileSync(key, 'utf8'),
    } });
    return { result, runner, output, cloudflared };
  }
  const prepared = prepare(pins, host);
  assert.equal(prepared.result.status, 0, prepared.result.stderr);
  assert.equal(readFileSync(prepared.output, 'utf8'), 'host=' + host + '\n');
  const config = spawnSync('ssh', ['-G', '-F', path.join(prepared.runner, 'codexia-ssh/config'), 'codexia-target'], { encoding: 'utf8' });
  assert.equal(config.status, 0);
  for (const line of ['hostname ' + host, 'user codexia', 'stricthostkeychecking true', 'identitiesonly yes',
    'globalknownhostsfile /dev/null', 'userknownhostsfile ' + path.join(prepared.runner, 'codexia-ssh/known_hosts'),
    'proxycommand "' + new URL('../../../scripts/deployment/ssh/cloudflared-proxy.sh', import.meta.url).pathname + '" %h']) {
    assert.ok(config.stdout.split('\n').includes(line), line);
  }
  const capture = path.join(prepared.runner, 'cloudflared-capture');
  writeFileSync(prepared.cloudflared, [
    '#!/bin/sh',
    'printf "client_id=%s\\nclient_secret=%s\\nbrowser=%s\\nargs=%s\\n" "$TUNNEL_SERVICE_TOKEN_ID" "$TUNNEL_SERVICE_TOKEN_SECRET" "$BROWSER" "$*" > "$CLOUDFLARED_CAPTURE"',
    'case "$*" in *"$TUNNEL_SERVICE_TOKEN_SECRET"*) printf "secret_in_argv=yes\\n" >> "$CLOUDFLARED_CAPTURE";; *) printf "secret_in_argv=no\\n" >> "$CLOUDFLARED_CAPTURE";; esac',
    'test -z "$TUNNEL_SERVICE_DESTINATION$TUNNEL_SERVICE_URL$DISPLAY$WAYLAND_DISPLAY" || exit 24',
    'test "$HOME" = "$PATH" && test "$HOME" = "$XDG_CONFIG_HOME" && test "$HOME" != "$INHERITED_HOME" || exit 25',
    'test -d "$HOME" && test ! -e "$HOME/.cloudflared" || exit 26',
    'printf "%s\\n" "$HOME" >> "$CLOUDFLARED_CAPTURE"',
    'exit 23',
    '',
  ].join('\n'), { mode: 0o700 });
  const connection = spawnSync('ssh', ['-F', path.join(prepared.runner, 'codexia-ssh/config'), 'codexia-target', 'true'], {
    encoding: 'utf8', env: {
      ...process.env, RUNNER_TEMP: prepared.runner,
      TUNNEL_SERVICE_TOKEN_ID: 'fixture-service-id',
      TUNNEL_SERVICE_TOKEN_SECRET: 'fixture-service-secret', CLOUDFLARED_CAPTURE: capture,
      TUNNEL_SERVICE_DESTINATION: 'forbidden-destination', TUNNEL_SERVICE_URL: 'forbidden-listener',
      DISPLAY: ':1', WAYLAND_DISPLAY: 'forbidden-wayland', INHERITED_HOME: process.env.HOME ?? '',
    },
  });
  assert.notEqual(connection.status, 0, 'the fake connector exits before any network connection');
  const proxyCapture = readFileSync(capture, 'utf8').split('\n');
  assert.deepEqual(proxyCapture.slice(0, 5), [
    'client_id=fixture-service-id', 'client_secret=fixture-service-secret', 'browser=/usr/bin/false',
    'args=access ssh --hostname ' + host, 'secret_in_argv=no',
  ]);
  assert.equal(path.dirname(proxyCapture[5]), prepared.runner);
  assert.equal(existsSync(proxyCapture[5]), false, 'the isolated client profile is removed even on failure');
  assert.notEqual(prepare(pins, '').result.status, 0, 'host must be explicitly declared');
  assert.notEqual(prepare(pins, '192.0.2.1').result.status, 0, 'management transport must use a DNS name');
  assert.notEqual(prepare(pins, 'different.example.test').result.status, 0);
  assert.notEqual(prepare(pins, 'invalid\nHost other').result.status, 0);
  assert.notEqual(prepare('other.example.test ' + publicKey, host).result.status, 0,
    'the reviewed management hostname must match an explicit pinned host key');
  const targetEnvironment = {
    ...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: path.join(directory, 'invalid-output'), CODEXIA_DEPLOY_HOST: host,
    CODEXIA_MANAGEMENT_HOSTNAME: host,
    CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET: targetMismatchesManagementHostname,
    GITHUB_REPOSITORY: 'yohn-jp/codexia', GITHUB_REPOSITORY_ID: '401', GITHUB_REPOSITORY_OWNER_ID: '502',
    CODEXIA_DEPLOY_SSH_KNOWN_HOSTS: pins,
    CODEXIA_DEPLOY_SSH_PRIVATE_KEY: readFileSync(key, 'utf8'),
  };
  const targetRunner = path.join(directory, 'target-runner');
  mkdirSync(targetRunner);
  writeFileSync(path.join(targetRunner, 'cloudflared'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  targetEnvironment.RUNNER_TEMP = targetRunner;
  assert.notEqual(spawnSync('bash', [script], { encoding: 'utf8', env: targetEnvironment }).status, 0);
});
