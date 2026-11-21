import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('../.github/workflows/backend-release.yml', import.meta.url), 'utf8'));
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

test('production deployment consumes the certified Full digest and provenance certificate after main publication', () => {
  const deploy = workflow.jobs['deploy-production'];
  assert.ok(deploy, 'certified production deployment job is required');
  assert.deepEqual(deploy.needs, ['source', 'publish']);
  assert.match(deploy.if, /github\.event_name == 'workflow_run'/u);
  assert.match(deploy.if, /github\.event\.workflow_run\.event == 'push'/u);
  assert.match(deploy.if, /github\.event\.workflow_run\.head_branch == 'main'/u);
  assert.match(deploy.if, /needs\.publish\.result == 'success'/u);
  assert.match(deploy.if, /needs\.publish\.outputs\.certified-full-image != ''/u);
  assert.match(deploy.if, /needs\.publish\.outputs\.deployment-certificate != ''/u);
  assert.match(deploy.if, /vars\.CODEXIA_PUSH_DEPLOYMENT_ENABLED == 'true'/u);
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

  const liveUi = deploy.steps.find(step => step.name === 'Verify live application identities and Access boundary for release admission');
  assert.ok(liveUi, 'the job must admit the current frontend epoch before deployment');
  assert.equal(liveUi.env.CODEXIA_ACCESS_CLIENT_ID, '${{ secrets.CODEXIA_ACCESS_CLIENT_ID }}');
  const certificate = workflow.jobs.publish.steps.find(step => step.name === 'Create provenance-bound Full push deployment certificate');
  assert.ok(certificate, 'the publisher must bind the exact successful main verification and image artifact');
  assert.equal(certificate.env.CODEXIA_CERTIFIED_FULL_IMAGE, '${{ steps.push-image.outputs.full-image }}');
  const ansible = deploy.steps.find(step => step.name === 'Converge certified backend digest');
  assert.ok(ansible, 'production deployment must apply the digest through Ansible');
  assert.equal(ansible.env.CODEXIA_CERTIFIED_FULL_IMAGE, '${{ needs.publish.outputs.certified-full-image }}');
  assert.equal(ansible.env.CODEXIA_PROFILE, 'full');
  assert.equal(ansible.env.CODEXIA_DEPLOYMENT_CERTIFICATE_B64, '${{ needs.publish.outputs.deployment-certificate }}');
  assert.match(ansible.run, /codexia_stage: deploy/u);
  assert.match(ansible.run, /codexia_image:/u);
});

test('Ansible routes the push stage through the codexia runtime and host lock', () => {
  const route = site.tasks.find(task => task.name === 'Deploy certified backend under host lock');
  assert.ok(route, 'site.yml must route the push deployment stage');
  assert.equal(route['ansible.builtin.include_tasks'].file, 'deploy.yml');
  assert.equal(route.when, "codexia_stage == 'deploy'");

  const stop = site.tasks.find(task => task.name === 'End push deployment before updater lifecycle stages');
  assert.equal(stop['ansible.builtin.meta'], 'end_host');
  assert.equal(stop.when, "codexia_stage == 'deploy'");

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
  assert.match(transaction['ansible.builtin.shell'], /backup-push-locked/u, 'updates must commit an encrypted off-VM backup under the same lock');
  assert.match(transaction['ansible.builtin.shell'], /restore_previous/u, 'failed candidate activation must restore the prior release');
  assert.match(transaction['ansible.builtin.shell'], /deploy-transaction\.json/u, 'a durable transaction intent must make interrupted deployments recoverable');
  assert.match(transaction['ansible.builtin.shell'], /current_image.*candidate_image/su, 'same-digest application must be idempotent');
});

test('the production Quadlet binds an immutable image and disables startup schema mutation', () => {
  const quadlet = readFileSync(new URL('../deploy/quadlet/codexia-api.container', import.meta.url), 'utf8');
  assert.match(quadlet, /^Image=CODEXIA_BACKEND_IMAGE$/mu);
  assert.match(quadlet, /^Environment=CODEXIA_PROFILE=CODEXIA_BACKEND_PROFILE$/mu);
  assert.match(quadlet, /^Environment=CODEXIA_DATABASE_MIGRATE_ON_START=0$/mu);
});
