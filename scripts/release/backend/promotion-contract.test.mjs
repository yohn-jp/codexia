import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(new URL('../../../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('../../../.github/workflows/backend-release.yml', import.meta.url), 'utf8'));

test('backend promotion resolver and publisher checkouts include full merge history', () => {
  for (const [jobName, proofScript] of [
    ['promotion', 'scripts/release/backend/resolve-promotion.mjs'],
    ['publish', 'scripts/deployment/handoff/verify-promotion.mjs'],
  ]) {
    const job = workflow.jobs[jobName];
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.ok(checkout, `${jobName} checkout is required`);
    assert.equal(checkout.with['fetch-depth'], 0, `${jobName} must inspect both merge parents`);
    assert.equal(checkout.with['persist-credentials'], false);
    assert.ok(job.steps.some(step => step.run?.includes(proofScript)), `${jobName} must run its source proof`);
  }
});

test('a publish-only rerun downloads the retained promotion job artifact by ID', () => {
  const promotion = workflow.jobs.promotion;
  const artifacts = promotion.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.ok(artifacts);
  assert.equal(promotion.outputs['handoff-artifact-id'], '${{ steps.' + artifacts.id + '.outputs.artifact-id }}');
  assert.match(promotion.outputs.promoted, /steps\.handoff\.outputs\.artifact-id != ''/u,
    'Missing artifact ID must select the exact-main build instead of downloading every artifact');

  const publishSteps = workflow.jobs.publish.steps;
  const download = publishSteps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.ok(download);
  assert.equal(download.with['artifact-ids'], '${{ needs.promotion.outputs.handoff-artifact-id }}');
  assert.equal(download.with.name, undefined, 'The publisher attempt cannot select the producer artifact');
  assert.equal(download.with['digest-mismatch'], 'error');
  const recheck = publishSteps.findIndex(step => step.run?.includes('scripts/deployment/handoff/verify-promotion.mjs'));
  assert.ok(publishSteps.indexOf(download) < recheck && recheck < publishSteps.findIndex(step => step.id === 'push-image'));
});

test('backend publication requires a still-eligible component source before registry writes', () => {
  assert.equal(workflow.env.CODEXIA_SOURCE_SHA, '${{ github.event.workflow_run.head_sha || github.event.pull_request.head.sha || github.sha }}');
  const steps = workflow.jobs.publish.steps;
  const gate = steps.findIndex(step => step.id === 'freshness');
  const publication = steps.findIndex(step => step.id === 'push-image');
  assert.ok(gate >= 0 && gate < publication);
  assert.match(steps[gate].run, /source-gate\.mjs backend/u);
  assert.equal(steps[publication].if, "steps.freshness.outputs.affected == 'true'");
  assert.ok(steps[publication].run.includes('scripts/release/backend/registry-tag.mjs'), 'Registry checks must use the verified source context');
  assert.equal(workflow.jobs['stable-channel'], undefined, 'retired pull publication must not exist');
});
