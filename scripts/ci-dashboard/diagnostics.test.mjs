import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiagnosticExport, distribution } from './diagnostics.mjs';
import { observeRun, summarizePR } from './analysis.mjs';

const at = offset => new Date(Date.UTC(2026,10,22,2,0,0)+offset*1000).toISOString();
const graph = ['jobs:','  plan:','    name: plan','  build:',
  '    name: build-${{ matrix.profile }}','    needs:','      - plan',
  '  browser:','    name: browser-${{ matrix.group }}','    needs:','      - plan','      - build',
  '  certification:','    name: certification','    needs:','      - plan',
  '      - build','      - browser'].join('\n');
const run = (id=44, sha='a'.repeat(40)) => ({
  id, name:'Verify Codexia',workflow_id:19,event:'pull_request',status:'completed',
  conclusion:'success',created_at:at(0),run_started_at:at(0),run_attempt:1,
  head_sha:sha,html_url:'https://github.com/yohn-jp/codexia/actions/runs/'+id,
});
const job = (id,name,created,start,end,override={}) => ({
  id,name,run_attempt:1,conclusion:'success',status:'completed',created_at:at(created),
  started_at:at(start),completed_at:at(end),runner_name:'GitHub Actions 7',
  labels:['ubuntu-24.04'],
  html_url:'https://github.com/yohn-jp/codexia/actions/runs/44/job/'+id,
  steps:[
    {number:1,name:'Initialize containers',started_at:at(start),completed_at:at(start+2),conclusion:'success'},
    {number:2,name:'Run selected validations',started_at:at(start+2),completed_at:at(end-1),conclusion:'success'},
  ],...override,
});
const jobs = [
  job(1,'plan',0,1,8),job(2,'build-full',8,10,28),
  job(3,'browser-full-webkit',28,30,91),job(4,'browser-full-writing',28,31,85),
  job(5,'certification',91,93,105),
];
const revision = (pr=42,id=44,sha='a'.repeat(40),list=jobs) =>
  summarizePR(pr,sha,[observeRun(run(id,sha),list,graph)]);
const coverage = {observedAt:at(110),scannedRuns:40,selectedRuns:6,
  selectedPRs:2,scannedPages:2,unresolvedRunCount:2,historyTruncated:true,note:'bounded'};
test('percentiles only cover finite measured nonnegative seconds', () => {
  assert.deepEqual(distribution([null,undefined,-1]), {
    count:0,minSeconds:null,p50Seconds:null,p90Seconds:null,maxSeconds:null,
    meanSeconds:null,totalSeconds:null,
  });
  const stats=distribution([1,2,3,4,5]);
  assert.equal(stats.count,5);
  assert.equal(stats.p50Seconds,3);
  assert.equal(stats.p90Seconds,5);
});
test('diagnostic JSON is source-bound, complete and keeps measured stages and competitors', () => {
  const selected=revision();
  const payload=JSON.parse(JSON.stringify(buildDiagnosticExport(selected,[selected],coverage,graph)));
  assert.equal(payload.schema,'codexia-ci-diagnostics/v1');
  assert.equal(payload.origin.pr,42);
  assert.equal(payload.origin.executedSha,'a'.repeat(40));
  assert.equal(payload.origin.bounds.historyTruncated,true);
  assert.equal(payload.selectedVerify.observedLastLeaf.leafName,'browser-full-webkit');
  assert.equal(payload.selectedVerify.observedLastLeaf.runnerUpGapSeconds,6);
  const verify=payload.workflows[0];
  assert.equal(verify.workflowId,19);
  assert.equal(verify.event,'pull_request');
  assert.equal(verify.jobs.length,5);
  const leaf=verify.jobs.find(job=>job.name==='browser-full-webkit');
  assert.equal(leaf.stages.beforeValidationSeconds,2);
  assert.equal(leaf.stages.validationSeconds,58);
  assert.equal(leaf.stages.containerInitializationSeconds,2);
  assert.equal(leaf.secondsBeforeLastRequiredLeaf,0);
  assert.deepEqual(leaf.runnerLabels,['ubuntu-24.04']);
  assert.deepEqual(leaf.dependencies.map(parent=>parent.family),['plan','build']);
  assert.equal(leaf.observedDependencyReadyToStartSeconds,2);
  assert.equal(verify.aggregate.longestJobs[0].name,'browser-full-webkit');
  assert.equal(payload.comparableJobShapeHistory.matchingCount,1);
  assert.equal(payload.comparableJobShapeHistory.certification.p50Seconds,105);
  assert.match(payload.interpretation.notMeasured.taskDurations,/artifacts/u);
});
test('history separates same job shape from other workloads and truncated runs', () => {
  const selected=revision();
  const otherShape=revision(43,45,'b'.repeat(40),jobs.filter(j=>j.name!=='browser-full-writing'));
  const truncated=revision(44,46,'c'.repeat(40));
  truncated.sampleTruncated=true;
  const payload=buildDiagnosticExport(selected,[selected,otherShape,truncated],coverage,graph);
  assert.equal(payload.comparableJobShapeHistory.successfulCandidateCount,2);
  assert.equal(payload.comparableJobShapeHistory.matchingCount,1);
});
test('failed certification, missing step timestamps and unknown graph do not invent data', () => {
  const brokenJobs=jobs.map(j=>j.name==='certification' ? {...j,conclusion:'failure'} :
    j.name==='browser-full-webkit' ? {...j,steps:[{number:1,name:'Initialize containers',conclusion:'success'}]} : j);
  const broken=revision(45,47,'d'.repeat(40),brokenJobs);
  const payload=buildDiagnosticExport(broken,[broken],coverage,'invalid graph');
  assert.equal(payload.origin.workflowGraph,null);
  assert.equal(payload.comparableJobShapeHistory.matchingCount,0);
  assert.equal(payload.selectedVerify.observedBlockingChain.verified,false);
  const verify=payload.workflows[0];
  const leaf=verify.jobs.find(j=>j.name==='browser-full-webkit');
  assert.equal(leaf.stages.beforeValidationSeconds,null);
  assert.equal(leaf.stages.containerInitializationSeconds,null);
  assert.equal(leaf.stages.missingStepTimings,1);
  assert.equal(verify.aggregate.missingStepTimings,1);
});
