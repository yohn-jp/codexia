import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { blockingChain, nameMatches, observeRun, readVerifyGraph, summarizePR } from './analysis.mjs';
import { collect, identity, selectRuns } from './collect.mjs';

const at = offset => new Date(Date.UTC(2026,10,21,10,0,0) + offset * 1000).toISOString();
const graph = [
  'jobs:',
  '  plan:',
  '    name: plan',
  '  build:',
  '    name: build-' + '$' + '{{ matrix.profile }}',
  '    needs:',
  '      - plan',
  '  browser:',
  '    name: browser-' + '$' + '{{ matrix.group }}',
  '    needs:',
  '      - plan',
  '      - build',
  '  certification:',
  '    name: certification',
  '    needs:',
  '      - plan',
  '      - build',
  '      - browser',
].join('\n');
const run = (override = {}) => ({
  id: 1, name: 'Verify Codexia', status: 'completed', conclusion: 'success',
  created_at: at(0), run_started_at: at(1), run_attempt: 1,
  head_sha: 'a'.repeat(40), html_url: 'https://github.com/yohn-jp/codexia/actions/runs/1',
  ...override,
});
const job = (id,name,created,started,ended,extra = {}) => ({
  id,name,created_at: at(created),started_at:at(started),completed_at:at(ended),
  conclusion:'success',status:'completed',run_attempt:1,
  steps:[{name:'Run selected validations',started_at:at(started),completed_at:at(ended),conclusion:'success'}],
  ...extra,
});
const jobs = [
  job(1,'plan',0,1,4),
  job(2,'build-core',4,8,28),
  job(3,'build-full',4,6,20),
  job(4,'browser-core-webkit',28,31,57),
  job(5,'certification',57,59,62),
];

test('graph reads workflow job templates and needs, including matrix jobs', () => {
  const parsed = readVerifyGraph(graph);
  assert.deepEqual(parsed.find(x=>x.id==='browser').needs,['plan','build']);
  assert.equal(nameMatches(parsed.find(x=>x.id==='browser').template,'browser-core-webkit'),true);
  assert.equal(nameMatches(parsed.find(x=>x.id==='browser').template,'unit-core'),false);
  assert.throws(()=>readVerifyGraph('jobs:\n  plan:\n    name: plan\n'),/Unrecognized/u);
});

test('observed dependency chain chooses latest completed prerequisite', () => {
  const chain = blockingChain(run(),jobs,graph);
  assert.equal(chain.verified,true);
  assert.deepEqual(chain.names,['plan','build-core','browser-core-webkit','certification']);
  assert.equal(chain.certificationSeconds,62);
  const report = observeRun(run(),jobs,graph);
  assert.equal(report.timing.runnerSeconds,3+20+14+26+3);
  assert.equal(report.jobs.find(x=>x.name==='build-core').critical,true);
  assert.equal(report.jobs.find(x=>x.name==='build-full').critical,false);
  assert.equal(report.jobs.find(x=>x.name==='build-core').steps[0].phase,'Validation');
});

test('missing dependency or failed certification remains unavailable', () => {
  assert.equal(blockingChain(run(),jobs.filter(x=>!x.name.startsWith('build-') && x.name!=='plan'),graph).verified,false);
  assert.equal(blockingChain(run(),jobs.map(x=>x.name==='certification'?{...x,conclusion:'failure'}:x),graph).verified,false);
});

test('partial rerun never claims complete first-attempt comparison', () => {
  const retry = run({run_attempt:2,run_started_at:at(65)});
  const partial = jobs.map(j=>({...j,run_attempt:1}));
  partial.push(job(6,'certification',65,67,72,{run_attempt:2}));
  const observed = observeRun(retry,partial,graph);
  assert.equal(observed.timing.comparable,false);
  assert.equal(observed.timing.carriedJobCount,5);
  assert.equal(observed.chain.verified,false);
  assert.equal(observed.timing.runnerSeconds,5);
});

test('PR history does not manufacture a metric for incomplete runs', () => {
  const a = observeRun(run(),jobs,graph);
  const report = summarizePR(9,'a'.repeat(40),[a]);
  assert.equal(report.elapsedSeconds,62);
  assert.equal(report.verifyId,1);
  assert.equal(summarizePR(9,'a'.repeat(40),[{...a,status:'in_progress'}]).elapsedSeconds,null);
});

test('collector keeps latest run per workflow and exact PR revision', () => {
  const sha1='a'.repeat(40),sha2='b'.repeat(40);
  const metadata=(id,sha,workflow_id=7)=>({
    id,name:'Verify Codexia',workflow_id,created_at:at(id),run_attempt:1,
    pull_requests:[{number:42,head:{sha}}],
  });
  assert.deepEqual(identity(metadata(1,sha1)),{number:42,sha:sha1});
  assert.equal(identity({...metadata(1,sha1),pull_requests:[]}),null);
  const selected=selectRuns([metadata(1,sha1),metadata(2,sha1),metadata(3,sha2)]);
  assert.equal(selected.length,2);
  assert.equal(selected[0].sha,sha2);
  assert.deepEqual(selected[1].runs.map(x=>x.id),[2]);
});

test('collector uses bounded REST inventory with a real attempt and jobs', async () => {
  const metadata={...run(), workflow_id:7,pull_requests:[{number:42,head:{sha:'a'.repeat(40)}}]};
  const asked=[];
  const observed=await collect(async path=>{
    asked.push(path);
    if (path.startsWith('actions/runs?')) return {workflow_runs:[metadata]};
    if (path.startsWith('actions/runs/1/attempts/1/jobs?')) return {jobs};
    throw new Error('Unexpected request');
  },graph);
  assert.equal(observed.prs.length,1);
  assert.equal(observed.prs[0].runs[0].chain.verified,true);
  assert.equal(observed.coverage.scannedRuns,1);
  assert.ok(asked.some(x=>x.includes('/attempts/1/jobs')));
});

test('static shell displays live telemetry and no invented metrics', () => {
  const html=readFileSync(new URL('./site/index.html',import.meta.url),'utf8');
  const client=readFileSync(new URL('./site/dashboard.js',import.meta.url),'utf8');
  assert.match(html,/id="timeline"/u);
  assert.match(html,/id="history"/u);
  assert.match(client,/textContent/u);
  assert.doesNotMatch(html,/8m 42s|dummy|mock data/iu);
});

test('browser JavaScript syntax is valid without requiring a DOM at test time', () => {
  const file = fileURLToPath(new URL('./site/dashboard.js', import.meta.url));
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});
