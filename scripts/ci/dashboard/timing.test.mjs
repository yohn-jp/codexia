import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeCiTiming } from './timing.mjs';

const time = seconds => new Date(Date.UTC(2026, 10, 17, 12, 0, seconds)).toISOString();
const run = { name: 'Verify Codexia', created_at: time(0), run_started_at: time(0), run_attempt: 1, status: 'completed' };
const job = (name, created, started, completed, conclusion = 'success', run_attempt = 1) => ({
  name, created_at: time(created), started_at: time(started), completed_at: time(completed), conclusion, run_attempt,
});

test('supplemental and skipped jobs are not certification predecessors or runner usage', () => {
  const rows = [
    job('plan', 0, 1, 3), job('unit-core', 3, 5, 10),
    job('certification', 10, 11, 13),
    job('full-model-oci / Run pinned Full model lifecycle on rootless Podman', 3, 6, 20),
    job('browser-full-ui-v1', 3, 22, 22, 'skipped'),
  ];
  const report = summarizeCiTiming(run, rows);
  assert.equal(report.wallClockSeconds, 20);
  assert.equal(report.certificationElapsedSeconds, 13);
  assert.equal(report.criticalPath, 'unit-core -> certification');
  assert.equal(report.runnerSeconds, 23);
  assert.equal(report.queueSeconds, 7);
  assert.equal(report.longestJobQueueSeconds, 3);
  assert.equal(report.executedJobCount, 4);
  assert.equal(report.skippedJobCount, 1);
});

test('partial reruns exclude carried execution even when GitHub relabels its attempt', () => {
  const rerun = {...run, run_attempt: 2, run_started_at: time(30)};
  const report = summarizeCiTiming(rerun, [
    job('plan', 0, 1, 3, 'success', 2),
    job('unit-core', 3, 5, 10, 'success', 1),
    job('certification', 30, 32, 35, 'success', 2),
  ]);
  assert.equal(report.runnerSeconds, 3);
  assert.equal(report.queueSeconds, 2);
  assert.equal(report.wallClockSeconds, 5);
  assert.equal(report.carriedJobCount, 2);
  assert.equal(report.criticalPath, null);
});

test('a reusable profile browser can be the last certification predecessor', () => {
  const report = summarizeCiTiming(run, [
    job('plan', 0, 1, 3),
    job('profile-core / build-core', 3, 4, 8),
    job('profile-core / browser-core-writing', 8, 10, 18),
    job('certification', 18, 19, 21),
  ]);
  assert.equal(report.criticalPath, 'profile-core / browser-core-writing -> certification');
  assert.equal(report.runnerSeconds, 16);
});

test('unknown timestamps and in-progress work do not become complete timing evidence', () => {
  const report = summarizeCiTiming({...run, status: 'in_progress'}, [
    {...job('unit-core', 0, 2, 5), completed_at: null, conclusion: null},
    {...job('unit-modules', 0, 0, 7), created_at: null},
  ]);
  assert.equal(report.runnerSeconds, null);
  assert.equal(report.queueSeconds, null);
  assert.equal(report.wallClockSeconds, null);
  assert.equal(report.observedRunnerSeconds, 7);
  assert.equal(report.executedJobCount, 2);
});

test('rapid successive main merges leave pending checks out of executed runner counts', () => {
  const report = summarizeCiTiming({ ...run, status: 'in_progress' }, [
    { ...job('plan', 0, 1, 4), status: 'completed' },
    { ...job('unit-core', 4, 4, 4), status: 'queued', completed_at: null, conclusion: null },
    { ...job('browser-core-ui-v1', 4, 4, 4), status: 'waiting', completed_at: null, conclusion: null },
    { ...job('browser-full-reference', 4, 4, 4), status: 'requested', completed_at: null, conclusion: null },
  ]);
  assert.equal(report.queuedJobCount, 3);
  assert.equal(report.executedJobCount, 1);
  assert.equal(report.observedRunnerSeconds, 3);
  assert.equal(report.observedQueueSeconds, 1);
  assert.equal(report.longestJobQueueSeconds, 1);
  assert.equal(report.runnerSeconds, null);
  assert.equal(report.queueSeconds, null);
  assert.equal(report.wallClockSeconds, null);
});

test('cancelled pre-runner jobs with synthetic timestamps never consume runner seconds', () => {
  const report = summarizeCiTiming({ ...run, conclusion: 'cancelled' }, [
    { ...job('plan', 0, 1, 4), status: 'completed', runner_id: 100 },
    { ...job('unit-core', 4, 6, 10, 'cancelled'), status: 'completed', runner_id: 101 },
    { ...job('types-tests', 4, 4, 10, 'cancelled'), status: 'completed', runner_id: 0, steps: [] },
    { ...job('oci-full', 4, 4, 10, 'cancelled'), status: 'completed', runner_id: null, steps: [] },
  ]);
  assert.equal(report.queuedJobCount, 0);
  assert.equal(report.noRunnerJobCount, 2);
  assert.equal(report.cancelledBeforeRunnerJobCount, 2);
  assert.equal(report.cancelledAfterRunnerJobCount, 1);
  assert.equal(report.executedJobCount, 2);
  assert.equal(report.runnerSeconds, 7);
  assert.equal(report.observedRunnerSeconds, 7);
  assert.equal(report.queueSeconds, 3);
  assert.equal(report.longestJobQueueSeconds, 2);
});
