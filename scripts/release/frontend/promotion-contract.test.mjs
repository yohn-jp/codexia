import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const require=createRequire(new URL('../../../packages/core/package.json',import.meta.url));
const {parse}=require('yaml');
const workflow=parse(readFileSync(new URL('../../../.github/workflows/frontend-release.yml',import.meta.url),'utf8'));

test('frontend PR producer remains read-only and main promotion requires exact source proof and live identity',()=>{
  assert.equal(workflow.concurrency.group, 'codexia-frontend-source-${{ github.event.pull_request.number || github.event.workflow_run.head_sha || github.sha }}');
  const build=workflow.jobs.build;
  assert.equal(build.needs,'source');
  assert.doesNotMatch(build.if,/preflight|environment/u);
  assert.match(build.if,/needs\.source\.result == 'success'/u);
  assert.match(build.if,/needs\.source\.outputs\.affected == 'true'/u);
  assert.equal(build.permissions.contents,'read');
  assert.equal(build.permissions.actions,'read');
  assert.equal(build.permissions['pull-requests'],'read');
  assert.doesNotMatch(JSON.stringify(build),/secrets\./u);
  const preflight=workflow.jobs.preflight;
  const promote=preflight.steps.find(step=>step.run?.includes('scripts/verification/artifacts/frontend.mjs select-promotion'));
  assert.ok(promote);
  assert.equal(promote.env.CODEXIA_VERIFY_RUN_ID,undefined);
  assert.equal(promote.env.CODEXIA_LIVE_FRONTEND_VERSION,'${{ steps.probe.outputs.frontendVersion }}');
  assert.equal(preflight.environment,'codexia-production');
  assert.ok(preflight.steps.indexOf(promote)>preflight.steps.findIndex(step=>step.id==='probe'));
  assert.equal(preflight.permissions.contents,'read');
  assert.doesNotMatch(JSON.stringify(preflight),/CLOUDFLARE_API_TOKEN/u);
  assert.ok(!build.steps.some(step=>step.id==='promotion'));
  const prProducer=build.steps.find(step=>step.id==='producer');
  assert.equal(prProducer.env.CODEXIA_PR_NUMBER,'${{ github.event.pull_request.number }}');
  execFileSync('bash',['-n'],{input:prProducer.run});
  const buildCheckout=build.steps.find(step=>step.uses==='actions/checkout@v7.0.1');
  assert.equal(buildCheckout.with['fetch-depth'],"${{ github.event_name == 'workflow_run' && '0' || '1' }}");
  const upload=build.steps.find(step=>step.id==='upload');
  assert.ok(upload);
  assert.equal(upload.if,undefined);
  assert.equal(upload.with['retention-days'],"${{ github.event_name == 'pull_request' && 14 || 2 }}");
  const fallback=build.steps.find(step=>step.run?.includes('pnpm run build:frontend'));
  assert.equal(fallback.if,undefined);
});

test('frontend deploy rechecks producer artifact, exact main source and deployed bytes before recording',()=>{
  const admission=workflow.jobs.source;
  assert.equal(admission.needs,undefined);
  assert.equal(admission.outputs['verify-run-id'],'${{ steps.gate.outputs.verify-run-id }}');
  assert.ok(admission.steps.some(step=>step.run?.includes('scripts/release/components/source-gate.mjs frontend')));
  assert.match(admission.if,/workflow_run/u);
  assert.doesNotMatch(admission.if,/head_sha == github\.sha/u);
  assert.deepEqual(workflow.jobs.deploy.concurrency, {
    group: 'codexia-production', 'cancel-in-progress': false, queue: 'max',
  });
  const freshness=workflow.jobs.deploy.steps.findIndex(step=>step.id==='freshness');
  const compatibilityIndex=workflow.jobs.deploy.steps.findIndex(step=>step.id==='compatibility');
  assert.ok(freshness >= 0 && compatibilityIndex > freshness);
  assert.equal(workflow.jobs.deploy.steps[compatibilityIndex].if,"steps.freshness.outputs.affected == 'true'");
  assert.match(admission.if,/conclusion == 'success'/u);
  const deploy=workflow.jobs.deploy;
  assert.match(deploy.if,/workflow_run/u);
  assert.match(deploy.if,/needs.source.outputs.affected/u);
  assert.match(deploy.if,/needs\.preflight\.result == 'success'/u);
  assert.match(deploy.if,/needs\.build\.result == 'success'/u);
  assert.deepEqual(new Set(deploy.needs),new Set(['source','preflight','build']));
  assert.equal(deploy.environment,'codexia-production');
  const verifyArtifact=deploy.steps.find(step=>step.run?.includes('scripts/verification/artifacts/frontend.mjs'));
  const deployCheckout=deploy.steps.find(step=>step.uses==='actions/checkout@v7.0.1');
  assert.equal(deployCheckout.with['fetch-depth'],0);
  const compatibility=deploy.steps.find(step=>step.run?.includes('scripts/release/frontend/verify-compatibility.mjs')&&!step.run.includes('deployed'));
  const deployed=deploy.steps.find(step=>step.run?.includes('scripts/release/frontend/verify-compatibility.mjs deployed'));
  const record=deploy.steps.find(step=>step.run?.includes('scripts/release/components/record.mjs frontend'));
  assert.ok(verifyArtifact&&compatibility&&deployed&&record);
  assert.ok(deploy.steps.indexOf(verifyArtifact)<deploy.steps.indexOf(compatibility));
  assert.ok(deploy.steps.indexOf(deployed)<deploy.steps.indexOf(record));
  assert.equal(deploy.env.CODEXIA_FRONTEND_PRODUCER_SHA,'${{ needs.preflight.outputs.producer-sha || needs.build.outputs.producer-sha }}');
  assert.equal(deploy.env.CODEXIA_FRONTEND_ARTIFACT_DIGEST,'${{ needs.preflight.outputs.artifact-digest || needs.build.outputs.artifact-digest }}');
  for(const step of [verifyArtifact,compatibility,deployed,record]) assert.equal(step.env.CODEXIA_FRONTEND_PRODUCER_SHA,undefined);
  assert.equal(verifyArtifact.env.CODEXIA_VERIFY_RUN_ID,"${{ needs.preflight.outputs.producer-verify-run-id || needs.source.outputs.verify-run-id }}");
  assert.equal(deploy.env.CODEXIA_FRONTEND_SOURCE_VERIFY_RUN_ID,'${{ needs.preflight.outputs.producer-verify-run-id }}');
  assert.equal(verifyArtifact.env.CODEXIA_FRONTEND_CERTIFIED_VERIFY_RUN_ID,'${{ needs.source.outputs.verify-run-id }}');
});

test('the same public Web OAuth settings govern promotion, fallback builds, and deployed artifact checks',()=>{
  const keys=[
    'VITE_CODEXIA_OAUTH_ISSUER',
    'VITE_CODEXIA_OAUTH_CLIENT_ID',
    'VITE_CODEXIA_API_AUDIENCE',
    'VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI',
    'VITE_CODEXIA_OAUTH_SCOPES',
  ];
  const expected=Object.fromEntries(keys.map(key=>[key,'${{ vars.'+key+' }}']));
  const build=workflow.jobs.build;
  const promotion=workflow.jobs.preflight.steps.find(step=>step.id==='promotion');
  const fallback=build.steps.find(step=>step.run?.includes('pnpm run build:frontend'));
  const deployVerify=workflow.jobs.deploy.steps.find(step=>step.run?.includes('scripts/verification/artifacts/frontend.mjs'));
  const staticConfig=build.steps.find(step=>step.run?.includes('static-smoke.mjs'));
  const staticAcceptance=build.steps.find(step=>step.run?.includes('oauth-static-smoke.mjs'));
  const releasePaths=workflow.on.pull_request.paths;
  assert.deepEqual(promotion.env,Object.assign({},promotion.env,expected));
  assert.deepEqual(fallback.env,Object.assign({},fallback.env,expected));
  assert.deepEqual(deployVerify.env,Object.assign({},deployVerify.env,expected));
  assert.deepEqual(staticConfig.env,Object.assign({},staticConfig.env,expected));
  assert.ok(staticAcceptance);
  assert.equal(staticAcceptance.if,undefined);
  for(const path of ['scripts/build/frontend/oauth-config.mjs','scripts/build/frontend/oauth-config.test.mjs']) assert.ok(releasePaths.includes(path),path);
});
