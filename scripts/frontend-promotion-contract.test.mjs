import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const require=createRequire(new URL('../packages/core/package.json',import.meta.url));
const {parse}=require('yaml');
const workflow=parse(readFileSync(new URL('../.github/workflows/frontend-release.yml',import.meta.url),'utf8'));

test('frontend PR producer remains read-only and main promotion requires exact source proof and live identity',()=>{
  assert.equal(workflow.concurrency.group, 'codexia-frontend-source-${{ github.event.pull_request.number || github.event.workflow_run.head_sha || github.sha }}');
  const build=workflow.jobs.build;
  assert.deepEqual(build.needs,['source','preflight']);
  assert.equal(build.permissions.contents,'read');
  assert.equal(build.permissions.actions,'read');
  assert.equal(build.permissions['pull-requests'],'read');
  assert.doesNotMatch(JSON.stringify(build),/secrets\./u);
  const promote=build.steps.find(step=>step.run?.includes('verify-frontend-artifact.mjs select-promotion'));
  assert.ok(promote);
  assert.equal(promote.env.CODEXIA_VERIFY_RUN_ID,undefined);
  assert.equal(promote.env.CODEXIA_LIVE_FRONTEND_VERSION,'${{ needs.preflight.outputs.frontend-version }}');
  const prProducer=build.steps.find(step=>step.id==='producer');
  assert.equal(prProducer.env.CODEXIA_PR_NUMBER,'${{ github.event.pull_request.number }}');
  execFileSync('bash',['-n'],{input:prProducer.run});
  const buildCheckout=build.steps.find(step=>step.uses==='actions/checkout@v7.0.1');
  assert.equal(buildCheckout.with['fetch-depth'],"${{ github.event_name == 'workflow_run' && '0' || '1' }}");
  const upload=build.steps.find(step=>step.id==='upload');
  assert.ok(upload);
  assert.match(upload.if,/pull_request/u);
  assert.match(upload.if,/promoted != 'true'/u);
  assert.equal(upload.with['retention-days'],"${{ github.event_name == 'pull_request' && 14 || 2 }}");
  const fallback=build.steps.find(step=>step.run?.includes('pnpm run build:frontend'));
  assert.match(fallback.if,/promoted != 'true'/u);
});

test('frontend deploy rechecks producer artifact, exact main source and deployed bytes before recording',()=>{
  const admission=workflow.jobs.source;
  assert.equal(admission.needs,undefined);
  assert.equal(admission.outputs['verify-run-id'],'${{ steps.gate.outputs.verify-run-id }}');
  assert.ok(admission.steps.some(step=>step.run?.includes('release-source-gate.mjs frontend')));
  assert.match(admission.if,/workflow_run/u);
  assert.doesNotMatch(admission.if,/head_sha == github\.sha/u);
  assert.deepEqual(workflow.jobs.deploy.concurrency, {
    group: 'codexia-frontend-${{ github.ref }}', 'cancel-in-progress': false,
  });
  const freshness=workflow.jobs.deploy.steps.findIndex(step=>step.id==='freshness');
  const compatibilityIndex=workflow.jobs.deploy.steps.findIndex(step=>step.id==='compatibility');
  assert.ok(freshness>=0 && compatibilityIndex>freshness);
  assert.equal(workflow.jobs.deploy.steps[compatibilityIndex].if,"steps.freshness.outputs.affected == 'true'");
  assert.match(admission.if,/conclusion == 'success'/u);
  const deploy=workflow.jobs.deploy;
  assert.match(deploy.if,/workflow_run/u);
  assert.match(deploy.if,/needs.source.outputs.affected/u);
  const verifyArtifact=deploy.steps.find(step=>step.run?.includes('verify-frontend-artifact.mjs'));
  const deployCheckout=deploy.steps.find(step=>step.uses==='actions/checkout@v7.0.1');
  assert.equal(deployCheckout.with['fetch-depth'],0);
  const compatibility=deploy.steps.find(step=>step.run?.includes('verify-frontend-compatibility.mjs')&&!step.run.includes('deployed'));
  const deployed=deploy.steps.find(step=>step.run?.includes('verify-frontend-compatibility.mjs deployed'));
  const record=deploy.steps.find(step=>step.run?.includes('record-component-release.mjs frontend'));
  assert.ok(verifyArtifact&&compatibility&&deployed&&record);
  assert.ok(deploy.steps.indexOf(verifyArtifact)<deploy.steps.indexOf(compatibility));
  assert.ok(deploy.steps.indexOf(deployed)<deploy.steps.indexOf(record));
  assert.equal(verifyArtifact.env.CODEXIA_FRONTEND_PRODUCER_SHA,'${{ needs.build.outputs.producer-sha }}');
  assert.equal(compatibility.env.CODEXIA_FRONTEND_PRODUCER_SHA,'${{ needs.build.outputs.producer-sha }}');
  assert.equal(record.env.CODEXIA_FRONTEND_PRODUCER_SHA,'${{ needs.build.outputs.producer-sha }}');
  assert.equal(verifyArtifact.env.CODEXIA_VERIFY_RUN_ID,"${{ needs.build.outputs.producer-verify-run-id || needs.source.outputs.verify-run-id }}");
  assert.equal(verifyArtifact.env.CODEXIA_FRONTEND_SOURCE_VERIFY_RUN_ID,'${{ needs.build.outputs.producer-verify-run-id }}');
  assert.equal(verifyArtifact.env.CODEXIA_FRONTEND_CERTIFIED_VERIFY_RUN_ID,'${{ needs.source.outputs.verify-run-id }}');
});
