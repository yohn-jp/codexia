// Observational timing only; no certification or release authority.
import { VERIFICATION_LEAF_JOBS } from '../impact/contract.mjs';
import { normalizeVerificationJobName } from '../evidence/job-name.mjs';

export function seconds(start, end) {
  const first = Date.parse(start ?? '');
  const last = Date.parse(end ?? '');
  return Number.isFinite(first) && Number.isFinite(last) && last >= first ? (last - first) / 1000 : null;
}

export function summarizeCiTiming(run, jobs) {
  // Attempt-specific REST inventories can still contain carried-over executions.
  const attemptStartedAt = run.run_attempt > 1 ? run.run_started_at : run.created_at;
  const boundary = Date.parse(attemptStartedAt ?? '');
  const skipped = jobs.filter(job => job.conclusion === 'skipped');
  const carried = jobs.filter(job => job.conclusion !== 'skipped' &&
    (job.run_attempt < run.run_attempt || Date.parse(job.started_at ?? '') < boundary));
  // GitHub can report a placeholder started_at for a queued job. No runner has
  // been acquired until its status changes; never count such jobs as executions.
  const pendingStates = new Set(['queued', 'waiting', 'pending', 'requested']);
  const queued = jobs.filter(job => !skipped.includes(job) && !carried.includes(job) && pendingStates.has(job.status));
  // Completed/cancelled jobs with no assigned runner can still have synthetic
  // started_at/completed_at timestamps. Those are not consumed runner seconds.
  const noRunner = jobs.filter(job => !skipped.includes(job) && !carried.includes(job) &&
    !queued.includes(job) && Object.hasOwn(job, 'runner_id') &&
    !(Number.isSafeInteger(job.runner_id) && job.runner_id > 0));
  const current = jobs.filter(job => !skipped.includes(job) && !carried.includes(job) &&
    !queued.includes(job) && !noRunner.includes(job));
  const durations = current.map(job => seconds(job.started_at, job.completed_at));
  const queues = current.map(job => Date.parse(job.created_at ?? '') >= boundary ? seconds(job.created_at, job.started_at) : null);
  const sum = values => values.filter(value => value !== null).reduce((total, value) => total + value, 0);
  const complete = run.status === 'completed' && queued.length === 0 && Number.isFinite(boundary);
  const completed = current.map(job => seconds(attemptStartedAt, job.completed_at)).filter(value => value !== null);
  const observedElapsedSeconds = completed.length ? Math.max(...completed) : null;
  const gate = current.find(job => job.name === 'certification');
  const certificationElapsedSeconds = gate ? seconds(attemptStartedAt, gate.completed_at) : null;
  // A supplemental workflow call is not a dependency of Verify certification.
  const leaf = current.filter(job => VERIFICATION_LEAF_JOBS.includes(normalizeVerificationJobName(job.name)) &&
    seconds(attemptStartedAt, job.completed_at) !== null && (!gate || seconds(job.completed_at, gate.started_at) !== null))
    .sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at))[0];
  return {
    attemptStartedAt,
    wallClockSeconds: complete && durations.every(value => value !== null) ? observedElapsedSeconds : null,
    observedElapsedSeconds,
    runnerSeconds: complete && durations.every(value => value !== null) ? sum(durations) : null,
    observedRunnerSeconds: sum(durations),
    queueSeconds: complete && queues.every(value => value !== null) ? sum(queues) : null,
    observedQueueSeconds: sum(queues),
    longestJobQueueSeconds: queues.some(value => value !== null) ? Math.max(...queues.filter(value => value !== null)) : null,
    executedJobCount: current.length,
    queuedJobCount: queued.length,
    noRunnerJobCount: noRunner.length,
    cancelledBeforeRunnerJobCount: [...queued, ...noRunner].filter(job => job.conclusion === 'cancelled').length,
    cancelledAfterRunnerJobCount: current.filter(job => job.conclusion === 'cancelled').length,
    skippedJobCount: skipped.length,
    carriedJobCount: carried.length,
    certificationElapsedSeconds,
    criticalPath: run.name === 'Verify Codexia' && gate && leaf ? leaf.name + ' -> certification' : null,
    criticalPathNote: 'Last current-attempt canonical leaf completed before certification starts, not a calculated dependency chain. Supplemental calls are excluded from the certification path but included in workflow elapsed and runner time.',
    attemptMeasurementNote: 'Queued/waiting and completed jobs without an assigned runner, skipped jobs and carried execution from earlier attempts are excluded from runner/queue totals. Queue time is measured only after a job starts. Missing or inconsistent times are not complete evidence. Runner duration is elapsed execution, not billed minutes.',
  };
}
