import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('../.github/workflows/backend-release.yml', import.meta.url), 'utf8'));
const handoff = parse(readFileSync(new URL('../.github/workflows/backend-deployment-handoff.yml', import.meta.url), 'utf8'));

test('backend promotion resolver and publisher checkouts include full merge history', () => {
  for (const [jobName, proofScript] of [
    ['promotion', 'scripts/resolve-backend-promotion.mjs'],
    ['publish', 'scripts/verify-backend-promotion-handoff.mjs'],
  ]) {
    const job = workflow.jobs[jobName];
    const checkout = job.steps.find(step => step.uses === 'actions/checkout@v7.0.1');
    assert.ok(checkout, `${jobName} checkout is required`);
    assert.equal(checkout.with['fetch-depth'], 0, `${jobName} must inspect both merge parents`);
    assert.equal(checkout.with['persist-credentials'], false);
    assert.ok(job.steps.some(step => step.run?.includes(proofScript)), `${jobName} must run its source proof`);
  }
});

test('backend publication requires a still-eligible component source before registry writes', () => {
  assert.equal(workflow.env.CODEXIA_SOURCE_SHA, '${{ github.event.workflow_run.head_sha || github.event.pull_request.head.sha || github.sha }}');
  const steps = workflow.jobs.publish.steps;
  const gate = steps.findIndex(step => step.id === 'freshness');
  const publication = steps.findIndex(step => step.id === 'push-image');
  assert.ok(gate >= 0 && gate < publication);
  assert.match(steps[gate].run, /release-source-gate\.mjs backend/u);
  assert.equal(steps[publication].if, "steps.freshness.outputs.affected == 'true'");
  assert.ok(steps[publication].run.includes('scripts/backend-registry-tag.mjs'), 'Registry checks must use the verified source context');
  const deploy = handoff.jobs['deploy-production'];
  assert.deepEqual(deploy.needs, ['verify-handoff']);
  assert.match(deploy.if, /needs\.verify-handoff\.outputs\.certified-full-image != ''/u);
  assert.match(deploy.if, /needs\.verify-handoff\.outputs\.deployment-certificate != ''/u);
  assert.match(deploy.if, /vars\.CODEXIA_PUSH_DEPLOYMENT_ENABLED == 'true'/u);
  assert.equal(workflow.jobs['stable-channel'], undefined, 'retired pull publication must not exist');
});
