import test from 'node:test';
import assert from 'node:assert/strict';
import { VERIFICATION_GROUPS } from './ci-contract.mjs';
import { createVerificationPlan, planDigest } from './ci-impact.mjs';
import { resolveExactMainCoverageProof } from './ci-task-proof-reuse.mjs';

const sourceSha = 'a'.repeat(40);
const candidateSha = 'b'.repeat(40);
const runtime = { platform: 'linux', arch: 'x64', nodeVersion: 'v24.22.3', execPath: '/opt/node/bin/node',
  cwd: '/home/runner/work/codexia/codexia', imageOS: 'ubuntu24', imageVersion: '20261115.1' };
const dimensions = ['source', 'tests', 'dependencies', 'environment', 'toolchain', 'recipe', 'producers'];

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
      workflowJob: 'types-tests', runtime,
      inputClosure: Object.fromEntries(dimensions.map(name => [name, name.charCodeAt(0).toString(16).padStart(64, '0')])),
    } : null;
    const results = tasks.map(task => ({ task, status: 'passed', seconds: 1,
      invocations: [{ executable: '/opt/node/bin/node', arguments: ['scripts/task.mjs', task], environmentKeys: [] }],
      ...(task === 'coverage' ? { inputProof } : {}),
    }));
    const report = { group, sha: sourceSha, planDigest: digest, workflowRunId: run.id,
      workflowAttempt: run.run_attempt, workflowJob: group, workflowRef: 'yohn-jp/codexia/.github/workflows/verify.yml@refs/heads/main',
      workflowSha: sourceSha, results };
    if (group === 'types-tests') {
      report.producerInventory = {
        format: 'codexia-ci-task-producer-inventory/v1', group, sourceSha, planDigest: digest,
        workflowRunId: run.id, workflowAttempt: run.run_attempt, workflowJob: group,
        workflowRef: report.workflowRef, workflowSha: sourceSha,
        runner: { os: 'Linux', arch: 'X64', imageOS: 'ubuntu24', imageVersion: '20261115.1', nodeVersion: 'v24.22.3' },
        selectedTasks: tasks, groupInvocations: [],
        taskInvocations: results.map(({ task, status, invocations }) => ({ task, status, invocations,
          ...(task === 'coverage' ? { inputProof } : {}) })),
      };
    }
    reports.set(`ci-evidence-${group}`, report);
    artifacts.push({ id: 900 + jobId, name: `ci-evidence-${group}`, digest: `sha256:${String(jobId).padStart(64, '0')}`,
      size_in_bytes: 100, expired: false, created_at: '2026-11-21T00:00:30Z',
      workflow_run: { id: run.id, head_sha: sourceSha } });
  }
  const certification = { id: jobId++, run_id: run.id, run_attempt: run.run_attempt, head_sha: sourceSha, name: 'certification',
    status: 'completed', conclusion: 'success', started_at: start, completed_at: end,
    steps: [{ name: 'Certify every required exact-source matrix element', conclusion: 'success' }] };
  jobs.push(certification);
  return { plan, run, jobs, artifacts, reports };
}

function mockRequest({ run, jobs, artifacts, latestRuns = [run] }) {
  return async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    const parsed = new URL(url);
    const prefix = '/repos/yohn-jp/codexia/';
    const endpoint = parsed.pathname.slice(prefix.length);
    let data;
    if (endpoint === 'actions/workflows/verify.yml') data = { id: 7, path: '.github/workflows/verify.yml' };
    else if (endpoint === 'actions/workflows/7/runs') data = { total_count: latestRuns.length, workflow_runs: latestRuns };
    else if (endpoint === `actions/runs/${run.id}/jobs`) data = { total_count: jobs.length, jobs };
    else if (endpoint === `actions/runs/${run.id}/artifacts`) data = { total_count: artifacts.length, artifacts };
    else throw new Error(`Unexpected request ${endpoint}`);
    return { ok: true, json: async () => data };
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
