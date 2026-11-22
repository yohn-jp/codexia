import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('../.github/workflows/backend-release.yml', import.meta.url), 'utf8'));
const handoff = parse(readFileSync(new URL('../.github/workflows/backend-deployment-handoff.yml', import.meta.url), 'utf8'));
const tailscale = parse(readFileSync(new URL('../.github/workflows/tailscale-connectivity.yml', import.meta.url), 'utf8'));
const site = parse(readFileSync(new URL('../deploy/ansible/site.yml', import.meta.url), 'utf8'))[0];
const transactionTasks = parse(readFileSync(new URL('../deploy/ansible/deploy-transaction.yml', import.meta.url), 'utf8'));

test('pull request backend validation cannot obtain production credentials or deploy', () => {
  const validation = workflow.jobs['build-test'];
  assert.ok(validation, 'backend PR validation job is required');
  assert.equal(validation.environment, undefined, 'PR validation must not attach a production Environment');
  assert.equal(validation.permissions['id-token'], undefined, 'PR validation must not mint a Tailnet identity');
  for (const step of validation.steps) {
    for (const value of Object.values(step.env ?? {})) {
      assert.doesNotMatch(String(value), /secrets\./u, 'PR validation must not read GitHub Environment secrets');
    }
  }
});

test('production deployment consumes the verified Full digest and provenance certificate after main publication', () => {
  const deploy = handoff.jobs['deploy-production'];
  assert.ok(deploy, 'certified production deployment job is required');
  assert.deepEqual(deploy.needs, ['verify-handoff']);
  assert.match(deploy.if, /github\.event_name == 'workflow_run'/u);
  assert.match(deploy.if, /github\.event\.workflow_run\.event == 'workflow_run'/u);
  assert.match(deploy.if, /github\.event\.workflow_run\.head_branch == 'main'/u);
  assert.match(deploy.if, /needs\.verify-handoff\.result == 'success'/u);
  assert.match(deploy.if, /needs\.verify-handoff\.outputs\.certified-full-image != ''/u);
  assert.match(deploy.if, /needs\.verify-handoff\.outputs\.deployment-certificate != ''/u);
  assert.doesNotMatch(deploy.if, /CODEXIA_PUSH_DEPLOYMENT_ENABLED/u);
  const deploymentGate = deploy.steps.find(step => step.id === 'deployment-gate');
  assert.ok(deploymentGate);
  assert.equal(deploymentGate.env.CODEXIA_PUSH_DEPLOYMENT_ENABLED, '${{ vars.CODEXIA_PUSH_DEPLOYMENT_ENABLED }}');
  assert.ok(deploy.steps.slice(deploy.steps.indexOf(deploymentGate) + 1).every(step =>
    step.if === "steps.deployment-gate.outputs.enabled == 'true'"));
  assert.equal(deploy.environment.name, 'codexia-production');
  assert.equal(deploy.concurrency.group, 'codexia-production');
  assert.equal(deploy.concurrency['cancel-in-progress'], false);
  assert.equal(deploy.permissions['id-token'], 'write');

  const tailscale = deploy.steps.find(step => step.uses === 'tailscale/github-action@v4');
  assert.ok(tailscale, 'production deployment must establish the Tailnet connection');
  assert.equal(tailscale.with['oauth-client-id'], '${{ secrets.TS_OAUTH_CLIENT_ID }}');

  const ssh = deploy.steps.find(step => step.name === 'Prepare pinned SSH identity');
  assert.ok(ssh, 'production deployment must prepare its dedicated SSH key and pinned host key');
  assert.equal(ssh.env.CODEXIA_DEPLOY_SSH_PRIVATE_KEY, '${{ secrets.CODEXIA_DEPLOY_SSH_PRIVATE_KEY }}');
  assert.equal(ssh.env.CODEXIA_DEPLOY_SSH_KNOWN_HOSTS, '${{ vars.CODEXIA_DEPLOY_SSH_KNOWN_HOSTS }}');
  assert.match(ssh.run, /StrictHostKeyChecking=yes/u);

  const liveUi = deploy.steps.find(step => step.name === 'Verify deployed frontend epoch and Access boundary for certified backend recovery');
  assert.ok(liveUi, 'the job must admit the deployed frontend against the verified backend epoch before deployment');
  assert.equal(liveUi.env.CODEXIA_ACCESS_CLIENT_ID, '${{ secrets.CODEXIA_ACCESS_CLIENT_ID }}');
  assert.equal(liveUi.env.CODEXIA_EXPECTED_BACKEND_API_EPOCH, '${{ needs.verify-handoff.outputs.certified-full-api-epoch }}');
  assert.equal(liveUi.run, 'node scripts/verify-frontend-compatibility.mjs backend-preflight');
  const verify = handoff.jobs['verify-handoff'];
  assert.equal(verify.outputs['certified-full-image'], '${{ steps.verify.outputs.full-image }}');
  assert.equal(verify.outputs['deployment-certificate'], '${{ steps.verify.outputs.full-certificate }}');
  assert.ok(verify.steps.some(step => step.run === 'node scripts/verify-backend-push-handoff.mjs'),
    'deployment output must come only from the independent certificate and publication verifier');
  const ansible = deploy.steps.find(step => step.name === 'Converge certified backend digest');
  assert.ok(ansible, 'production deployment must apply the digest through Ansible');
  assert.equal(ansible.env.CODEXIA_CERTIFIED_FULL_IMAGE, '${{ needs.verify-handoff.outputs.certified-full-image }}');
  assert.equal(ansible.env.CODEXIA_PROFILE, 'full');
  assert.equal(ansible.env.CODEXIA_DEPLOYMENT_CERTIFICATE_B64, '${{ needs.verify-handoff.outputs.deployment-certificate }}');
  assert.equal(ansible.env.CODEXIA_INITIAL_INSTALL_APPROVED, "${{ vars.CODEXIA_INITIAL_INSTALL_APPROVED || 'false' }}");
  assert.equal(ansible.env.CODEXIA_DATABASE_INITIALIZATION_APPROVED, "${{ vars.CODEXIA_DATABASE_INITIALIZATION_APPROVED || 'false' }}");
  assert.equal(ansible.env.CODEXIA_AUTH_MODE, "${{ vars.CODEXIA_AUTH_MODE || 'token' }}");
  assert.equal(ansible.env.CODEXIA_BETTER_AUTH_ACTIVATION_APPROVED, "${{ vars.CODEXIA_BETTER_AUTH_ACTIVATION_APPROVED || 'false' }}");
  assert.match(ansible.run, /codexia_auth_mode:process\.env\.CODEXIA_AUTH_MODE/u);
  assert.match(ansible.run, /codexia_better_auth_activation_approved:process\.env\.CODEXIA_BETTER_AUTH_ACTIVATION_APPROVED==="true"/u);
  assert.match(ansible.run, /codexia_initial_install_approved:process\.env\.CODEXIA_INITIAL_INSTALL_APPROVED==="true"/u);
  assert.match(ansible.run, /codexia_database_initialization_approved:process\.env\.CODEXIA_DATABASE_INITIALIZATION_APPROVED==="true"/u);
  assert.match(ansible.run, /codexia_stage: deploy/u);
  assert.match(ansible.run, /codexia_image:/u);
});

test('Ansible routes the push stage through the codexia runtime and host lock', () => {
  const route = site.tasks.find(task => task.name === 'Deploy the certified image under a serialized host lock');
  assert.ok(route, 'site.yml must route the push deployment stage');
  assert.equal(route['ansible.builtin.include_tasks'].file, 'deploy.yml');
  assert.equal(route.when, "codexia_stage == 'deploy'");

  assert.ok(site.tasks.every(task => !JSON.stringify(task).includes('codexia-updater')));

  const deployment = parse(readFileSync(new URL('../deploy/ansible/deploy.yml', import.meta.url), 'utf8'));
  assert.ok(deployment.some(task => task['ansible.builtin.include_tasks'] === 'deploy-transaction.yml'));
  assert.ok(transactionTasks.some(task => task.name === 'Admit the published candidate against installed API and deployed UI identities'));
  const candidateIdentity = transactionTasks.find(task => task.name === 'Require candidate image source, profile and database compatibility identity');
  assert.ok(candidateIdentity['ansible.builtin.assert'].that.includes('codexia_candidate_identity == codexia_deployment_certificate.identity'));
  const activeUnit = transactionTasks.find(task => task.name === 'Require the existing API unit before an image-only update');
  assert.ok(activeUnit, 'image-only updates must retain a concrete prior unit for rollback');
  assert.equal(activeUnit.when, 'codexia_current_container_exists.rc == 0');
  const recovery = transactionTasks.find(task => task.name === 'Recover an interrupted push deployment before examining the active API');
  assert.ok(recovery, 'a retry must recover interrupted transactions before health preconditions');
  assert.match(recovery['ansible.builtin.command'].argv[0], /codexia-deploy-recover$/u);
  const recoveryScript = readFileSync(new URL('../deploy/ansible/push-deployment-recover.sh', import.meta.url), 'utf8');
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
  assert.match(transaction['ansible.builtin.shell'].cmd, /backup-locked[\s\S]*--approved[\s\S]*--lock-file[\s\S]*--lock-fd/u, 'updates must commit an encrypted off-VM backup under the same lock');
  assert.match(transaction['ansible.builtin.shell'].cmd, /restore_previous/u, 'failed candidate activation must restore the prior release');
  assert.match(transaction['ansible.builtin.shell'].cmd, /stop codexia-api\.service[\s\S]*running_image[\s\S]*candidate_image/u, 'candidate acceptance must follow successful shutdown and match the certified running digest');
  assert.match(transaction['ansible.builtin.shell'].cmd, /restored_image[\s\S]*rollback_image/u, 'rollback health must be bound to the prior digest snapshot');
  assert.match(transaction['ansible.builtin.shell'].cmd, /deploy-transaction\.json/u, 'a durable transaction intent must make interrupted deployments recoverable');
  assert.match(transaction['ansible.builtin.shell'].cmd, /current_image.*candidate_image/su, 'same-digest application must be idempotent');
  assert.match(transaction['ansible.builtin.shell'].cmd, /Candidate API readiness failed; deployment transaction remains pending if rollback is unverified/u);
});

test('deployment requires the rootless base runtime under the lock before activation', () => {
  const transaction = transactionTasks.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  const shell = transaction['ansible.builtin.shell'].cmd;
  const start = shell.indexOf('if ! podman volume exists codexia-history');
  const end = shell.indexOf("current_container=''", start);
  assert.ok(start > shell.indexOf('flock --exclusive --nonblock') && end > start);
  assert.ok(end < shell.indexOf('mkdir -p "$wants_dir"'));
  assert.match(shell, /require_tunnel=.*'false' if \(codexia_lifecycle_fixture \| default\(false\) \| bool\) else 'true'/u);

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
        '--user cat codexia-tunnel.service') [[ "$missing" != tunnel ]];;
        '--user show --property=SourcePath --value codexia-db.service') [[ "$missing" != db-source ]] && printf '%s\\n' "$unit_dir/codexia-db.container";;
        '--user show --property=SourcePath --value codexia-tunnel.service') [[ "$missing" != tunnel-source ]] && printf '%s\\n' "$unit_dir/codexia-tunnel.container";;
        *) return 99;;
      esac
    }
  `;
  const safeFailure = transactionTasks.find(task => task.name === 'Report only an allowlisted deployment transaction failure stage');
  for (const [missing, dbHealth, requireTunnel, error] of [
    ['history', 'healthy', 'true', 'Deployment base runtime requires the rootless history volume'],
    ['db', 'healthy', 'true', 'Deployment base runtime requires a healthy rootless PostgreSQL Quadlet'],
    ['', 'unhealthy', 'true', 'Deployment base runtime requires a healthy rootless PostgreSQL Quadlet'],
    ['tunnel', 'healthy', 'true', 'Deployment base runtime requires the rootless Tunnel Quadlet'],
    ['db-source', 'healthy', 'true', 'Deployment base runtime requires canonical generated PostgreSQL and Tunnel units'],
    ['tunnel-source', 'healthy', 'true', 'Deployment base runtime requires canonical generated PostgreSQL and Tunnel units'],
    ['tunnel', 'healthy', 'false', ''],
    ['', 'healthy', 'true', ''],
  ]) {
    const result = spawnSync('bash', ['-c', fixtureCommands + preflight], {
      encoding: 'utf8',
      env: { ...process.env, missing, db_health: dbHealth, require_tunnel: requireTunnel },
    });
    assert.ifError(result.error);
    assert.equal(result.status, error ? 1 : 0, result.stderr);
    assert.equal(result.stderr.trim(), error);
    if (error) assert.ok(safeFailure['ansible.builtin.fail'].msg.includes(error));
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
  const checks = parse(readFileSync(new URL('../deploy/ansible/verify-deploy-base-runtime.yml', import.meta.url), 'utf8'));
  const quadlets = checks.find(task => task.name === 'Inspect every canonical base Quadlet without following links');
  assert.deepEqual(quadlets.loop, [
    'codexia.network', 'codexia-data.network', 'codexia-postgres.volume', 'codexia-data.volume',
    'codexia-history.volume', 'codexia-db.container', 'codexia-tunnel.container',
  ]);
  const fileAdmission = checks.find(task => task.name ===
    'Require every base Quadlet to match the reviewed repository source');
  assert.ok(fileAdmission['ansible.builtin.assert'].that.some(clause =>
    clause.includes("hash('sha256')")));
  const generatedOrigins = checks.find(task => task.name === 'Require base services to originate from canonical rootless Quadlets');
  assert.ok(generatedOrigins['ansible.builtin.assert'].that.some(clause =>
    clause.includes("item.stdout == quadlet_dir + '/'")));
  const includes = checks.filter(task => task['ansible.builtin.include_tasks'])
    .map(task => task['ansible.builtin.include_tasks']);
  assert.deepEqual(includes, ['verify-base-db-container.yml', 'verify-base-tunnel-container.yml']);
  const networks = checks.find(task => task.name === 'Verify the canonical private network isolation before deployment');
  assert.deepEqual(networks.loop.map(value => value.expected), ['codexia|bridge|false', 'codexia-data|bridge|true']);
  const shell = transactionStages.find(task => task.name === 'Apply or recover the API Quadlet under the host lock')['ansible.builtin.shell'].cmd;
  assert.match(shell, /systemctl --user show --property=SourcePath --value codexia-db\.service/u);
  assert.match(shell, /systemctl --user show --property=SourcePath --value codexia-tunnel\.service/u);
});

test('the production Quadlet binds an immutable image and disables startup schema mutation', () => {
  const quadlet = readFileSync(new URL('../deploy/quadlet/codexia-api.container', import.meta.url), 'utf8');
  assert.match(quadlet, /^Image=CODEXIA_BACKEND_IMAGE$/mu);
  assert.match(quadlet, /^Environment=CODEXIA_PROFILE=CODEXIA_BACKEND_PROFILE$/mu);
  assert.match(quadlet, /^Environment=CODEXIA_DATABASE_MIGRATE_ON_START=0$/mu);
});

test('first activation initializes only a pristine database after backup under both explicit approvals', () => {
  const deployment = transactionTasks;
  const approval = deployment.find(task => task.name === 'Refuse implicit first activation without explicit verified schema approval');
  assert.deepEqual(approval['ansible.builtin.assert'].that, [
    'codexia_initial_install_approved | default(false) | bool',
    'codexia_database_initialization_approved | default(false) | bool',
  ]);
  const transaction = deployment.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  const shell = transaction['ansible.builtin.shell'].cmd;
  const backup = shell.indexOf('backup-locked');
  const freshMigration = shell.indexOf('initializeFreshPostgresSchema');
  const startApi = shell.indexOf('systemctl --user start codexia-api.service', shell.indexOf('install -m 0644 "$candidate_unit" "$active_unit"'));
  assert.ok(backup >= 0 && freshMigration > backup && startApi > freshMigration,
    'first schema initialization must follow its backup and precede API activation');
  assert.doesNotMatch(shell, /if \[\[ -n "\$current_image" \]\]; then[\s\S]*backup-locked/u,
    'a first activation with an existing database must still make a pre-activation backup');
  assert.ok(shell.indexOf('stop codexia-api.service') < backup,
    'backup admission must follow API and Tunnel quiescence');
  assert.match(shell, /podman run --rm --network codexia-data[\s\S]*--secret=codexia-postgres-app-password[\s\S]*candidate_image/u);
  assert.match(shell, /initializeFreshPostgresSchema\(connectionString\)/u);
  assert.match(shell, /if \[\[ "\$had_unit" != true \]\]; then[\s\S]*initializeFreshPostgresSchema/u);
  assert.doesNotMatch(shell, /DATABASE_MIGRATE_ON_START=1/u,
    'the one-shot approved initializer must not enable recurring startup migrations');
  const persistencePackage = JSON.parse(readFileSync(new URL('../packages/persistence-postgres/package.json', import.meta.url), 'utf8'));
  const persistenceExports = readFileSync(new URL('../packages/persistence-postgres/src/index.ts', import.meta.url), 'utf8');
  assert.ok(persistencePackage.files.includes('dist') && persistencePackage.files.includes('migrations'),
    'the candidate image must carry the initializer and its reviewed migrations');
  assert.match(persistenceExports, /export \{[^}]*initializeFreshPostgresSchema[^}]*\} from "\.\/migrate\.js"/u);
});

test('failed fresh-schema initialization restores a first activation without stopping an absent API service', () => {
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

test('first activation precedes optional Better Auth namespace creation', () => {
  const runbook = readFileSync(new URL('../docs/deployment/PUSH-DEPLOYMENT.md', import.meta.url), 'utf8');
  const firstActivation = runbook.indexOf('Run the first API activation through the protected production workflow');
  const optionalAuth = runbook.indexOf('Only after successful first activation');
  assert.ok(firstActivation > 0 && optionalAuth > 0, 'both first activation and optional auth setup must be documented');
  assert.match(runbook, /Do not run `auth-runtime` before initializing the application schema/u);
  assert.match(runbook, /creating.*codexia_auth|codexia_auth.*additional database object/ui);
});

test('push rollout admits backups only after canonical API and Tunnel shutdown', () => {
  const deployment = readFileSync(new URL('../deploy/ansible/deploy-transaction.yml', import.meta.url), 'utf8');
  const backup = readFileSync(new URL('../deploy/backup/backup.sh', import.meta.url), 'utf8');
  assert.match(deployment, /backup-locked[\s\S]*--approved[\s\S]*--lock-file/u);
  assert.match(backup, /Push deployment requires inactive systemd unit/u);
  assert.doesNotMatch(backup, /codexia-updater|--push-deployment/u);
});

test('push activation keeps one canonical API writer and exposes Tunnel only after readiness', () => {
  const deploy = transactionTasks;
  const transaction = deploy.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  assert.ok(transaction, 'the app activation must remain one serialized transaction');
  const shell = transaction['ansible.builtin.shell'].cmd;

  const stopTunnel = shell.indexOf('systemctl --user stop codexia-tunnel.service');
  const stopApi = shell.indexOf('systemctl --user stop codexia-api.service');
  const installCandidate = shell.indexOf('install -m 0644 "$candidate_unit" "$active_unit"');
  const startCandidate = shell.indexOf('systemctl --user start codexia-api.service', installCandidate);
  const readiness = shell.indexOf('if [[ "$healthy" != true ]]');
  const startTunnel = shell.indexOf('systemctl --user start codexia-tunnel.service', readiness);
  const commitRelease = shell.indexOf('mv -f -- "$release_state.tmp" "$release_state"');
  for (const [name, position] of Object.entries({ stopTunnel, stopApi, installCandidate, startCandidate, readiness, startTunnel, commitRelease })) {
    assert.notEqual(position, -1, `deployment transaction must include ${name}`);
  }
  assert.ok(stopTunnel < stopApi, 'Tunnel ingress must stop before the API writer is changed');
  assert.ok(stopApi < installCandidate, 'the old writer must stop before the candidate unit is installed');
  assert.ok(installCandidate < startCandidate && startCandidate < readiness,
    'candidate readiness must be observed after starting its canonical API service');
  assert.ok(readiness < startTunnel && startTunnel < commitRelease,
    'Tunnel ingress and the release record must follow candidate readiness');

  const apiUnit = readFileSync(new URL('../deploy/quadlet/codexia-api.container', import.meta.url), 'utf8');
  const tunnelUnit = readFileSync(new URL('../deploy/quadlet/codexia-tunnel.container', import.meta.url), 'utf8');
  const databaseUnit = readFileSync(new URL('../deploy/quadlet/codexia-db.container', import.meta.url), 'utf8');
  assert.match(apiUnit, /^ContainerName=codexia-api$/mu);
  assert.match(apiUnit, /^Network=codexia\.network$/mu);
  assert.match(apiUnit, /^Network=codexia-data\.network$/mu);
  assert.match(apiUnit, /^Volume=codexia-data\.volume:\/data$/mu);
  assert.match(apiUnit, /^Volume=codexia-history\.volume:\/history$/mu);
  assert.match(tunnelUnit, /^Requires=codexia-api\.service$/mu);
  assert.match(tunnelUnit, /^After=network-online\.target codexia-api\.service$/mu);
  assert.match(tunnelUnit, /^Network=codexia\.network$/mu);
  assert.match(databaseUnit, /^ContainerName=codexia-db$/mu);
  assert.match(databaseUnit, /^Volume=codexia-postgres\.volume:\/var\/lib\/postgresql\/data$/mu);
  assert.match(databaseUnit, /^Environment=POSTGRES_DB=codexia$/mu);
  assert.match(databaseUnit, /^Environment=POSTGRES_USER=codexia_admin$/mu);
  assert.doesNotMatch(shell, /codexia-db\.container|codexia-postgres\.volume|podman volume (?!exists codexia-history\b)/u,
    'an image-only API rollout must leave canonical PostgreSQL storage untouched');

  const restore = shell.indexOf('restore_previous(){');
  const restoreStartApi = shell.indexOf('systemctl --user start codexia-api.service', restore);
  const restoreHealth = shell.indexOf('podman inspect --format', restoreStartApi);
  const restoreStartTunnel = shell.indexOf('systemctl --user start codexia-tunnel.service', restoreHealth);
  assert.ok(restore !== -1 && restoreStartApi > restore && restoreHealth > restoreStartApi && restoreStartTunnel > restoreHealth,
    'rollback must restore and health-check the previous API before restoring Tunnel ingress');
  assert.match(shell, /Candidate API readiness failed; deployment transaction remains pending if rollback is unverified/u);
});

test('Better Auth activation is explicit, validates staged state, and retains mode through update and rollback', () => {
  const deployment = parse(readFileSync(new URL('../deploy/ansible/deploy.yml', import.meta.url), 'utf8'));
  const selectMode = deployment.find(task => task.name === 'Require an explicit standalone authentication deployment mode');
  assert.ok(selectMode, 'the push stage must receive an explicit token or Better Auth mode');
  const transition = transactionTasks.find(task => task.name === 'Reject auth mode drift, implicit Better Auth enablement and downgrade');
  assert.ok(transition, 'Better Auth activation and downgrade must be gated against the installed Quadlet');
  assert.ok(transition['ansible.builtin.assert'].that.some(item => item.includes('codexia_better_auth_activation_approved')));
  assert.ok(transition['ansible.builtin.assert'].that.some(item => item.includes("codexia_current_auth_mode == 'better-auth' and codexia_deployment_auth_mode == 'token'")));
  const staging = transactionTasks.find(task => task.name === 'Require private staged Better Auth settings before activation');
  assert.equal(staging.when, "codexia_deployment_auth_mode == 'better-auth'");
  assert.ok(transactionTasks.indexOf(transition) < transactionTasks.indexOf(staging));
  assert.ok(transactionTasks.some(task => task.name === 'Require complete public Better Auth settings without secret material in the environment file'));
  assert.ok(transactionTasks.some(task => task.name === 'Verify every staged Better Auth Podman secret exists before activation'));
  const candidate = transactionTasks.find(task => task.name === 'Render a digest-specific candidate Quadlet outside the active unit path');
  assert.match(candidate['ansible.builtin.copy'].content, /codexia-api\.better-auth\.container\.example/u);
  assert.match(candidate['ansible.builtin.copy'].content, /AUTH_SETTINGS_DIGEST_PLACEHOLDER/u);
  assert.match(candidate['ansible.builtin.copy'].dest, /codexia_candidate_unit_filename/u);

  const transaction = transactionTasks.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  const shell = transaction['ansible.builtin.shell'].cmd;
  const backup = shell.indexOf('backup-locked');
  const authMigration = shell.indexOf('/app/node_modules/@codexia/api/dist/migrate-auth.js --apply');
  const verifyClients = shell.indexOf('/app/node_modules/@codexia/api/dist/verify-auth-clients.js', authMigration);
  const installCandidate = shell.indexOf('install -m 0644 "$candidate_unit" "$active_unit"');
  assert.ok(backup >= 0 && authMigration > backup && verifyClients > authMigration && installCandidate > verifyClients,
    'Better Auth migration and client checks must follow encrypted backup and precede the API mode switch');
  assert.match(shell, /\[\[ "\$auth_mode" == better-auth && "\$prior_auth_mode" == token \]\]/u);
  assert.match(shell, /authSettingsSha256/u);
  assert.match(shell, /restore_previous/u);

  const recovery = readFileSync(new URL('../deploy/ansible/push-deployment-recover.sh', import.meta.url), 'utf8');
  assert.match(recovery, /authMode !== unitAuthMode/u);
  assert.match(recovery, /authSettingsSha256 !== unitDigest/u);
  const tokenUnit = readFileSync(new URL('../deploy/quadlet/codexia-api.container', import.meta.url), 'utf8');
  const betterAuthUnit = readFileSync(new URL('../deploy/quadlet/codexia-api.better-auth.container.example', import.meta.url), 'utf8');
  assert.match(tokenUnit, /^Environment=CODEXIA_AUTH_MODE=token$/mu);
  assert.match(betterAuthUnit, /^Environment=CODEXIA_AUTH_MODE=better-auth$/mu);
  assert.match(betterAuthUnit, /^Environment=CODEXIA_AUTH_SETTINGS_SHA256=AUTH_SETTINGS_DIGEST_PLACEHOLDER$/mu);

  const apiSource = readFileSync(new URL('../packages/api/src/server.ts', import.meta.url), 'utf8');
  const authRuntime = readFileSync(new URL('../packages/api/src/better-auth.ts', import.meta.url), 'utf8');
  const runbook = readFileSync(new URL('../docs/deployment/PUSH-DEPLOYMENT.md', import.meta.url), 'utf8');
  assert.match(apiSource, /await betterAuth\.assertRegisteredClients\(\)/u, 'API startup must refuse incomplete persisted owner/client records');
  assert.match(authRuntime, /Configured Better Auth owner subject is not registered/u);
  assert.match(authRuntime, /has an unsupported scope/u, 'client registration checks must reject authority beyond the configured scope class');
  assert.match(runbook, /isolated Better Auth registration procedure/u);
  assert.match(runbook, /authenticated Better Auth session/u);
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

test('the disposable entry point defaults to token and shares the same auth transaction', () => {
  const fixture = parse(readFileSync(new URL('../deploy/ansible/deploy-lifecycle-fixture.yml', import.meta.url), 'utf8'));
  assert.ok(fixture.some(task => task['ansible.builtin.include_tasks'] === 'deploy-transaction.yml'));
  const fixtureAdmission = fixture[0]['ansible.builtin.assert'].that;
  assert.ok(fixtureAdmission.some(condition => condition.includes("['head', 'compatible', 'failed', 'auth-primary', 'auth-update', 'auth-failed']")));
  const mode = transactionTasks.find(task => task.name === 'Resolve the authentication mode for the shared transaction');
  assert.match(mode['ansible.builtin.set_fact'].codexia_deployment_auth_mode, /default\('token'\)/u);
  const transaction = transactionTasks.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  const shell = transaction['ansible.builtin.shell'].cmd;
  const noOp = shell.slice(shell.indexOf('cmp -s -- "$candidate_unit" "$active_unit"'), shell.indexOf('echo "UNCHANGED'));
  assert.match(noOp, /run_auth_cli \/app\/node_modules\/@codexia\/api\/dist\/verify-auth-clients\.js/u);
  assert.doesNotMatch(noOp, /migrate-auth|backup-locked|systemctl --user stop/u);
});

test('main-only manual Tailnet diagnostic verifies pinned SSH as codexia without joining PR validation or deployment', () => {
  assert.deepEqual(Object.keys(tailscale.on), ['workflow_dispatch']);
  const job = tailscale.jobs.connectivity;
  assert.equal(job.if, "github.ref == 'refs/heads/main'", 'PR refs must not receive the deployment SSH secret');
  assert.equal(job.environment, 'codexia-production');
  const ssh = job.steps.find(step => step.name === 'Verify pinned public-key SSH as codexia');
  assert.ok(ssh, 'the manual Tailnet diagnostic must authenticate SSH, not only test TCP/22');
  assert.equal(ssh.env.CODEXIA_DEPLOY_SSH_PRIVATE_KEY, '${{ secrets.CODEXIA_DEPLOY_SSH_PRIVATE_KEY }}');
  assert.equal(ssh.env.CODEXIA_DEPLOY_SSH_KNOWN_HOSTS, '${{ vars.CODEXIA_DEPLOY_SSH_KNOWN_HOSTS }}');
  assert.match(ssh.run, /StrictHostKeyChecking=yes/u);
  assert.match(ssh.run, /ssh-keygen -F 100\.100\.1\.68/u);
  assert.match(ssh.run, /codexia@100\.100\.1\.68/u);
  assert.doesNotMatch(ssh.run, /ansible-playbook|podman (?:pull|run|rm)|CODEXIA_PUSH_DEPLOYMENT_ENABLED/u);
});
