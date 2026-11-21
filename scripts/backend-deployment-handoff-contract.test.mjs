import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const handoff = parse(readFileSync(new URL('../.github/workflows/backend-deployment-handoff.yml', import.meta.url), 'utf8'));
const backend = parse(readFileSync(new URL('../.github/workflows/backend-release.yml', import.meta.url), 'utf8'));

test('read-only handoff consumer only follows successful same-repository main backend publication', () => {
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
  assert.equal(handoff.jobs['verify-handoff'].steps[0].with.ref, '${{ github.event.workflow_run.head_sha }}');
  assert.equal(handoff.jobs['verify-handoff'].steps[0].with['persist-credentials'], false);
  assert.ok(job.steps.some(step => step.run === 'node scripts/verify-backend-push-handoff.mjs'));
  assert.ok(!JSON.stringify(handoff).includes('codexia-production'));
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
