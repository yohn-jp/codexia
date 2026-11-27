import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { VERIFICATION_GROUPS } from '../impact/contract.mjs';
import { createVerificationPlan, planDigest } from '../impact/plan.mjs';
import { resolveProducerJobAttempts } from './artifact-selection.mjs';
import { captureCoverageInputClosure, coverageInvocation, coverageRuntime } from './coverage-inputs.mjs';
import { assertReusedCoverageProof, resolveExactMainCoverageProof } from './proof-reuse.mjs';
import { createGitHubProofClient } from './proof-client.mjs';
import { taskInvocation, taskWorkflowJob } from './task-inputs.mjs';
import { main as planProofReuse } from './reuse-coverage-proof.mjs';

const sourceSha = 'a'.repeat(40);
const candidateSha = 'b'.repeat(40);
const runtime = { platform: 'linux', arch: 'x64', nodeVersion: 'v24.22.3', execPath: '/opt/node/bin/node',
  cwd: '/home/runner/work/codexia/codexia', imageOS: 'ubuntu24', imageVersion: '20261115.1' };
const dimensions = ['source', 'tests', 'dependencies', 'environment', 'toolchain', 'recipe', 'producers'];

function responseFor(url, data, status = 200, headers = {}) {
  const response = Response.json(data, { status, headers });
  Object.defineProperty(response, 'url', { value: String(url) });
  return response;
}

test('unavailable proof keeps the impact plan and runs selected coverage', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codexia-proof-plan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const planPath = path.join(dir, 'plan.json');
  const selected = createVerificationPlan({ files: ['docs/README.md'], event: 'pull_request', sha: candidateSha, base: sourceSha });
  t.mock.property(process, 'argv', ['node', 'reuse-coverage-proof.mjs', 'plan']);
  t.mock.property(process, 'env', { CODEXIA_CI_PLAN_PATH: planPath, GH_TOKEN: 'fixture', GITHUB_REPOSITORY: 'yohn-jp/codexia', GITHUB_RUN_ID: '1' });
  for (const [name, fetch] of [
    ['timeout', async () => { throw new DOMException('Request timed out', 'TimeoutError'); }],
    ['HTTP failure', async () => new Response(null, { status: 503 })],
    ['invalid JSON', async () => new Response('not JSON')],
  ]) {
    await t.test(name, async t => {
      t.mock.method(globalThis, 'fetch', fetch);
      await writeFile(planPath, JSON.stringify(selected));
      await planProofReuse();
      assert.deepEqual(JSON.parse(await readFile(planPath, 'utf8')), selected);
    });
  }
});


test('task proof Octokit client accepts only the canonical read-only API paths', async () => {
  const seen = [];
  const request = async (url, options) => {
    const address = String(url);
    seen.push({ url: address, options });
    const pathname = new URL(address).pathname;
    const data = pathname.endsWith('/actions/workflows/7/runs')
      ? { total_count: 0, workflow_runs: [] }
      : pathname.endsWith('/commits/' + sourceSha + '/pulls') ? [] : { accepted: true };
    return responseFor(address, data);
  };
  const client = createGitHubProofClient({ repository: 'yohn-jp/codexia', token: 'test-token', request });
  const paths = [
    'actions/workflows/verify.yml',
    'actions/runs/500', 'pulls/123',
  ];
  for (const path of paths) assert.deepEqual(await client.get(path), { accepted: true });
  const runs = await client.paginate('actions/workflows/7/runs', { head_sha: sourceSha, event: 'push' }, 'workflow_runs');
  assert.deepEqual(runs, []);
  assert.deepEqual(await client.paginate('commits/' + sourceSha + '/pulls', {}, null), []);
  assert.equal(client.get.paginate, client.paginate);
  assert.deepEqual(await client.get.paginate('commits/' + sourceSha + '/pulls', {}, null), []);
  await assert.rejects(client.get.paginate('https://evil.example/upload', {}, null), /Unexpected GitHub task proof API endpoint/);
  assert.deepEqual(await client.paginate('/repos/yohn-jp/codexia/actions/workflows/7/runs',
    { head_sha: sourceSha, event: 'push' }, 'workflow_runs'), []);
  assert.ok(seen.every(item => item.url.startsWith('https://api.github.com/repos/yohn-jp/codexia/')));
  assert.ok(seen.every(item => new Headers(item.options.headers).get('authorization')?.includes('test-token')));
  assert.ok(seen.every(item => item.options.redirect === 'manual'));
});

test('task proof Octokit client blocks arbitrary file data and destinations without network I/O', async () => {
  let calls = 0;
  const request = async () => { calls += 1; throw new Error('Network request must not run'); };
  const client = createGitHubProofClient({ repository: 'yohn-jp/codexia', token: 'test-token', request });
  for (const path of [
    'https://evil.example/upload', '../user', '//evil.example/upload',
    '/repos/other-owner/other-repo/actions/workflows/7/runs',
    'actions/runs/500?token=file-content',
    'actions/runs/500/jobs?filter=latest&per_page=100&page=1&secret=extra',
    'actions/workflows/7/runs?head_sha=../private&event=push&per_page=100&page=1',
    'actions/runs/0', 'pulls/1/merge',
    'commits/' + sourceSha + '/pulls?per_page=100&page=1&secret=extra',
  ]) await assert.rejects(client.get(path), /Unexpected GitHub task proof API endpoint/);
  assert.equal(calls, 0);
  assert.throws(() => createGitHubProofClient({ repository: 'foreign/repo', token: 'test-token', request }),
    /canonical repository/);
  assert.throws(() => createGitHubProofClient({ repository: 'yohn-jp/codexia', token: '', request }),
    /GitHub read token is required/);
});

function mainEvidence({ latestConclusion = 'success' } = {}) {
  const plan = createVerificationPlan({ files: null, event: 'push', sha: sourceSha });
  const digest = planDigest(plan);
  const run = { id: 500, run_number: 20, run_attempt: 2, workflow_id: 7, path: '.github/workflows/verify.yml',
    repository: { id: 9 }, head_repository: { id: 9 }, head_sha: sourceSha, event: 'push', head_branch: 'main',
    status: 'completed', conclusion: latestConclusion };
  const start = '2026-11-21T00:00:00Z';
  const end = '2026-11-21T00:01:00Z';
  let jobId = 100;
  const jobs = [{ id: jobId++, run_id: run.id, run_attempt: run.run_attempt, head_sha: sourceSha, name: 'plan',
    status: 'completed', conclusion: 'success', started_at: start, completed_at: end }];
  const reports = new Map();
  const artifacts = [{ id: 900, name: 'ci-plan', digest: `sha256:${'1'.repeat(64)}`, size_in_bytes: 100,
    expired: false, created_at: '2026-11-21T00:00:30Z', workflow_run: { id: run.id, head_sha: sourceSha } }];
  for (const group of Object.keys(VERIFICATION_GROUPS)) {
    const id = jobId++;
    jobs.push({ id, run_id: run.id, run_attempt: run.run_attempt, head_sha: sourceSha, name: group,
      status: 'completed', conclusion: 'success', started_at: start, completed_at: end });
    const tasks = VERIFICATION_GROUPS[group].filter(task => plan.tasks.includes(task));
    const inputProof = group === 'types-tests' ? {
      format: 'codexia-ci-task-input-proof/v2', task: 'coverage', mode: 'static-coverage', status: 'passed',
      sourceSha, planDigest: digest, workflowRunId: run.id, workflowAttempt: run.run_attempt,
      workflowJob: 'types', runtime,
      inputClosure: Object.fromEntries(dimensions.map(name => [name, name.charCodeAt(0).toString(16).padStart(64, '0')])),
    } : null;
    const results = tasks.map(task => ({ task, status: 'passed', seconds: 1,
      invocations: task === 'coverage' ? [{ executable: '/opt/node/bin/node', arguments: ['scripts/task.mjs', task], environmentKeys: [] }]
        : (Array.isArray(taskInvocation(task, runtime.execPath)) ? taskInvocation(task, runtime.execPath) : [taskInvocation(task, runtime.execPath)]),
      ...(task === 'coverage' ? { inputProof } : { inputProof: {
        format: 'codexia-ci-task-input-proof/v2', task, mode: 'task-execution', status: 'passed', sourceSha,
        planDigest: digest, workflowRunId: run.id, workflowAttempt: run.run_attempt,
        workflowJob: taskWorkflowJob(task), runtime,
        inputClosure: Object.fromEntries(dimensions.map(name => [name, createHashDigit(task + name)])),
      } }),
    }));
    const report = { group, sha: sourceSha, planDigest: digest, workflowRunId: run.id,
      workflowAttempt: run.run_attempt, workflowJob: taskWorkflowJob(tasks[0]), workflowRef: 'yohn-jp/codexia/.github/workflows/verify.yml@refs/heads/main',
      workflowSha: sourceSha, results };
    report.producerInventory = {
      format: 'codexia-ci-task-producer-inventory/v1', group, sourceSha, planDigest: digest,
      workflowRunId: run.id, workflowAttempt: run.run_attempt, workflowJob: report.workflowJob,
      workflowRef: report.workflowRef, workflowSha: sourceSha,
      runner: { os: 'Linux', arch: 'X64', imageOS: 'ubuntu24', imageVersion: '20261115.1', nodeVersion: 'v24.22.3' },
      selectedTasks: tasks, groupInvocations: [],
      taskInvocations: results.map(({ task, status, invocations, inputProof: resultProof }) => ({ task, status, invocations,
        ...(resultProof ? { inputProof: resultProof } : {}) })),
    };
    reports.set(`ci-evidence-${group}`, report);
    artifacts.push({ id: 900 + jobId, name: `ci-evidence-${group}`, digest: `sha256:${String(jobId).padStart(64, '0')}`,
      size_in_bytes: 100, expired: false, created_at: '2026-11-21T00:00:30Z',
      workflow_run: { id: run.id, head_sha: sourceSha } });
  }
  const certification = { id: jobId++, run_id: run.id, run_attempt: run.run_attempt, head_sha: sourceSha, name: 'certification',
    status: 'completed', conclusion: 'success', started_at: start, completed_at: end,
    steps: [{ name: 'Certify every required exact-source matrix element', conclusion: 'success' },
      { name: 'Certify reused merged PR proof', conclusion: 'skipped' }] };
  jobs.push(certification);
  return { plan, run, jobs, artifacts, reports };
}

function createHashDigit(value) {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(64, '0').slice(-64);
}

function mockRequest({ run, jobs, artifacts, latestRuns = [run] }) {
  return async (url, options) => {
    assert.ok(new Headers(options.headers).get('authorization')?.includes('test-token'));
    const parsed = new URL(String(url));
    const prefix = '/repos/yohn-jp/codexia/';
    const endpoint = parsed.pathname.slice(prefix.length);
    let data;
    if (endpoint === 'actions/workflows/verify.yml') data = { id: 7, path: '.github/workflows/verify.yml' };
    else if (endpoint === 'actions/workflows/7/runs') data = { total_count: latestRuns.length, workflow_runs: latestRuns };
    else if (endpoint === `actions/runs/${run.id}/jobs` || endpoint.startsWith(`actions/runs/${run.id}/attempts/`)) data = { total_count: jobs.length, jobs };
    else if (endpoint === `actions/runs/${run.id}/artifacts`) data = { total_count: artifacts.length, artifacts };
    else throw new Error(`Unexpected request ${endpoint}`);
    return responseFor(url, data);
  };
}

test('resolves only certified full exact-base main coverage evidence by immutable artifact', async () => {
  const evidence = mainEvidence();
  const current = { workflow_id: 7, path: '.github/workflows/verify.yml', event: 'pull_request',
    head_sha: candidateSha, repository: { id: 9 } };
  const request = mockRequest(evidence);
  const receipt = await resolveExactMainCoverageProof({ plan: createVerificationPlan({ files: ['docs/README.md'],
    event: 'pull_request', sha: candidateSha, base: sourceSha }), current, repository: 'yohn-jp/codexia', token: 'test-token', request,
  readArtifact: async (artifact, filename) => filename === 'ci-plan.json' ? evidence.plan : evidence.reports.get(artifact.name) });
  assert.equal(receipt.sourceSha, sourceSha);
  assert.equal(receipt.workflowRunId, evidence.run.id);
  assert.equal(receipt.workflowAttempt, 2);
  assert.equal(receipt.artifactName, 'ci-evidence-types-tests');
  assert.match(receipt.artifactDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(receipt.inputClosure).sort(), [...dimensions].sort());
});

test('does not fall back to an older successful main run when the latest exact-base run failed', async () => {
  const older = mainEvidence().run;
  const latest = { ...older, id: older.id + 1, run_number: older.run_number + 1, conclusion: 'failure' };
  const evidence = mainEvidence();
  const current = { workflow_id: 7, path: '.github/workflows/verify.yml', event: 'pull_request',
    head_sha: candidateSha, repository: { id: 9 } };
  await assert.rejects(resolveExactMainCoverageProof({ plan: createVerificationPlan({ files: ['docs/README.md'],
    event: 'pull_request', sha: candidateSha, base: sourceSha }), current, repository: 'yohn-jp/codexia', token: 'test-token',
  request: mockRequest({ ...evidence, latestRuns: [older, latest] }),
  readArtifact: async (artifact, filename) => filename === 'ci-plan.json' ? evidence.plan : evidence.reports.get(artifact.name),
  }), /Latest exact-base main run failed/);
});

test('coverage proof resolution never requires proof receipts from NOT_SELECTED tasks', async t => {
  const evidence = mainEvidence();
  const request = t.mock.fn(mockRequest(evidence));
  const readArtifact = t.mock.fn(async (artifact, filename) =>
    filename === 'ci-plan.json' ? evidence.plan : evidence.reports.get(artifact.name));
  const options = {
    plan: createVerificationPlan({ files: ['docs/README.md'], event: 'pull_request', sha: candidateSha, base: sourceSha }),
    current: { workflow_id: 7, path: '.github/workflows/verify.yml', event: 'pull_request',
      head_sha: candidateSha, repository: { id: 9 } },
    repository: 'yohn-jp/codexia', token: 'test-token', request, readArtifact,
  };
  const receipt = await resolveExactMainCoverageProof(options);
  assert.equal(receipt.task, 'coverage');
  assert.equal(receipt.artifactName, 'ci-evidence-types-tests');
  const endpoints = request.mock.calls.map(call => call.arguments[0]);
  assert.equal(new Set(endpoints).size, endpoints.length, 'Each inventory page is requested once');
  assert.deepEqual(readArtifact.mock.calls.map(call => call.arguments[0].id).sort((a, b) => a - b),
    evidence.artifacts.map(artifact => artifact.id).sort((a, b) => a - b));

  const unselected = evidence.reports.get('ci-evidence-unit-core');
  delete unselected.results.find(item => item.task === 'unit-contracts').inputProof;
  delete unselected.producerInventory.taskInvocations.find(item => item.task === 'unit-contracts').inputProof;
  assert.deepEqual(await resolveExactMainCoverageProof(options), receipt,
    'An unrelated task input proof cannot invalidate coverage reuse');

  const selected = evidence.reports.get('ci-evidence-types-tests');
  delete selected.results.find(item => item.task === 'coverage').inputProof;
  delete selected.producerInventory.taskInvocations.find(item => item.task === 'coverage').inputProof;
  await assert.rejects(resolveExactMainCoverageProof(options), /proof/i);
});

test('a partial rerun certifies reused coverage from its original successful producer attempt', async () => {
  const evidence = mainEvidence();
  const runtime = coverageRuntime();
  const workflowJob = 'types';
  const inputClosure = await captureCoverageInputClosure({ root: runtime.cwd, runtime,
    invocation: coverageInvocation(runtime.execPath), workflowJob });
  evidence.reports.get('ci-evidence-types-tests').results.find(item => item.task === 'coverage').inputProof.inputClosure = inputClosure;
  const archives = new Map();
  for (const artifact of evidence.artifacts) {
    const isPlan = artifact.name === 'ci-plan';
    const content = isPlan ? evidence.plan : evidence.reports.get(artifact.name);
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
    await writer.add(isPlan ? 'ci-plan.json' : 'report.json', new TextReader(JSON.stringify(content)));
    const bytes = await writer.close();
    artifact.digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    artifact.size_in_bytes = bytes.length;
    archives.set(artifact.id, bytes);
  }
  const requestMetadata = mockRequest(evidence);
  const request = async (url, options) => {
    const { hostname, pathname } = new URL(String(url));
    if (hostname === 'storage.example') return new Response(archives.get(Number(pathname.slice(1))));
    const artifactId = pathname.match(/\/actions\/artifacts\/(\d+)\/zip$/u)?.[1];
    if (artifactId) return new Response(null, { status: 302, headers: { location: 'https://storage.example/' + artifactId } });
    return requestMetadata(url, options);
  };
  const current = { ...evidence.run, id: 600, event: 'pull_request', head_sha: candidateSha };
  const options = { current, repository: 'yohn-jp/codexia', token: 'test-token', request };
  const plan = createVerificationPlan({ files: ['docs/README.md'], event: 'pull_request', sha: candidateSha, base: sourceSha });
  const reusedFrom = await resolveExactMainCoverageProof({ ...options, plan });
  plan.coverageReuse = reusedFrom;
  const originalJob = { id: 140, name: 'types-tests', run_id: current.id, run_attempt: 1, head_sha: candidateSha,
    status: 'completed', conclusion: 'success', started_at: '2026-11-26T00:00:00Z', completed_at: '2026-11-26T00:01:00Z' };
  const alias = { ...originalJob, id: 141, run_attempt: current.run_attempt };
  const [candidateJob] = await resolveProducerJobAttempts([alias], current,
    async (_runId, attempt) => [attempt === 1 ? originalJob : alias], ['types-tests']);
  const report = { group: 'types-tests', sha: candidateSha, planDigest: planDigest(plan), workflowRunId: current.id,
    workflowAttempt: 1, workflowJob, workflowRef: 'yohn-jp/codexia/.github/workflows/verify.yml@refs/pull/20/merge',
    workflowSha: candidateSha };
  const proof = { format: 'codexia-ci-task-input-proof/v2', task: 'coverage', mode: 'static-coverage', status: 'passed',
    sourceSha: candidateSha, planDigest: report.planDigest, workflowRunId: current.id, workflowAttempt: 1, workflowJob,
    runtime, inputClosure, reusedFrom };
  report.results = [{ task: 'coverage', status: 'passed', invocations: [], inputProof: proof }];
  report.producerInventory = { format: 'codexia-ci-task-producer-inventory/v1', group: report.group, sourceSha: report.sha,
    planDigest: report.planDigest, workflowRunId: report.workflowRunId, workflowAttempt: report.workflowAttempt,
    workflowJob, workflowRef: report.workflowRef, workflowSha: report.workflowSha,
    runner: { os: runtime.platform, arch: runtime.arch, nodeVersion: runtime.nodeVersion,
      imageOS: runtime.imageOS, imageVersion: runtime.imageVersion },
    selectedTasks: ['coverage'], groupInvocations: [], taskInvocations: report.results };
  assert.equal(await assertReusedCoverageProof({ ...options, plan, report, candidateJob }), true);
  for (const [change, reason] of [
    [{ run_attempt: 2 }, /producer attempt mismatch/u],
    [{ run_id: 601 }, /producer run mismatch/u],
    [{ head_sha: sourceSha }, /producer source mismatch/u],
    [{ name: 'types-trace' }, /producer job mismatch/u],
    [{ conclusion: 'failure' }, /producer did not succeed/u],
  ]) await assert.rejects(assertReusedCoverageProof({ ...options, plan, report, candidateJob: { ...candidateJob, ...change } }), reason);
});
