import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('../.github/workflows/backend-release.yml', import.meta.url), 'utf8'));
const handoff = parse(readFileSync(new URL('../.github/workflows/backend-deployment-handoff.yml', import.meta.url), 'utf8'));
const tailscale = parse(readFileSync(new URL('../.github/workflows/tailscale-connectivity.yml', import.meta.url), 'utf8'));
const site = parse(readFileSync(new URL('../deploy/ansible/site.yml', import.meta.url), 'utf8'))[0];

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
  assert.ok(deployment.some(task => task.name === 'Admit the published candidate against installed API and deployed UI identities'));
  const candidateIdentity = deployment.find(task => task.name === 'Require candidate image source, profile and database compatibility identity');
  assert.ok(candidateIdentity['ansible.builtin.assert'].that.includes('codexia_candidate_identity == codexia_deployment_certificate.identity'));
  const activeUnit = deployment.find(task => task.name === 'Require the existing API unit before an image-only update');
  assert.ok(activeUnit, 'image-only updates must retain a concrete prior unit for rollback');
  assert.equal(activeUnit.when, 'codexia_current_container_exists.rc == 0');
  const recovery = deployment.find(task => task.name === 'Recover an interrupted push deployment before examining the active API');
  assert.ok(recovery, 'a retry must recover interrupted transactions before health preconditions');
  assert.match(recovery['ansible.builtin.command'].argv[0], /codexia-deploy-recover$/u);
  const recoveryScript = readFileSync(new URL('../deploy/ansible/push-deployment-recover.sh', import.meta.url), 'utf8');
  assert.match(recoveryScript, /deploy-transaction\.json/u);
  assert.match(recoveryScript, /rollback-api\.container/u);
  assert.match(recoveryScript, /flock --exclusive --nonblock/u);
  const transaction = deployment.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  assert.ok(transaction, 'Ansible must keep the service change and rollback inside one locked transaction');
  assert.match(transaction['ansible.builtin.shell'], /flock --exclusive --nonblock/u);
  assert.equal(transaction.args.executable, '/bin/bash');
  assert.equal(transaction.no_log, true, 'the deployment transaction must not log secret values');
  assert.match(transaction['ansible.builtin.shell'], /default\.target\.wants/u, 'the API must recover after a VM reboot');
  assert.match(transaction['ansible.builtin.shell'], /backup-locked[\s\S]*--approved[\s\S]*--lock-file[\s\S]*--lock-fd/u, 'updates must commit an encrypted off-VM backup under the same lock');
  assert.match(transaction['ansible.builtin.shell'], /restore_previous/u, 'failed candidate activation must restore the prior release');
  assert.match(transaction['ansible.builtin.shell'], /stop codexia-api\.service[\s\S]*running_image[\s\S]*candidate_image/u, 'candidate acceptance must follow successful shutdown and match the certified running digest');
  assert.match(transaction['ansible.builtin.shell'], /restored_image[\s\S]*rollback_image/u, 'rollback health must be bound to the prior digest snapshot');
  assert.match(transaction['ansible.builtin.shell'], /deploy-transaction\.json/u, 'a durable transaction intent must make interrupted deployments recoverable');
  assert.match(transaction['ansible.builtin.shell'], /current_image.*candidate_image/su, 'same-digest application must be idempotent');
  assert.match(transaction['ansible.builtin.shell'], /Candidate API readiness failed; deployment transaction remains pending if rollback is unverified/u);
});

test('the production Quadlet binds an immutable image and disables startup schema mutation', () => {
  const quadlet = readFileSync(new URL('../deploy/quadlet/codexia-api.container', import.meta.url), 'utf8');
  assert.match(quadlet, /^Image=CODEXIA_BACKEND_IMAGE$/mu);
  assert.match(quadlet, /^Environment=CODEXIA_PROFILE=CODEXIA_BACKEND_PROFILE$/mu);
  assert.match(quadlet, /^Environment=CODEXIA_DATABASE_MIGRATE_ON_START=0$/mu);
});

test('first activation initializes only a pristine database after backup under both explicit approvals', () => {
  const deployment = parse(readFileSync(new URL('../deploy/ansible/deploy.yml', import.meta.url), 'utf8'));
  const approval = deployment.find(task => task.name === 'Refuse implicit first activation without explicit verified schema approval');
  assert.deepEqual(approval['ansible.builtin.assert'].that, [
    'codexia_initial_install_approved | default(false) | bool',
    'codexia_database_initialization_approved | default(false) | bool',
  ]);
  const transaction = deployment.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  const shell = transaction['ansible.builtin.shell'];
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

test('push rollout admits backups only after canonical API and Tunnel shutdown', () => {
  const deployment = readFileSync(new URL('../deploy/ansible/deploy.yml', import.meta.url), 'utf8');
  const backup = readFileSync(new URL('../deploy/backup/backup.sh', import.meta.url), 'utf8');
  assert.match(deployment, /backup-locked[\s\S]*--approved[\s\S]*--lock-file/u);
  assert.match(backup, /Push deployment requires inactive systemd unit/u);
  assert.doesNotMatch(backup, /codexia-updater|--push-deployment/u);
});

test('push activation keeps one canonical API writer and exposes Tunnel only after readiness', () => {
  const deploy = parse(readFileSync(new URL('../deploy/ansible/deploy.yml', import.meta.url), 'utf8'));
  const transaction = deploy.find(task => task.name === 'Apply or recover the API Quadlet under the host lock');
  assert.ok(transaction, 'the app activation must remain one serialized transaction');
  const shell = transaction['ansible.builtin.shell'];

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
  assert.doesNotMatch(shell, /codexia-db\.container|codexia-postgres\.volume|podman volume/u,
    'an image-only API rollout must leave canonical PostgreSQL storage untouched');

  const restore = shell.indexOf('restore_previous(){');
  const restoreStartApi = shell.indexOf('systemctl --user start codexia-api.service', restore);
  const restoreHealth = shell.indexOf('podman inspect --format', restoreStartApi);
  const restoreStartTunnel = shell.indexOf('systemctl --user start codexia-tunnel.service', restoreHealth);
  assert.ok(restore !== -1 && restoreStartApi > restore && restoreHealth > restoreStartApi && restoreStartTunnel > restoreHealth,
    'rollback must restore and health-check the previous API before restoring Tunnel ingress');
  assert.match(shell, /Candidate API readiness failed; deployment transaction remains pending if rollback is unverified/u);
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
