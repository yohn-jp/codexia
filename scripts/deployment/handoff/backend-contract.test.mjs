import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const require = createRequire(new URL('../../../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const handoff = parse(readFileSync(new URL('../../../.github/workflows/backend-deployment-handoff.yml', import.meta.url), 'utf8'));
const backend = parse(readFileSync(new URL('../../../.github/workflows/backend-release.yml', import.meta.url), 'utf8'));

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
  for (const [output, field] of Object.entries({
    'certified-full-image': 'full-image', 'certified-full-api-epoch': 'full-api-epoch',
    'verified-main-sha': 'verified-main-sha', 'producer-sha': 'producer-sha', 'deployment-certificate': 'full-certificate',
  })) {
    assert.equal(job.outputs[output], '${{ steps.verify.outputs.' + field + ' || steps.manual.outputs.' + field + ' }}');
  }
  assert.equal(handoff.jobs['verify-handoff'].steps[0].with.ref, '${{ github.event.workflow_run.head_sha || github.sha }}');
  assert.equal(handoff.jobs['verify-handoff'].steps[0].with['persist-credentials'], false);
  const verifyStep = job.steps.find(step => step.run === 'node scripts/deployment/handoff/verify-push.mjs');
  assert.ok(verifyStep);
  assert.equal(verifyStep.id, 'verify');
  assert.equal(verifyStep.if, "github.event_name == 'workflow_run'");
  const manualStep = job.steps.find(step => step.id === 'manual');
  assert.equal(manualStep.if, "github.event_name == 'workflow_dispatch'");
  assert.equal(manualStep.run, 'node scripts/deployment/bootstrap/activate-backend.mjs certify');
  assert.match(job.if, /inputs\.approval_phrase == 'ACTIVATE_CODEXIA_BACKEND'/u);
  for (const step of job.steps) {
    for (const value of Object.values(step.env ?? {})) assert.doesNotMatch(String(value), /secrets\./u);
  }
  const deploy = handoff.jobs['deploy-production'];
  assert.deepEqual(deploy.needs, ['verify-handoff']);
  assert.equal(deploy.environment.name, 'codexia-production');
  assert.equal(deploy.permissions['id-token'], undefined, 'Cloudflare service auth replaces runner OIDC');
  assert.equal(deploy.concurrency.group, 'codexia-production');
  assert.equal(deploy.concurrency['cancel-in-progress'], false);
  assert.equal(deploy.concurrency.queue, 'max');
  assert.match(deploy.if, /needs\.verify-handoff\.result == 'success'/u);
  assert.match(deploy.if, /needs\.verify-handoff\.outputs\.verified-main-sha != ''/u);
  const deployCheckout = deploy.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  const verifiedSource = '${{ needs.verify-handoff.outputs.verified-main-sha }}';
  assert.equal(deployCheckout.with.ref, "${{ github.event_name == 'workflow_dispatch' && github.sha || needs.verify-handoff.outputs.verified-main-sha }}");
  const converge = deploy.steps.find(step => step.name === 'Converge certified backend digest');
  const ssh = deploy.steps.find(step => step.name === 'Prepare pinned SSH identity');
  assert.equal(ssh.env.CODEXIA_MANAGEMENT_HOSTNAME, '${{ env.CODEXIA_MANAGEMENT_HOSTNAME }}');
  const connection = deploy.steps.find(step => step.name === 'Verify pinned public-key SSH as codexia');
  assert.equal(connection.env.CF_ACCESS_CLIENT_ID, '${{ secrets.CODEXIA_SSH_ACCESS_CLIENT_ID }}');
  assert.equal(connection.env.CF_ACCESS_CLIENT_SECRET, '${{ secrets.CODEXIA_SSH_ACCESS_CLIENT_SECRET }}');
  assert.equal(converge.env.CF_ACCESS_CLIENT_ID, '${{ secrets.CODEXIA_SSH_ACCESS_CLIENT_ID }}');
  assert.equal(converge.env.CF_ACCESS_CLIENT_SECRET, '${{ secrets.CODEXIA_SSH_ACCESS_CLIENT_SECRET }}');
  const cloudflared = deploy.steps.find(step => step.name === 'Install checksum-pinned cloudflared client');
  assert.ok(cloudflared.run.includes('cloudflared/releases/download/2026.11.0/cloudflared-linux-amd64'));
  assert.equal(cloudflared.env.CLOUDFLARED_SHA256, '51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd');
  assert.equal(converge.env.CODEXIA_VERIFIED_MAIN_SHA, verifiedSource);
  assert.doesNotMatch(deploy.if, /CODEXIA_PUSH_DEPLOYMENT_ENABLED/u,
    'Environment-scoped variables must not be evaluated before Environment attachment');
  const deploymentGate = deploy.steps.find(step => step.id === 'deployment-gate');
  assert.ok(deploymentGate, 'the Environment-scoped deployment gate must run inside the protected job');
  assert.equal(deploymentGate.env.CODEXIA_PUSH_DEPLOYMENT_ENABLED, '${{ vars.CODEXIA_PUSH_DEPLOYMENT_ENABLED }}');
  const freshness = deploy.steps.find(step => step.id === 'freshness');
  assert.equal(deployCheckout.with['fetch-depth'], 0);
  assert.match(freshness.run, /if \[\[ "\$CODEXIA_MANUAL_ACTIVATION" == true \]\]; then\s+node scripts\/deployment\/bootstrap\/activate-backend\.mjs freshness\s+else\s+node scripts\/release\/components\/source-gate\.mjs backend-deployment/u);
  assert.equal(freshness.env.CODEXIA_MANUAL_ACTIVATION, "${{ github.event_name == 'workflow_dispatch' }}");
  assert.equal(freshness.env.CODEXIA_VERIFIED_MAIN_SHA, verifiedSource);
  const afterEnablement = deploy.steps.slice(deploy.steps.indexOf(deploymentGate) + 1);
  const freshnessIndex = afterEnablement.indexOf(freshness);
  assert.ok(freshnessIndex >= afterEnablement.indexOf(deployCheckout));
  assert.ok(afterEnablement.slice(0, freshnessIndex + 1).every(step =>
    step.if === "steps.deployment-gate.outputs.enabled == 'true'"));
  assert.ok(afterEnablement.slice(freshnessIndex + 1).every(step => [
    "steps.freshness.outputs.current == 'true'",
    "github.event_name == 'workflow_dispatch' && steps.freshness.outputs.current == 'true'",
    "github.event_name == 'workflow_run' && steps.freshness.outputs.current == 'true'",
  ].includes(step.if)), 'Stale or disabled deployments must not connect to the target or run Ansible');
  const recheck = deploy.steps.find(step => step.run === 'node scripts/deployment/handoff/recheck-verify.mjs');
  assert.ok(recheck && ssh && deploy.steps.indexOf(recheck) > deploy.steps.indexOf(freshness) &&
    deploy.steps.indexOf(recheck) < deploy.steps.indexOf(ssh) &&
    deploy.steps.indexOf(recheck) < deploy.steps.indexOf(converge),
  'the latest exact certified Verify attempt must be checked before privileged host access');
  assert.equal(recheck.env.CODEXIA_DEPLOYMENT_CERTIFICATE_B64,
    '${{ needs.verify-handoff.outputs.deployment-certificate }}');
  const manualAdmission = deploy.steps.find(step => step.run?.includes('activate-backend.mjs admit'));
  assert.ok(manualAdmission && deploy.steps.indexOf(manualAdmission) < deploy.steps.indexOf(converge));
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

test('manual first activation fails closed when publication or required approval is disabled', t => {
  const step = handoff.jobs['deploy-production'].steps.find(step => step.id === 'deployment-gate');
  const directory = mkdtempSync(join(tmpdir(), 'codexia-first-deployment-gate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'output');
  const env = {
    PATH: process.env.PATH, GITHUB_OUTPUT: output, CODEXIA_MANUAL_ACTIVATION: 'true',
    CODEXIA_INITIAL_INSTALL_APPROVED: 'true', CODEXIA_DATABASE_INITIALIZATION_APPROVED: 'true',
  };
  function runGate(overrides) {
    execFileSync('bash', ['-c', step.run], { cwd: directory, env: { ...env, ...overrides }, stdio: 'pipe' });
  }
  const rejectsWith = expected => error => {
    assert.match(String(error.stderr), expected);
    return true;
  };
  assert.throws(() => runGate({}), rejectsWith(/requires CODEXIA_PUSH_DEPLOYMENT_ENABLED=true/u));
  assert.throws(() => runGate({ CODEXIA_PUSH_DEPLOYMENT_ENABLED: 'true', CODEXIA_DATABASE_INITIALIZATION_APPROVED: '' }),
    rejectsWith(/requires first-install and database-use approvals/u));
  runGate({ CODEXIA_PUSH_DEPLOYMENT_ENABLED: 'true' });
  assert.equal(readFileSync(output, 'utf8'), 'enabled=true\n');
});

test('backend release emits certificate files only after exact-source publish and component release recording', () => {
  const job = backend.jobs.publish;
  const recordIndex = job.steps.findIndex(step => step.run === 'node scripts/release/components/record.mjs backend');
  const createIndex = job.steps.findIndex(step => step.run === 'node scripts/deployment/admission/create-certificates.mjs');
  const uploadIndex = job.steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@') &&
    step.with?.name?.startsWith('codexia-backend-deployment-certificate-'));
  assert.ok(recordIndex >= 0 && recordIndex < createIndex && createIndex < uploadIndex);
  assert.match(job.steps[createIndex].if, /steps\.freshness\.outputs\.affected == 'true'/u);
  assert.equal(job.steps[uploadIndex].with['if-no-files-found'], 'error');
  assert.ok(job.steps[uploadIndex].with['retention-days'] > 0, 'Certificate must have a retention window');
  assert.match(job.steps[uploadIndex].with.name, /github\.run_attempt/u);
  assert.match(job.steps[uploadIndex].with.name, /github\.run_id/u);
  assert.ok(backend.on.pull_request.paths.includes('scripts/deployment/handoff/backend-contract.test.mjs'));
});
