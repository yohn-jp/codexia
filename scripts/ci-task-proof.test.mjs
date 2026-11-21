import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { assertSafetyTaskEvidence } from './ci-evidence.mjs';
import { assertBaseSafetyTaskEvidence, selectExactMainRun } from './ci-task-proof.mjs';
import { buildTaskInputFingerprint } from './ci-task-inputs.mjs';
import { createVerificationPlan, planDigest } from './ci-impact.mjs';
import { VERIFICATION_GROUPS } from './ci-contract.mjs';
const require=createRequire(new URL('../packages/core/package.json',import.meta.url));
const {parse}=require('yaml');

const fingerprint=()=>buildTaskInputFingerprint({files:[{path:'tsconfig.safety.json',sha256:'a'.repeat(64),bytes:1}],environment:{node:'v24.22.3'}});
const baseRun=(overrides={})=>({id:1,run_number:1,run_attempt:1,workflow_id:17,path:'.github/workflows/verify.yml',
  event:'push',head_sha:'a'.repeat(40),head_branch:'main',status:'completed',conclusion:'success',
  repository:{id:7},head_repository:{id:7},...overrides});
function completeEvidence(plan,taskFingerprint){
  const jobs=[{name:'plan',head_sha:plan.sha,status:'completed',conclusion:'success'},
    ...plan.groups.map(name=>({name,head_sha:plan.sha,status:'completed',conclusion:'success'}))];
  const reports=plan.groups.map(group=>({group,sha:plan.sha,planDigest:planDigest(plan),results:VERIFICATION_GROUPS[group]
    .filter(task=>plan.tasks.includes(task)).map(task=>({task,status:'passed'})),
    ...(group==='types-sources'?{taskInputs:{safety:taskFingerprint}}:{})}));
  return {jobs,reports};
}

test('base safety task proof requires an executed full-plan task and binds its fingerprint',()=>{
  const plan=createVerificationPlan({event:'push',sha:'a'.repeat(40)}),taskFingerprint=fingerprint();
  const {jobs,reports}=completeEvidence(plan,taskFingerprint);
  assert.equal(assertBaseSafetyTaskEvidence(plan,jobs,reports).digest,taskFingerprint.digest);
  const reused=structuredClone(reports);
  reused.find(item=>item.group==='types-sources').results.find(item=>item.task==='safety').reuse={
    format:'codexia-safety-task-proof/v1',sourceSha:plan.sha,before:'f'.repeat(40),fingerprint:taskFingerprint};
  assert.equal(assertBaseSafetyTaskEvidence(plan,jobs,reused).digest,taskFingerprint.digest);
  const malformed=structuredClone(reused);
  malformed.find(item=>item.group==='types-sources').results.find(item=>item.task==='safety').reuse.fingerprint=buildTaskInputFingerprint({
    files:[{path:'tsconfig.safety.json',sha256:'0'.repeat(64),bytes:1}],environment:{node:'v24.22.3'}});
  assert.throws(()=>assertBaseSafetyTaskEvidence(plan,jobs,malformed),/differs/u);
  const missing=structuredClone(reports);delete missing.find(item=>item.group==='types-sources').taskInputs;
  assert.throws(()=>assertBaseSafetyTaskEvidence(plan,jobs,missing),/missing|undefined/u);
});

test('first-parent evidence selects only the latest exact same-repository main run',()=>{
  const first=baseRun(),latest=baseRun({id:2,run_number:2});
  assert.equal(selectExactMainRun([first,latest],{baseSha:first.head_sha,workflowId:17,repositoryId:7}).id,2);
  assert.throws(()=>selectExactMainRun([first,baseRun({id:2,run_number:2,conclusion:'failure'})],
    {baseSha:first.head_sha,workflowId:17,repositoryId:7}),/Latest exact first-parent main Verify run failed/u);
  assert.throws(()=>selectExactMainRun([baseRun({head_branch:'topic'})],
    {baseSha:first.head_sha,workflowId:17,repositoryId:7}),/No exact first-parent/u);
  assert.throws(()=>selectExactMainRun([baseRun({head_repository:{id:8}})],
    {baseSha:first.head_sha,workflowId:17,repositoryId:7}),/No exact first-parent/u);
  assert.throws(()=>selectExactMainRun([first,first],{baseSha:first.head_sha,workflowId:17,repositoryId:7}),/Ambiguous/u);
});

test('certification accepts only exact first-parent safety reuse receipts',()=>{
  const plan=createVerificationPlan({event:'push',sha:'b'.repeat(40)}),taskFingerprint=fingerprint();
  const receipt={format:'codexia-safety-task-proof/v1',sourceSha:plan.sha,before:'e'.repeat(40),fingerprint:taskFingerprint};
  const reports=[{group:'types-sources',taskInputs:{safety:taskFingerprint},results:[{task:'safety',status:'passed',reuse:receipt}]}];
  assert.deepEqual(assertSafetyTaskEvidence(plan,reports),receipt);
  const different=buildTaskInputFingerprint({files:[{path:'tsconfig.safety.json',sha256:'f'.repeat(64),bytes:1}],environment:{node:'v24.22.3'}});
  assert.throws(()=>assertSafetyTaskEvidence(plan,[{...reports[0],taskInputs:{safety:different}}]),/fingerprint differs/u);
  const pr=createVerificationPlan({event:'pull_request',sha:'c'.repeat(40),base:'d'.repeat(40),files:['app/src/example.ts']});
  const prReceipt={...receipt,sourceSha:pr.sha,before:pr.base};
  assert.throws(()=>assertSafetyTaskEvidence(pr,[{...reports[0],results:[{task:'safety',status:'passed',reuse:prReceipt}]}]),/main-push only/u);
  assert.equal(assertSafetyTaskEvidence(plan,[{group:'types-sources',results:[{task:'safety',status:'passed'}]}]),null);
});

test('workflow carries the read-only proof to types and rechecks it with full history',()=>{
  const workflow=parse(readFileSync(new URL('../.github/workflows/verify.yml',import.meta.url),'utf8'));
  const plan=workflow.jobs.plan;
  const resolver=plan.steps.find(step=>step.run?.includes('scripts/ci-task-proof.mjs plan'));
  assert.ok(resolver);
  assert.equal(plan.permissions.actions,'read');
  assert.equal(plan.permissions['pull-requests'],'read');
  assert.match(resolver.env.GH_TOKEN,/github\.event_name == 'push'/u);
  const planArtifact=plan.steps.find(step=>step.uses==='actions/upload-artifact@v7.0.2'&&step.with.name==='ci-plan');
  assert.match(planArtifact.with.path,/safety-task-proof\.json/u);
  const types=workflow.jobs.types;
  assert.equal(types.permissions?.actions,undefined,'Task execution does not receive a GitHub read token');
  const typesCheckout=types.steps.find(step=>step.uses==='actions/checkout@v7.0.1');
  assert.match(typesCheckout.with['fetch-depth'],/safety_task_reuse/u);
  const certification=workflow.jobs.certification;
  const checkout=certification.steps.find(step=>step.uses==='actions/checkout@v7.0.1');
  assert.match(checkout.with['fetch-depth'],/safety_task_reuse/u);
  assert.ok(certification.steps.some(step=>step.run?.includes('scripts/certify-ci.mjs')));
});
