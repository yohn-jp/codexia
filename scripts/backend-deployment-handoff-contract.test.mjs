import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const handoff = parse(readFileSync(new URL('../.github/workflows/backend-deployment-handoff.yml', import.meta.url), 'utf8'));
const backend = parse(readFileSync(new URL('../.github/workflows/backend-release.yml', import.meta.url), 'utf8'));

test('handoff consumer verifies successful same-repository main publication before exposing deployment inputs', () => {
  assert.deepEqual(handoff.on.workflow_run.workflows, ['Codexia Backend Image']);
  assert.deepEqual(handoff.on.workflow_run.types, ['completed']);
  assert.deepEqual(handoff.on.workflow_run.branches, ['main']);
  const job = handoff.jobs['verify-handoff'];
  assert.match(job.if, /github\.event\.workflow_run\.event == 'workflow_run'/u);
  assert.match(job.if, /github\.event\.workflow_run\.conclusion == 'success'/u);
  assert.match(job.if, /repository\.full_name == github\.repository/u);
  assert.match(job.if, /head_repository\.full_name == github\.repository/u);
  assert.equal(job.environment, undefined);
  assert.equal(job.permissions['id-token'], undefined);
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read', packages: 'read' });
  assert.equal(job.outputs['certified-full-image'], '${{ steps.verify.outputs.full-image }}');
  assert.equal(job.outputs['certified-full-api-epoch'], '${{ steps.verify.outputs.full-api-epoch }}');
  assert.equal(job.outputs['verified-main-sha'], '${{ steps.verify.outputs.verified-main-sha }}');
  assert.equal(job.outputs['producer-sha'], '${{ steps.verify.outputs.producer-sha }}');
  assert.equal(job.outputs['deployment-certificate'], '${{ steps.verify.outputs.full-certificate }}');
  assert.equal(handoff.jobs['verify-handoff'].steps[0].with.ref, '${{ github.event.workflow_run.head_sha }}');
  assert.equal(handoff.jobs['verify-handoff'].steps[0].with['persist-credentials'], false);
  const verifyStep = job.steps.find(step => step.run === 'node scripts/verify-backend-push-handoff.mjs');
  assert.ok(verifyStep);
  assert.equal(verifyStep.id, 'verify');
  for (const step of job.steps) {
    for (const value of Object.values(step.env ?? {})) assert.doesNotMatch(String(value), /secrets\./u);
  }
  const deploy = handoff.jobs['deploy-production'];
  assert.deepEqual(deploy.needs, ['verify-handoff']);
  assert.equal(deploy.environment.name, 'codexia-production');
  assert.equal(deploy.permissions['id-token'], 'write');
  assert.equal(deploy.concurrency.group, 'codexia-production');
  assert.equal(deploy.concurrency['cancel-in-progress'], false);
  assert.equal(deploy.concurrency.queue, 'max');
  assert.match(deploy.if, /needs\.verify-handoff\.result == 'success'/u);
  assert.match(deploy.if, /needs\.verify-handoff\.outputs\.verified-main-sha != ''/u);
  const deployCheckout = deploy.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(deployCheckout.with.ref, '${{ needs.verify-handoff.outputs.verified-main-sha }}');
  const converge = deploy.steps.find(step => step.name === 'Converge certified backend digest');
  assert.equal(converge.env.CODEXIA_VERIFIED_MAIN_SHA, deployCheckout.with.ref);
  assert.doesNotMatch(deploy.if, /CODEXIA_PUSH_DEPLOYMENT_ENABLED/u,
    'Environment-scoped variables must not be evaluated before Environment attachment');
  const deploymentGate = deploy.steps.find(step => step.id === 'deployment-gate');
  assert.ok(deploymentGate, 'the Environment-scoped deployment gate must run inside the protected job');
  assert.equal(deploymentGate.env.CODEXIA_PUSH_DEPLOYMENT_ENABLED, '${{ vars.CODEXIA_PUSH_DEPLOYMENT_ENABLED }}');
  const freshness = deploy.steps.find(step => step.id === 'freshness');
  assert.equal(deployCheckout.with['fetch-depth'], 0);
  assert.equal(freshness.run, 'node scripts/release-source-gate.mjs backend-deployment');
  assert.equal(freshness.env.CODEXIA_VERIFIED_MAIN_SHA, deployCheckout.with.ref);
  const afterEnablement = deploy.steps.slice(deploy.steps.indexOf(deploymentGate) + 1);
  const freshnessIndex = afterEnablement.indexOf(freshness);
  assert.ok(freshnessIndex >= afterEnablement.indexOf(deployCheckout));
  assert.ok(afterEnablement.slice(0, freshnessIndex + 1).every(step =>
    step.if === "steps.deployment-gate.outputs.enabled == 'true'"));
  assert.ok(afterEnablement.slice(freshnessIndex + 1).every(step =>
    step.if === "steps.freshness.outputs.current == 'true'"),
    'Stale or disabled deployments must not connect to the target or run Ansible');
});

test('the protected enablement step opts in only for the literal true and records a skipped deployment', t => {
  const step = handoff.jobs['deploy-production'].steps.find(step => step.id === 'deployment-gate');
  const directory = mkdtempSync(join(tmpdir(), 'codexia-deployment-gate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'output');
  const summary = join(directory, 'summary');
  for (const value of [undefined, '', 'false', 'TRUE', 'true ', 'true']) {
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const env = { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary };
    if (value !== undefined) env.CODEXIA_PUSH_DEPLOYMENT_ENABLED = value;
    execFileSync('bash', ['-c', step.run], { cwd: directory, env });

    const permission = readFileSync(output, 'utf8');
    const report = readFileSync(summary, 'utf8');
    if (value === 'true') {
      assert.equal(permission, 'enabled=true\n');
      assert.equal(report, '');
    } else {
      assert.equal(permission, 'enabled=false\n', `setting ${JSON.stringify(value)} must not enable deployment`);
      assert.match(report, /deployment safely skipped/u);
    }
  }
});

test('backend release emits certificate files only after exact-source publish and component release recording', () => {
  const job = backend.jobs.publish;
  const recordIndex = job.steps.findIndex(step => step.run === 'node scripts/record-component-release.mjs backend');
  const createIndex = job.steps.findIndex(step => step.run === 'node scripts/create-backend-deployment-certificates.mjs');
  const uploadIndex = job.steps.findIndex(step => step.uses === 'actions/upload-artifact@v7.0.2' &&
    step.with?.name?.startsWith('codexia-backend-deployment-certificate-'));
  assert.ok(recordIndex >= 0 && recordIndex < createIndex && createIndex < uploadIndex);
  assert.match(job.steps[createIndex].if, /steps\.freshness\.outputs\.affected == 'true'/u);
  assert.equal(job.steps[uploadIndex].with['if-no-files-found'], 'error');
  assert.equal(job.steps[uploadIndex].with['retention-days'], 7);
  assert.match(job.steps[uploadIndex].with.name, /github\.run_attempt/u);
  assert.match(job.steps[uploadIndex].with.name, /github\.run_id/u);
  assert.ok(backend.on.pull_request.paths.includes('scripts/backend-deployment-handoff-contract.test.mjs'));
});
