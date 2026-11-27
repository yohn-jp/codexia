// Observational diagnostic export from public Actions run/job/step metadata.
// Never used as certification, branch-protection or release evidence.
import { readVerifyGraph, nameMatches } from './analysis.mjs';
import { seconds } from './timing.mjs';

export const DIAGNOSTIC_SCHEMA = 'codexia-ci-diagnostics/v1';
const measured = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const stamp = value => { const time = Date.parse(value ?? ''); return Number.isFinite(time) ? time : null; };
const round = n => n === null ? null : Math.round(n * 100) / 100;
const total = values => round(values.reduce((sum, value) => sum + value, 0));
export function distribution(values) {
  const sorted = values.map(measured).filter(v => v !== null).sort((a,b) => a-b);
  if (!sorted.length) return { count: 0, minSeconds: null, p50Seconds: null, p90Seconds: null,
    maxSeconds: null, meanSeconds: null, totalSeconds: null };
  const at = ratio => sorted[Math.ceil(sorted.length * ratio)-1];
  return { count: sorted.length, minSeconds: round(sorted[0]), p50Seconds: round(at(.5)),
    p90Seconds: round(at(.9)), maxSeconds: round(sorted.at(-1)),
    meanSeconds: round(total(sorted) / sorted.length), totalSeconds: total(sorted) };
}
const counts = values => values.reduce((acc, value) => {
  const key = String(value ?? 'unknown').slice(0, 128);
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});
const phases = ['Setup', 'Dependencies', 'Build', 'Artifacts', 'Validation', 'Other'];
const verifyOf = pr => pr?.runs?.find(run => run.id === pr.verifyId) ?? null;
const signatureOf = run => run?.name === 'Verify Codexia'
  ? run.jobs.filter(job => job.conclusion !== 'skipped').map(job => job.name).sort().join('|') : null;
const eligibleVerify = pr => {
  const verify = verifyOf(pr);
  return pr?.complete === true && pr.sampleTruncated !== true &&
    verify?.status === 'completed' && verify.conclusion === 'success' &&
    verify.attempt === 1 && verify.chain?.verified ? verify : null;
};
const stepReport = step => ({
  number: step.number ?? null, name: step.name, phase: step.phase,
  startedAt: step.startedAt ?? null, completedAt: step.completedAt ?? null,
  elapsedSeconds: measured(step.durationSeconds), result: step.conclusion ?? null,
});
function jobReport(job, run, graph, leafFinish) {
  const steps = (job.steps ?? []).map(stepReport);
  const complete = steps.filter(step => step.elapsedSeconds !== null);
  const selected = complete.find(step => step.name === 'Run selected validations');
  const container = complete.find(step => step.name === 'Initialize containers');
  const graphMatches = graph.filter(spec => nameMatches(spec.template, job.name));
  const spec = graphMatches.length === 1 ? graphMatches[0] : null;
  const dependencies = spec?.needs.map(family => {
    const parent = graph.find(item => item.id === family || item.family === family);
    return { family, jobs: parent ? run.jobs.filter(entry =>
      nameMatches(parent.template, entry.name)).map(entry => entry.name) : [] };
  }) ?? [];
  const parents = dependencies.flatMap(item => item.jobs.map(name =>
    run.jobs.find(candidate => candidate.name === name))).filter(Boolean);
  const parentFinish = parents.length && parents.every(parent => stamp(parent.completedAt) !== null)
    ? Math.max(...parents.map(parent => stamp(parent.completedAt))) : null;
  const readyToStartSeconds = parentFinish !== null && stamp(job.startedAt) !== null &&
    stamp(job.startedAt) >= parentFinish ? round((stamp(job.startedAt)-parentFinish)/1000) : null;
  return {
    id: job.id, name: job.name, url: job.url ?? null,
    family: spec?.id ?? null, dependencies, observedDependencyReadyToStartSeconds: readyToStartSeconds,
    status: job.status ?? null, result: job.conclusion ?? null,
    runner: job.runner ?? null, runnerLabels: job.runnerLabels ?? [],
    createdAt: job.createdAt ?? null, startedAt: job.startedAt ?? null, completedAt: job.completedAt ?? null,
    queueSeconds: measured(job.queueSeconds), elapsedSeconds: measured(job.durationSeconds),
    secondsSinceWorkflowCreation: seconds(run.createdAt, job.completedAt),
    secondsBeforeLastRequiredLeaf: leafFinish ? seconds(job.completedAt, leafFinish) : null,
    onObservedBlockingChain: job.critical === true,
    stages: {
      beforeValidationSeconds: selected ? seconds(job.startedAt, selected.startedAt) : null,
      validationSeconds: selected?.elapsedSeconds ?? null,
      afterValidationSeconds: selected ? seconds(selected.completedAt, job.completedAt) : null,
      containerInitializationSeconds: container?.elapsedSeconds ?? null,
      stepSecondsByPhase: Object.fromEntries(phases.map(name => [name,
        total(complete.filter(step => step.phase === name).map(step => step.elapsedSeconds))])),
      measuredSteps: complete.length, missingStepTimings: steps.length - complete.length,
    },
    steps,
  };
}
function runReport(run, graph) {
  const last = run.bottleneck?.available ? run.jobs.find(job =>
    job.name === run.bottleneck.leafName) : null;
  const jobs = run.jobs.map(job => jobReport(job, run, graph, last?.completedAt ?? null));
  const sortedJobs = [...jobs].filter(job => job.elapsedSeconds !== null)
    .sort((a,b) => b.elapsedSeconds - a.elapsedSeconds);
  const observedSteps = jobs.flatMap(job => job.steps.filter(step =>
    step.elapsedSeconds !== null).map(step => ({
      job: job.name, name: step.name, phase: step.phase, seconds: step.elapsedSeconds,
    })));
  return {
    id: run.id, url: run.url, workflowId: run.workflowId ?? null,
    name: run.name, event: run.event ?? null, executedSha: run.sha,
    attempt: run.attempt, status: run.status, result: run.conclusion,
    createdAt: run.createdAt, startedAt: run.startedAt, completedAt: run.completedAt,
    timing: run.timing, observedBlockingChain: run.chain ?? null,
    observedLastLeaf: run.bottleneck ?? null,
    aggregate: {
      statusCounts: counts(jobs.map(job => job.result ?? job.status)),
      jobDurations: distribution(jobs.map(job => job.elapsedSeconds)),
      jobQueue: distribution(jobs.map(job => job.queueSeconds)),
      totalMeasuredRunnerSeconds: total(jobs.map(job => job.elapsedSeconds).filter(n => n !== null)),
      longestJobs: sortedJobs.slice(0,15).map(job => ({
        name: job.name, elapsedSeconds: job.elapsedSeconds, queueSeconds: job.queueSeconds,
        secondsBeforeLastRequiredLeaf: job.secondsBeforeLastRequiredLeaf,
        onObservedBlockingChain: job.onObservedBlockingChain,
      })),
      longestSteps: observedSteps.sort((a,b) => b.seconds - a.seconds).slice(0,30),
      phaseStepRunnerSeconds: Object.fromEntries(phases.map(name => [name, total(jobs.map(
        job => job.stages.stepSecondsByPhase[name]))])),
      measuredStepCount: observedSteps.length,
      missingStepTimings: jobs.reduce((sum, job) => sum + job.stages.missingStepTimings, 0),
    },
    jobs,
  };
}
function cohort(selected, history) {
  const signature = signatureOf(verifyOf(selected));
  const successful = history.map(pr => ({ pr, verify: eligibleVerify(pr) }))
    .filter(item => item.verify !== null);
  const sameShape = successful.filter(item => signatureOf(item.verify) === signature);
  const byJob = new Map();
  for (const {verify} of sameShape) for (const job of verify.jobs) {
    if (job.conclusion !== 'success') continue;
    if (!byJob.has(job.name)) byJob.set(job.name, []);
    byJob.get(job.name).push(job.durationSeconds);
  }
  return {
    basis: 'Same observed executed job-name set, successful first attempt, complete untruncated PR window. Task input, runner image and cache are NOT proven equivalent.',
    selectedJobShape: signature, successfulCandidateCount: successful.length,
    matchingCount: sameShape.length,
    runs: sameShape.map(({pr,verify}) => ({
      pr: pr.number, executedSha: pr.sha, runId: verify.id, createdAt: verify.createdAt,
      certificationSeconds: measured(verify.timing.certificationSeconds),
      runnerSeconds: measured(verify.timing.runnerSeconds),
      queueSeconds: measured(verify.timing.queueSeconds),
      lastRequiredLeaf: verify.bottleneck?.available ? verify.bottleneck.leafName : null,
      nextLeafGapSeconds: verify.bottleneck?.available ? verify.bottleneck.runnerUpGapSeconds : null,
    })),
    certification: distribution(sameShape.map(({verify}) => verify.timing.certificationSeconds)),
    runner: distribution(sameShape.map(({verify}) => verify.timing.runnerSeconds)),
    queue: distribution(sameShape.map(({verify}) => verify.timing.queueSeconds)),
    jobDurations: [...byJob.entries()].map(([name,durations]) => ({
      name, ...distribution(durations),
    })).sort((a,b) => (b.p90Seconds ?? -1) - (a.p90Seconds ?? -1)),
    lastRequiredLeafCounts: counts(sameShape.map(({verify}) =>
      verify.bottleneck?.available ? verify.bottleneck.leafName : 'unavailable')),
  };
}
/** Produce exactly one source-bound diagnostic document, without extra API calls. */
export function buildDiagnosticExport(selected, history, coverage, workflowSource) {
  if (!selected || !Number.isSafeInteger(selected.number) || !/^[a-f0-9]{40}$/iu.test(selected.sha ?? '') ||
      !Array.isArray(selected.runs) || !Array.isArray(history)) throw new Error('Invalid PR revision');
  let graph = [], graphError = null;
  try { graph = readVerifyGraph(workflowSource ?? ''); }
  catch (error) { graphError = error instanceof Error ? error.message : 'Unavailable'; }
  const workflows = selected.runs.map(run => runReport(run, graph));
  const verify = verifyOf(selected);
  return {
    schema: DIAGNOSTIC_SCHEMA,
    origin: {
      repository: 'yohn-jp/codexia', dataSource: 'GitHub public Actions run/job/step REST metadata',
      pr: selected.number, executedSha: selected.sha, observedAt: coverage?.observedAt ?? null,
      workflowGraph: graphError === null ? 'published Verify workflow snapshot' : null, graphError,
      bounds: { scannedRuns: coverage?.scannedRuns ?? null,
        selectedRuns: coverage?.selectedRuns ?? null, scannedPages: coverage?.scannedPages ?? null,
        selectedPRs: coverage?.selectedPRs ?? history.length,
        unresolvedRunCount: coverage?.unresolvedRunCount ?? null,
        historyTruncated: coverage?.historyTruncated ?? null,
        selectedPRTruncated: selected.sampleTruncated === true, note: coverage?.note ?? null },
    },
    selectedRevision: {
      pr: selected.number, sha: selected.sha, createdAt: selected.createdAt,
      sampleComplete: selected.complete === true, observedWindowSeconds: measured(selected.elapsedSeconds),
      observedRunnerSeconds: measured(selected.runnerSeconds), verifyRunId: selected.verifyId ?? null,
      workflowCount: workflows.length, jobCount: workflows.reduce((sum,run) => sum+run.jobs.length,0),
      workflowResults: counts(workflows.map(run => run.result ?? run.status)),
    },
    selectedVerify: verify ? {
      id: verify.id, url: verify.url, attempt: verify.attempt, result: verify.conclusion,
      elapsedToCertificationSeconds: measured(verify.timing.certificationSeconds),
      observedBlockingChain: verify.chain, observedLastLeaf: verify.bottleneck,
    } : null,
    comparableJobShapeHistory: cohort(selected, history),
    workflows,
    interpretation: {
      timing: 'Runner time and per-phase sums include parallel work. No single-job duration equals a counterfactual CI speedup.',
      chain: 'Latest observed dependency finishing order, not counterfactual critical path.',
      notMeasured: {
        taskDurations: 'Per-task and Playwright-spec durations are inside existing job logs and ci-evidence report.json artifacts, not the public step metadata.',
        resource: 'CPU pressure (PSI), CPU utilization, RAM, I/O and CPU throttling are not available from the public Actions metadata.',
        purePull: 'Initialize containers is not download-only elapsed time.',
        cacheHit: 'Step durations alone do not prove cache hit/miss.',
        billedTime: 'Summed runner execution seconds are not billable minutes.',
        gates: 'Sampled workflows are not necessarily all required checks or merge protection.',
        controlledAB: 'Equal executed job names do not prove the same selected tasks, cache, runner class or toolchain.',
      },
    },
  };
}
