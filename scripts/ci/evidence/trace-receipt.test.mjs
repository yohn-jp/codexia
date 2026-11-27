import assert from 'node:assert/strict';
import test from 'node:test';
import { selectTraceVerifyRun, summarizeCertifiedBrowser, summarizeCertifiedTrace, waitForTraceVerifyRun } from './trace-receipt.mjs';

const sourceSha = 'a'.repeat(40);
const repository = 'yohn-jp/codexia';
const expected = { sourceSha, repository, repositoryId: 81, event: 'pull_request' };
const run = {
  id: 21, run_number: 12, run_attempt: 2, head_sha: sourceSha, path: '.github/workflows/verify.yml',
  status: 'completed', conclusion: 'success', event: expected.event, repository: { id: 81 }, head_repository: { id: 81 },
};
const job = {
  name: 'certification', head_sha: sourceSha, run_id: 21, run_attempt: 2, status: 'completed', conclusion: 'success',
  steps: [{ name: 'Certify every required exact-source matrix element', status: 'completed', conclusion: 'success' }],
};
const selected = {
  id: 98, digest: 'sha256:' + 'b'.repeat(64), workflow_run: { id: run.id, head_sha: sourceSha, repository_id: 81, head_repository_id: 81 },
};
const inputs = {
  run, expected, certification: job, selected, producer: { run_attempt: 1 },
  group: { group: 'types-trace', sha: sourceSha, workflowRunId: run.id, workflowAttempt: 1, workflowJob: 'types',
    results: [{ task: 'requirements-trace', status: 'passed' }] },
  trace: {
    source: { sourceSha, worktreeClean: true },
    execution: { status: 'IN_PROGRESS', repository, sourceSha, runId: '21', runAttempt: 1, job: 'types',
      task: 'requirements-trace', runUrl: 'https://github.com/yohn-jp/codexia/actions/runs/21' },
    requiredCaseIds: ['TEST-TRC-01-001'],
    caseExecutions: [{ testId: 'TEST-TRC-01-001', result: 'PASSED' }, { testId: 'TEST-UI-002-001', result: 'NOT_RUN' }],
    obligationTrace: { rows: [] },
  },
};

test('selects the latest exact source Verify run only after successful completion', () => {
  assert.equal(selectTraceVerifyRun([run], expected), run);
  assert.equal(selectTraceVerifyRun([{ ...run, head_sha: 'b'.repeat(40) }], expected), null);
  assert.equal(selectTraceVerifyRun([{ ...run, head_repository: { id: 91 } }], expected), null);
  assert.equal(selectTraceVerifyRun([{ ...run, path: '.github/workflows/repository-audit.yml' }], expected), null);
  assert.equal(selectTraceVerifyRun([run, { ...run, id: 22, run_number: 13, status: 'in_progress', conclusion: null }], expected), null);
});

test('exports the certified trace artifact identity and the cases observed in its producer attempt', () => {
  assert.deepEqual(summarizeCertifiedTrace(inputs), {
    status: 'CERTIFIED', sourceSha, repository, runId: '21', attempt: 1, job: 'types', task: 'requirements-trace',
    runUrl: 'https://github.com/yohn-jp/codexia/actions/runs/21', artifactId: 98, artifactDigest: selected.digest,
    passedCaseIds: ['TEST-TRC-01-001'],
  });
});

test('[TEST-TRC-05-004] rejects foreign artifacts, stale source, skipped certification, mismatched attempts and skipped required cases', () => {
  const foreign = { ...selected, workflow_run: { ...selected.workflow_run, repository_id: 99 } };
  assert.throws(() => summarizeCertifiedTrace({ ...inputs, selected: foreign }), /artifact repository/iu);
  const wrongRun = { ...selected, workflow_run: { ...selected.workflow_run, id: run.id + 1 } };
  assert.throws(() => summarizeCertifiedTrace({ ...inputs, selected: wrongRun }), /another run/iu);
  const skippedTask = { ...inputs.group, results: [{ task: 'requirements-trace', status: 'skipped' }] };
  assert.throws(() => summarizeCertifiedTrace({ ...inputs, group: skippedTask }), /did not execute/iu);
  assert.throws(() => summarizeCertifiedTrace({ ...inputs, trace: { ...inputs.trace, source: { sourceSha: 'b'.repeat(40) } } }), /trace report source/iu);
  const skipped = { ...job, steps: [{ ...job.steps[0], conclusion: 'skipped' }] };
  assert.throws(() => summarizeCertifiedTrace({ ...inputs, certification: skipped }), /did not certify/iu);
  assert.throws(() => summarizeCertifiedTrace({ ...inputs, producer: { run_attempt: 2 } }), /producer attempt/iu);
  const trace = { ...inputs.trace, caseExecutions: [{ testId: 'TEST-TRC-01-001', result: 'SKIPPED' }] };
  assert.throws(() => summarizeCertifiedTrace({ ...inputs, trace }), /required trace case/iu);
});

test('a Pages build waits for the current exact Verify run and stops on a terminal result', async () => {
  const inProgress = { ...run, status: 'in_progress', conclusion: null };
  const failed = { ...run, conclusion: 'failure' };
  const batches = [[inProgress], [run]];
  const waits = [];
  const options = { waitSeconds: 120, pause: async milliseconds => { waits.push(milliseconds); } };
  assert.equal(await waitForTraceVerifyRun(async () => batches.shift(), expected, options), run);
  assert.equal(waits.length, 1);
  assert.equal(await waitForTraceVerifyRun(async () => [failed], expected, options), null);
  assert.equal(waits.length, 1, 'a terminal failure must not wait or fall back to another run');
  assert.equal(await waitForTraceVerifyRun(async () => [inProgress], expected), null);
});

test('certifies only passing browser observations matching the exact source registration', () => {
  const file = 'tests/e2e/ui-v1.acceptance.spec.ts';
  const testId = 'TEST-UI-001-001';
  const name = '[TEST-UI-001-001] opens Desktop';
  const browserTask = 'browser-core-ui-v1';
  const browserGroup = {
    group: browserTask, sha: sourceSha, workflowRunId: run.id, workflowAttempt: 1, workflowJob: 'browser',
    results: [{ task: browserTask, status: 'passed' }],
  };
  const observation = { file, line: 42, title: `ui-v1.acceptance.spec.ts › ${name}`, outcome: 'expected', attempts: [{ status: 'passed' }] };
  const reports = [{
    schemaVersion: 1, sourceSha, outcome: 'PASS', runStatus: 'passed', profile: 'core', shard: 'ui-v1', project: 'chromium',
    file: 'ui-v1.acceptance.spec.ts', expected: 1, executed: 1, passed: 1, skipped: 0, failed: 0, notRun: 0, tests: [observation],
  }];
  const cases = [{ testId, name, sourceRefs: [{ path: file, line: 42 }], result: 'NOT_RUN' }];
  const browserInputs = {
    ...inputs, producer: { run_attempt: 1, name: browserTask }, group: browserGroup, reports, cases,
  };
  const receipt = summarizeCertifiedBrowser(browserInputs);
  assert.equal(receipt[0].task, browserTask);
  assert.deepEqual(receipt[0].passedCaseIds, [testId]);
  assert.deepEqual(summarizeCertifiedBrowser({ ...browserInputs, cases: [{ ...cases[0], sourceRefs: [{ path: file, line: 43 }] }] }), []);
  assert.deepEqual(summarizeCertifiedBrowser({ ...browserInputs, reports: [{ ...reports[0], tests: [{ ...observation, attempts: [{ status: 'failed' }] }] }] }), []);
  assert.throws(() => summarizeCertifiedBrowser({ ...browserInputs, group: { ...browserGroup, workflowAttempt: 2 } }), /browser producer attempt/iu);
  assert.throws(() => summarizeCertifiedBrowser({ ...browserInputs, reports: [{ ...reports[0], sourceSha: 'c'.repeat(40) }] }), /browser coverage source/iu);
});
