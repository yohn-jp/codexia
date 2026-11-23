import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { blockingChain, comparableHistory, nameMatches, observeRun, readVerifyGraph, summarizePR } from './analysis.mjs';
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


test('bottleneck attribution separates validation and reveals near-finishing siblings', () => {
  const sameFinishGroup = [...jobs, job(7,'browser-full-writing',28,32,54)];
  const report = observeRun(run(),sameFinishGroup,graph);
  assert.equal(report.bottleneck.available,true);
  assert.equal(report.bottleneck.leafName,'browser-core-webkit');
  assert.equal(report.bottleneck.leafSeconds,26);
  assert.equal(report.bottleneck.leafQueueSeconds,3);
  assert.equal(report.bottleneck.beforeValidationSeconds,0);
  assert.equal(report.bottleneck.validationSeconds,26);
  assert.equal(report.bottleneck.certificationTailSeconds,5);
  assert.equal(report.bottleneck.runnerUpName,'browser-full-writing');
  assert.equal(report.bottleneck.runnerUpGapSeconds,3);
  assert.deepEqual(report.bottleneck.nearFinish.map(item=>item.name),
    ['browser-core-webkit','browser-full-writing']);
});

test('bottleneck remains unavailable for failed certification, reruns and missing steps', () => {
  assert.equal(observeRun(run({conclusion:'failure'}),jobs,graph).bottleneck.available,false);
  assert.equal(observeRun(run({run_attempt:2}),jobs,graph).bottleneck.available,false);
  const noSteps = jobs.map(item => item.name === 'browser-core-webkit' ? { ...item, steps: [] } : item);
  const observation = observeRun(run(),noSteps,graph).bottleneck;
  assert.equal(observation.available,true);
  assert.equal(observation.validationSeconds,null);
  assert.equal(observation.beforeValidationSeconds,null);
  assert.equal(observation.containerSeconds,null);
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

test('collector groups each PR run by the source SHA that actually executed', () => {
  const sha1='a'.repeat(40),sha2='b'.repeat(40);
  const metadata=(id,sourceSha,workflow_id,name,createdAt)=>({
    id,name,workflow_id,created_at:at(createdAt),run_attempt:1,head_sha:sourceSha,
    pull_requests:[{number:42,head:{sha:sha2}}],
  });
  assert.deepEqual(identity(metadata(1,sha1,7,'Verify Codexia',1)),{number:42,sha:sha1});
  assert.equal(identity({...metadata(1,sha1,7,'Verify Codexia',1),pull_requests:[]}),null);
  assert.equal(identity({...metadata(1,sha1,7,'Verify Codexia',1),pull_requests:[
    {number:42,head:{sha:sha2}},{number:43,head:{sha:sha2}},
  ]}),null);
  assert.equal(identity({...metadata(1,sha1,7,'Verify Codexia',1),head_sha:'unknown'}),null);
  const selected=selectRuns([
    metadata(1,sha1,8,'Build',1),metadata(2,sha1,8,'Build',2),
    metadata(3,sha1,7,'Verify Codexia',3),metadata(4,sha2,7,'Verify Codexia',4),
  ]);
  assert.deepEqual(selected.map(group=>({sha:group.sha,ids:group.runs.map(x=>x.id)})),[
    {sha:sha2,ids:[4]},
    {sha:sha1,ids:[3,2]},
  ]);
});

test('19 plus 2 run cap retains Verify and excludes the truncated revision from comparison', async () => {
  const firstSha='a'.repeat(40),secondSha='b'.repeat(40),mutablePRHead='c'.repeat(40);
  const metadata=(id,number,sha,workflow_id,name,createdAt)=>({
    id,workflow_id,name,created_at:at(createdAt),run_attempt:1,head_sha:sha,
    pull_requests:[{number,head:{sha:mutablePRHead}}],
  });
  const firstPR=Array.from({length:19},(_,index)=>metadata(
    index+1,50,firstSha,index+1,index===0?'Verify Codexia':'First PR workflow '+index,40-index));
  const secondPR=[
    metadata(20,51,secondSha,20,'Second PR non-Verify',20),
    metadata(21,51,secondSha,21,'Verify Codexia',19),
  ];
  const groups=selectRuns([...firstPR,...secondPR]);
  assert.deepEqual(groups.map(group=>({number:group.number,sha:group.sha,count:group.runs.length,
    truncated:group.sampleTruncated,hasVerify:group.runs.some(item=>item.name==='Verify Codexia')})),[
    {number:50,sha:firstSha,count:19,truncated:false,hasVerify:true},
    {number:51,sha:secondSha,count:1,truncated:true,hasVerify:true},
  ]);
  const summaries=groups.map(group=>summarizePR(group.number,group.sha,group.runs.map(item=>({
    id:item.id,name:item.name,status:'completed',createdAt:item.created_at,completedAt:at(60),
    timing:{runnerSeconds:10,comparable:true},
  })),{sampleTruncated:group.sampleTruncated}));
  assert.deepEqual(summaries.map(item=>({number:item.number,sha:item.sha,complete:item.complete,
    truncated:item.sampleTruncated,elapsedSeconds:item.elapsedSeconds})),[
    {number:50,sha:firstSha,complete:true,truncated:false,elapsedSeconds:38},
    {number:51,sha:secondSha,complete:false,truncated:true,elapsedSeconds:null},
  ]);
  assert.deepEqual(comparableHistory(summaries).map(item=>({number:item.number,sha:item.sha})),[
    {number:50,sha:firstSha},
  ]);
});

test('a completed group without Verify cannot become a comparison sample', () => {
  const summary=summarizePR(52,'d'.repeat(40),[{
    id:22,name:'Build only',status:'completed',createdAt:at(1),completedAt:at(20),
    timing:{runnerSeconds:10,comparable:true},
  }]);
  assert.equal(summary.complete,false);
  assert.equal(summary.elapsedSeconds,null);
  assert.deepEqual(comparableHistory([summary]),[]);
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

test('collector reports runs whose PR association cannot be resolved', async () => {
  const known={...run(),workflow_id:7,pull_requests:[{number:42,head:{sha:'b'.repeat(40)}}]};
  const unresolved={...run({id:2}),workflow_id:8,pull_requests:[
    {number:42,head:{sha:'b'.repeat(40)}},{number:43,head:{sha:'b'.repeat(40)}},
  ]};
  const observed=await collect(async path=>{
    if(path.startsWith('actions/runs?'))return {workflow_runs:[known,unresolved]};
    if(path.startsWith('actions/runs/1/attempts/1/jobs?'))return {jobs};
    throw new Error('Unexpected request: '+path);
  },graph);
  assert.equal(observed.coverage.unresolvedRunCount,1);
  assert.equal(observed.coverage.selectedRuns,1);
  assert.deepEqual(observed.prs.map(item=>({number:item.number,sha:item.sha})),[
    {number:42,sha:'a'.repeat(40)},
  ]);
});

test('bundled dashboard renders measured telemetry and copies source-bound diagnostics', {
  skip: !process.env.CODEXIA_AUDIT_TOOL_DIR,
  timeout: 30_000,
}, async t => {
  const require = createRequire(join(process.env.CODEXIA_AUDIT_TOOL_DIR, 'package.json'));
  const { chromium } = require('playwright-core');
  const output = await mkdtemp(join(tmpdir(), 'codexia-dashboard-test-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  execFileSync(process.execPath, [fileURLToPath(new URL('./collect.mjs', import.meta.url)), output, '--preview']);

  const browser = await chromium.launch(process.env.CODEXIA_E2E_CHROMIUM
    ? { executablePath: process.env.CODEXIA_E2E_CHROMIUM, headless: true }
    : { channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const contentTypes = {
    'index.html': 'text/html',
    'dashboard.js': 'text/javascript',
    'analysis.mjs': 'text/javascript',
    'collection.mjs': 'text/javascript',
    'diagnostics.mjs': 'text/javascript',
    'ci-timing.mjs': 'text/javascript',
    'ci-contract.mjs': 'text/javascript',
  };
  await page.route('http://localhost/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const name = path.split('/').pop();
    if (path === '/ci/verify.yml') return route.fulfill({ body: graph, contentType: 'text/plain' });
    if (!Object.hasOwn(contentTypes, name)) return route.fulfill({ status: 404 });
    return route.fulfill({ body: await readFile(join(output, path.slice(1))), contentType: contentTypes[name] });
  });
  let mode = 'measured';
  const browserJobs = [...jobs,
    { id: 6, name: 'optional-skipped', status: 'completed', conclusion: 'skipped', run_attempt: 1,
      created_at: at(0), started_at: null, completed_at: null, html_url: 'https://github.com/yohn-jp/codexia/actions/runs/1/job/6',
      steps: [{ number: 1, name: 'Skipped command', conclusion: 'skipped', started_at: null, completed_at: null }] },
    { id: 7, name: 'manual-gate', status: 'completed', conclusion: 'action_required', run_attempt: 1,
      created_at: at(0), started_at: null, completed_at: null, html_url: 'https://github.com/yohn-jp/codexia/actions/runs/1/job/7', steps: [] },
    { id: 8, name: 'pending-job', status: 'queued', conclusion: null, run_attempt: 1,
      created_at: at(0), started_at: null, completed_at: null, html_url: 'https://github.com/yohn-jp/codexia/actions/runs/1/job/8', steps: [] },
    { id: 9, name: 'unknown-outcome', status: 'completed', conclusion: null, run_attempt: 1,
      created_at: at(0), started_at: at(1), completed_at: at(2), html_url: 'https://github.com/yohn-jp/codexia/actions/runs/1/job/9', steps: [] },
  ];
  let releaseInventory;
  const inventoryReady = new Promise(resolve => { releaseInventory = resolve; });
  await page.route('https://api.github.com/repos/yohn-jp/codexia/actions/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/actions/runs')) {
      await inventoryReady;
      if (mode === 'empty') return route.fulfill({ json: { workflow_runs: [] } });
      if (mode === '403' || mode === '429') return route.fulfill({ status: Number(mode) });
      return route.fulfill({ json: { workflow_runs: [{ ...run(), workflow_id: 7, pull_requests: [{ number: 42 }] }] } });
    }
    if (mode === 'incomplete' && path.endsWith('/actions/runs/1/attempts/1/jobs') &&
      new URL(route.request().url()).searchParams.get('page') === '1') {
      return route.fulfill({ json: { jobs: Array.from({ length: 100 }, (_, index) => ({ ...jobs[0], id: index + 1 })) } });
    }
    if (mode === 'incomplete' && path.endsWith('/actions/runs/1/attempts/1/jobs')) {
      return route.fulfill({ json: { jobs: Array(100).fill(jobs[0]) } });
    }
    if (path.endsWith('/actions/runs/1/attempts/1/jobs')) return route.fulfill({ json: { jobs: browserJobs } });
    return route.fulfill({ status: 404 });
  });
  const copies = [];
  await page.exposeFunction('captureClipboard', text => { copies.push(text); });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: window.captureClipboard } });
  });

  await page.goto('http://localhost/ci/index.html?pr=42&sha=' + 'a'.repeat(40));
  const copyButton = page.getByRole('button', { name: '診断JSONをコピー' });
  assert.equal(await copyButton.isDisabled(), true);
  releaseInventory();
  const timeline = page.getByRole('region', { name: 'Job timeline' });
  await timeline.getByText('browser-core-webkit', { exact: false }).first().waitFor();
  assert.equal(await page.locator('#selection-result').textContent(), 'success');
  assert.match(await page.locator('#selection-bottleneck').textContent(), /browser-core-webkit/u);
  assert.equal(await page.getByRole('link', { name: '最新Verifyを開く' }).count(), 1);
  const stepsRegion = page.locator('.table-scroll');
  assert.equal(await stepsRegion.getAttribute('tabindex'), '0');
  await stepsRegion.focus();
  assert.equal(await stepsRegion.evaluate(element => document.activeElement === element), true);
  const history = page.getByRole('region', { name: 'PR revision history' });
  await history.getByRole('button', { name: /#42/u }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('pr'), '42');
  assert.equal(new URL(page.url()).searchParams.get('sha'), 'a'.repeat(40));
  assert.equal(await page.getByText('Executed source SHA').locator('..').locator('strong').textContent(), 'a'.repeat(40));
  assert.ok(await timeline.getByText('skipped', { exact: true }).count() >= 1);
  await timeline.getByText('blocked · action required', { exact: true }).waitFor();
  await timeline.getByText('queued · cause unknown', { exact: true }).waitFor();
  await timeline.getByText('unknown', { exact: true }).waitFor();
  const skippedDetails = timeline.locator('details').filter({ hasText: 'Skipped command' });
  await skippedDetails.locator('summary').press('Enter');
  await skippedDetails.getByText('Skipped command').waitFor();
  await skippedDetails.getByText('skipped · 未計測').waitFor();
  const workflowLink = page.getByRole('link', { name: 'GitHubでVerifyを開く' });
  assert.match(await workflowLink.getAttribute('href'), /^https:\/\/github\.com\/yohn-jp\/codexia\/actions\/runs\/1$/u);
  const workflowListLink = page.getByRole('link', { name: 'Verify Codexia · attempt #1' });
  assert.equal(await workflowListLink.getAttribute('href'), await workflowLink.getAttribute('href'));
  await copyButton.click();
  await page.getByRole('status').filter({ hasText: 'PR #42 の診断JSONをコピーしました。' }).waitFor();
  assert.equal(copies.length, 1);
  const copied = JSON.parse(copies[0]);
  assert.equal(copied.origin.pr, 42);
  assert.equal(copied.origin.executedSha, 'a'.repeat(40));
  assert.equal(copied.selectedVerify.observedLastLeaf.leafName, 'browser-core-webkit');
  assert.equal(copied.selectedVerify.observedLastLeaf.leafSeconds, 26);

  for (const status of ['403', '429']) {
    mode = status;
    await page.reload();
    await page.getByRole('status').filter({ hasText: new RegExp('CIデータを読み込めませんでした.*' + status, 'u') }).waitFor();
    assert.equal(await copyButton.isDisabled(), true);
    assert.equal(await page.locator('#selection-result').textContent(), '未計測');
    assert.equal(await page.getByRole('button', { name: '再試行' }).isVisible(), true);
    if (status === '403') {
      mode = 'measured';
      await page.getByRole('button', { name: '再試行' }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('status').filter({ hasText: 'Collected' }).waitFor();
    } else {
      mode = 'measured';
      await page.getByRole('button', { name: '再試行' }).click();
      await page.getByRole('status').filter({ hasText: 'Collected' }).waitFor();
    }
  }
  mode = 'empty';
  await page.reload();
  await page.getByRole('status').filter({ hasText: 'Bounded recent pull_request workflow sample' }).waitFor();
  assert.equal(await copyButton.isDisabled(), true);
  assert.equal(await timeline.getByText('この観測範囲にPRデータがありません。').count(), 1);
  mode = 'incomplete';
  await page.reload();
  await page.getByRole('status').filter({ hasText: /Job inventory exceeds supported pagination/u }).waitFor();
  assert.equal(await copyButton.isDisabled(), true);
  assert.equal(await timeline.getByText('browser-core-webkit', { exact: false }).count(), 0);
});

test('browser JavaScript syntax is valid without requiring a DOM at test time', () => {
  const file = fileURLToPath(new URL('./site/dashboard.js', import.meta.url));
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});
