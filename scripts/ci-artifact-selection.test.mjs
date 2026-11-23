import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { VERIFICATION_GROUPS } from './ci-contract.mjs';
import { createVerificationPlan, planDigest } from './ci-impact.mjs';
import { assertPlanEvidence } from './ci-evidence.mjs';
import { resolveProducerJobAttempts, selectLatestEvidenceArtifacts, selectLatestJobArtifact, selectLatestPlanArtifact } from './ci-artifact-selection.mjs';
import { collectGitHubArrayPages, collectGitHubPages } from './release-policy.mjs';
import { listProducerArtifacts } from './ci-producer-artifact.mjs';

const sourceSha = 'a'.repeat(40);
const runId = '40127302099';
const identity = { runId, sourceSha };
const plan = createVerificationPlan({ files: null, event: 'push', sha: sourceSha });
const selectedGroups = plan.groups;

function artifact(id, name, createdAt, { expired = false, run = runId, sha = sourceSha } = {}) {
  return { id, name, created_at: createdAt, expired, workflow_run: { id: Number(run), head_sha: sha } };
}

function job(name, startedAt, completedAt, { run = runId, sha = sourceSha, conclusion = 'success' } = {}) {
  return { name, run_id: Number(run), head_sha: sha, status: 'completed', conclusion, started_at: startedAt, completed_at: completedAt };
}

function report(group, failed = false) {
  return {
    group,
    sha: sourceSha,
    planDigest: planDigest(plan),
    results: VERIFICATION_GROUPS[group]
      .filter(task => plan.tasks.includes(task))
      .map(task => ({ task, status: failed ? 'failed' : 'passed' })),
  };
}

const successfulJobs = [
  job('plan', '2026-10-24T19:40:00Z', '2026-10-24T19:45:00Z'),
  ...selectedGroups.map(group => job(group,
    group === 'oci-core' ? '2026-10-24T19:55:00Z' : '2026-10-24T19:49:00Z',
    '2026-10-24T20:05:00Z')),
];

function ordinaryArtifacts() {
  const artifacts = [artifact(1000, 'ci-plan', '2026-10-24T19:44:00Z')];
  for (const [index, group] of selectedGroups.entries()) {
    const createdAt = group === 'oci-core' ? '2026-10-24T20:00:04Z' : '2026-10-24T19:50:00Z';
    artifacts.push(artifact(2000 + index, `ci-evidence-${group}`, createdAt));
  }
  return artifacts;
}

test('certification selector emits exact IDs for single and multiple selections', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'codexia-evidence-selection-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const planPath = path.join(directory, 'plan.json');
  const inventoryPath = path.join(directory, 'inventory.json');
  const outputPath = path.join(directory, 'github-output');
  const affected = createVerificationPlan({
    files: ['scripts/strictdoc/surface-inventory.json'], event: 'pull_request', sha: sourceSha, base: 'b'.repeat(40),
  });
  assert.deepEqual(affected.groups, ['types-tests']);
  const artifacts = ordinaryArtifacts();
  writeFileSync(inventoryPath, JSON.stringify({ artifacts, jobs: successfulJobs, identity }));
  const single = artifacts.find(item => item.name === 'ci-evidence-types-tests').id;
  const multiple = artifacts.slice(1).map(item => item.id).join(',');
  for (const [selectedPlan, expectedIds] of [[affected, single], [plan, multiple]]) {
    writeFileSync(planPath, JSON.stringify(selectedPlan));
    writeFileSync(outputPath, '');
    execFileSync(process.execPath, [fileURLToPath(new URL('./select-ci-evidence.mjs', import.meta.url))], {
      env: { ...process.env, GITHUB_OUTPUT: outputPath, GITHUB_RUN_ID: runId, CODEXIA_EXPECTED_SHA: sourceSha,
        CODEXIA_CI_PLAN_PATH: planPath, CODEXIA_CI_INVENTORY_PATH: inventoryPath },
    });
    assert.equal(readFileSync(outputPath, 'utf8'), `artifact-ids=${expectedIds}\n`);
  }
});

test('selects plan and evidence by latest successful job window and artifact created_at, not ID', () => {
  const artifacts = ordinaryArtifacts().filter(item => item.name !== 'ci-evidence-oci-core' && item.name !== 'ci-plan');
  const stalePlan = artifact(12_573_768_277, 'ci-plan', '2026-10-24T19:43:00Z');
  const latestPlan = artifact(12_572_824_349, 'ci-plan', '2026-10-24T19:44:30Z');
  const staleOci = artifact(12_573_768_277, 'ci-evidence-oci-core', '2026-10-24T19:53:33Z');
  const latestOci = artifact(12_572_824_349, 'ci-evidence-oci-core', '2026-10-24T20:00:04Z');
  artifacts.push(stalePlan, latestPlan, staleOci, latestOci);

  assert.equal(selectLatestPlanArtifact(artifacts, successfulJobs, identity).id, latestPlan.id);
  const selected = selectLatestEvidenceArtifacts(plan, artifacts, successfulJobs, identity);
  const selectedOci = selected.find(item => item.name === 'ci-evidence-oci-core');
  assert.equal(selectedOci.id, latestOci.id);
  assert.equal(selectedOci.created_at, '2026-10-24T20:00:04Z');
  assert.equal(staleOci.created_at < successfulJobs.find(item => item.name === 'oci-core').started_at, true);
});

test('selection sees latest artifacts on later complete REST pages', async () => {
  const artifacts = ordinaryArtifacts().filter(item => item.name !== 'ci-evidence-oci-core');
  artifacts.push(...Array.from({ length: 100 - artifacts.length }, (_, index) => ({ name: `diagnostic-${index}` })));
  artifacts.push(
    artifact(12_573_768_277, 'ci-evidence-oci-core', '2026-10-24T19:53:33Z'),
    artifact(12_572_824_349, 'ci-evidence-oci-core', '2026-10-24T20:00:04Z'),
  );
  assert.equal(artifacts.length, 102);
  const paginated = await collectGitHubPages(async (page, perPage) => ({
    total_count: artifacts.length,
    artifacts: artifacts.slice((page - 1) * perPage, page * perPage),
  }), 'artifacts');
  const selected = selectLatestEvidenceArtifacts(plan, paginated, successfulJobs, identity);
  assert.equal(selected.find(item => item.name === 'ci-evidence-oci-core').id, 12_572_824_349);
});

test('array-style GitHub REST pages are collected through the final short page', async () => {
  const releases = Array.from({ length: 201 }, (_, index) => ({ id: index + 1 }));
  const requested = [];
  const actual = await collectGitHubArrayPages(async (page, perPage) => {
    requested.push({ page, perPage });
    return releases.slice((page - 1) * perPage, page * perPage);
  });
  assert.deepEqual(actual, releases);
  assert.deepEqual(requested, [{ page: 1, perPage: 100 }, { page: 2, perPage: 100 }, { page: 3, perPage: 100 }]);
  await assert.rejects(collectGitHubArrayPages(async () => ({ releases: [] })), /Invalid GitHub array pagination response/u);
});

test('producer restore inventories only the exact artifact name and still rejects incomplete pages', async () => {
  const artifactName='ci-profile-build-core';
  const records=Array.from({length:101},(_,index)=>artifact(index+1,artifactName,'2026-10-24T19:50:00Z'));
  const requested=[];
  const request=async endpoint=>{
    const url=new URL(endpoint,'https://api.github.com/');
    assert.equal(url.pathname,`/actions/runs/${runId}/artifacts`);
    assert.equal(url.searchParams.get('name'),artifactName);
    const page=Number(url.searchParams.get('page'));
    const perPage=Number(url.searchParams.get('per_page'));
    requested.push(page);
    return {total_count:records.length,artifacts:records.slice((page-1)*perPage,page*perPage)};
  };
  assert.deepEqual(await listProducerArtifacts(request,runId,artifactName),records);
  assert.deepEqual(requested,[1,2]);
  await assert.rejects(
    listProducerArtifacts(async()=>({total_count:1,artifacts:[]}),runId,artifactName),
    /Incomplete GitHub pagination/u,
  );
});

test('a latest failed artifact remains selected and cannot certify', () => {
  const artifacts = ordinaryArtifacts().filter(item => item.name !== 'ci-evidence-oci-core');
  const oldFailure = artifact(12_573_768_277, 'ci-evidence-oci-core', '2026-10-24T19:53:33Z');
  const newPass = artifact(12_572_824_349, 'ci-evidence-oci-core', '2026-10-24T20:00:04Z');
  artifacts.push(oldFailure, newPass);
  const selected = selectLatestEvidenceArtifacts(plan, artifacts, successfulJobs, identity);
  const reportByArtifactId = new Map([
    [oldFailure.id, report('oci-core', true)],
    [newPass.id, report('oci-core')],
  ]);
  const latestReports = selected.map(item => reportByArtifactId.get(item.id) ?? report(item.name.slice('ci-evidence-'.length)));
  assert.doesNotThrow(() => assertPlanEvidence(plan, successfulJobs, latestReports));

  reportByArtifactId.set(newPass.id, report('oci-core', true));
  const latestFailedReports = selected.map(item => reportByArtifactId.get(item.id) ?? report(item.name.slice('ci-evidence-'.length)));
  assert.throws(() => assertPlanEvidence(plan, successfulJobs, latestFailedReports), /A selected validation failed/);
});

test('missing, tied, outside-window, or unsuccessful latest evidence fails closed', () => {
  const missing = ordinaryArtifacts().filter(item => item.name !== 'ci-evidence-oci-core');
  assert.throws(() => selectLatestEvidenceArtifacts(plan, missing, successfulJobs, identity), /Missing fresh CI artifact ci-evidence-oci-core/);

  const tied = ordinaryArtifacts().filter(item => item.name !== 'ci-evidence-oci-core');
  tied.push(
    artifact(12_573_768_277, 'ci-evidence-oci-core', '2026-10-24T20:00:04Z'),
    artifact(12_572_824_349, 'ci-evidence-oci-core', '2026-10-24T20:00:04Z'),
  );
  assert.throws(() => selectLatestEvidenceArtifacts(plan, tied, successfulJobs, identity), /Ambiguous latest CI artifact/);

  const outsideWindow = ordinaryArtifacts().filter(item => item.name !== 'ci-evidence-oci-core');
  outsideWindow.push(artifact(12_572_824_349, 'ci-evidence-oci-core', '2026-10-24T19:53:33Z'));
  assert.throws(() => selectLatestEvidenceArtifacts(plan, outsideWindow, successfulJobs, identity), /Missing fresh CI artifact/);

  const failedJobs = successfulJobs.map(item => item.name === 'oci-core' ? { ...item, conclusion: 'failure' } : item);
  assert.throws(() => selectLatestEvidenceArtifacts(plan, ordinaryArtifacts(), failedJobs, identity), /Workflow job did not succeed/);
});

test('artifact run, source and expiry are part of evidence selection', () => {
  const wrongRun = ordinaryArtifacts();
  const first = wrongRun.find(item => item.name === `ci-evidence-${selectedGroups[0]}`);
  wrongRun[wrongRun.indexOf(first)] = artifact(first.id, first.name, first.created_at, { run: '40127302098' });
  assert.throws(() => selectLatestEvidenceArtifacts(plan, wrongRun, successfulJobs, identity), /different workflow run/);

  const wrongSource = ordinaryArtifacts();
  const sourced = wrongSource.find(item => item.name === `ci-evidence-${selectedGroups[0]}`);
  wrongSource[wrongSource.indexOf(sourced)] = artifact(sourced.id, sourced.name, sourced.created_at, { sha: 'b'.repeat(40) });
  assert.throws(() => selectLatestEvidenceArtifacts(plan, wrongSource, successfulJobs, identity), /source SHA mismatch/);

  const expiredLatest = ordinaryArtifacts().filter(item => item.name !== 'ci-evidence-oci-core');
  expiredLatest.push(artifact(12_572_824_349, 'ci-evidence-oci-core', '2026-10-24T20:00:04Z', { expired: true }));
  assert.throws(() => selectLatestEvidenceArtifacts(plan, expiredLatest, successfulJobs, identity), /Latest CI artifact is expired/);
});

test('latest successful job attempt must belong to the exact workflow run and source', () => {
  const wrongRunJobs = successfulJobs.map(item => item.name === 'plan' ? { ...item, run_id: Number(runId) + 1 } : item);
  assert.throws(() => selectLatestPlanArtifact(ordinaryArtifacts(), wrongRunJobs, identity), /another run/);
  const wrongSourceJobs = successfulJobs.map(item => item.name === 'plan' ? { ...item, head_sha: 'b'.repeat(40) } : item);
  assert.throws(() => selectLatestPlanArtifact(ordinaryArtifacts(), wrongSourceJobs, identity), /source SHA mismatch/);
  assert.throws(() => selectLatestJobArtifact('ci-plan', 'plan', ordinaryArtifacts(), successfulJobs, { runId: 'not-a-run', sourceSha }), /run ID is invalid/);
});

test('partial rerun resolves a carried-over producer to its original execution attempt', async () => {
  const old = {...job('build-core', '2026-11-16T12:53:24Z', '2026-11-16T12:54:14Z'), id: 100, run_attempt: 1};
  const carried = {...old, id: 200, run_attempt: 2};
  const fresh = {...job('build-full', '2026-11-17T03:37:00Z', '2026-11-17T03:38:00Z'), id: 201, run_attempt: 2};
  const failed = {...fresh, name: 'oci-core', conclusion: 'failure'};
  const run = {id: Number(runId), run_attempt: 2};
  const request = async endpoint => {
    const attempt = Number(/attempts\/(\d+)\/jobs/u.exec(endpoint)[1]);
    const rows = attempt === 1 ? [old, {...fresh, id: 101, run_attempt: 1, started_at: old.started_at, completed_at: old.completed_at}] : [carried, fresh, failed];
    return {total_count: rows.length, jobs: rows};
  };
  const resolved = await resolveProducerJobAttempts([carried, fresh, failed], run, request, ['build-core','build-full','oci-core']);
  assert.deepEqual(resolved.map(item => item.run_attempt), [1,2,2]);
  assert.equal(resolved[2].conclusion, 'failure');
  await assert.rejects(resolveProducerJobAttempts([carried], run, async () => ({total_count:0,jobs:[]}), ['build-core']), /history unavailable/u);
});
