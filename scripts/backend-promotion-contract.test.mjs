import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('../.github/workflows/backend-release.yml', import.meta.url), 'utf8'));

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
  const steps = workflow.jobs.publish.steps;
  const gate = steps.findIndex(step => step.id === 'freshness');
  const publication = steps.findIndex(step => step.id === 'push-image');
  assert.ok(gate >= 0 && gate < publication);
  assert.match(steps[gate].run, /release-source-gate\.mjs backend/u);
  assert.equal(steps[publication].if, "steps.freshness.outputs.affected == 'true'");
  assert.match(workflow.jobs['stable-channel'].if, /needs\.publish\.outputs\.certified-image != ''/u);
});
