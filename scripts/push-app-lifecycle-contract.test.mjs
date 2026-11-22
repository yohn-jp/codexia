import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('../.github/workflows/push-app-lifecycle.yml', import.meta.url), 'utf8'));
const backendWorkflow = parse(readFileSync(new URL('../.github/workflows/backend-release.yml', import.meta.url), 'utf8'));
const site = parse(readFileSync(new URL('../deploy/ansible/site.yml', import.meta.url), 'utf8'))[0];
const deploy = parse(readFileSync(new URL('../deploy/ansible/deploy.yml', import.meta.url), 'utf8'));

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
  const fixture = parse(readFileSync(new URL('../deploy/ansible/deploy-lifecycle-fixture.yml', import.meta.url), 'utf8'));
  assert.ok(fixture.some(task => task['ansible.builtin.include_tasks'] === 'deploy-transaction.yml'));
  assert.ok(fixture.some(task => /verification evidence/u.test(task.name ?? '')));
  assert.ok(parse(readFileSync(new URL('../deploy/ansible/deploy-transaction.yml', import.meta.url), 'utf8'))
    .some(task => task.name === 'Admit the published candidate against installed API and deployed UI identities'));
});

test('image selection binds the PR Full artifact and fails closed without a compatible verified release', () => {
  const source = readFileSync(new URL('./push-app-lifecycle.mjs', import.meta.url), 'utf8');
  const fixture = readFileSync(new URL('../deploy/ansible/test-push-app-lifecycle.sh', import.meta.url), 'utf8');
  assert.match(source, /selectBackendArtifacts/u);
  assert.match(source, /downloadArtifact/u);
  assert.match(source, /validatePushDeploymentCertificatePair/u);
  assert.match(source, /migrationFingerprint/u);
  assert.match(source, /apiEpoch/u);
  assert.match(source, /persistenceFormat/u);
  assert.match(source, /localhost:5000\/yohn-jp\/codexia-backend:lifecycle-/u);
  assert.match(fixture, /CAPABILITY_UNAVAILABLE/u);
  assert.match(fixture, /rootless_podman --version/u);
  assert.doesNotMatch(fixture, /\.Host\.Version/u);
  assert.ok(/for _ in \$\(seq 1 12\); do\n  postgres_health=\$\(rootless_podman inspect --format '\{\{\.State\.Health\.Status\}\}' codexia-db\)\n  \[\[ "\$postgres_health" == healthy \]\] && break\n  sleep 5\ndone/u.test(fixture), 'the live PostgreSQL healthcheck must be polled before declaring fixture setup failed');
  assert.match(fixture, /trap 'record_failure .* ERR/u);
  assert.match(fixture, /Last Ansible log .* redacted tail/u);
  assert.match(fixture, /Cloudflare Tunnel unit/u);
  assert.match(fixture, /cloudflareTunnel:\{status:'NOT_STARTED'/u);
  assert.match(fixture, /apiContainer!==previous\.apiContainer/u);
});
