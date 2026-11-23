#!/usr/bin/env node
// Read-only observed timings. Unseparated legacy phases remain NOT_CHECKED.
import { collectGitHubPages } from '../../release/components/policy.mjs';
import { seconds, summarizeCiTiming } from './timing.mjs';
const args = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  if (!['--run', '--attempt'].includes(name) || !args[index + 1] || options.has(name)) {
    throw new Error('Usage: measure.mjs [--run <id>] [--attempt <number>]');
  }
  options.set(name, args[index + 1]);
}
const repository = process.env.GITHUB_REPOSITORY;
const runId = options.get('--run') ?? process.env.GITHUB_RUN_ID;
const attempt = options.get('--attempt');
if (args.includes('--attempt') && !/^[1-9]\d*$/.test(attempt ?? '')) throw new Error('Attempt must be a positive integer');
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^\d+$/.test(runId ?? '') || !process.env.GH_TOKEN) throw new Error('Repository, run and read token required');
const request = async endpoint => {
  const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Timing evidence unavailable (HTTP ${response.status})`);
  return response.json();
};
const runPath = `actions/runs/${runId}${attempt ? `/attempts/${attempt}` : ''}`;
const run = await request(runPath);
const jobs = await collectGitHubPages(page => request(`actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`), 'jobs');
const observations = jobs.map(job => {
  // The API may supply a non-null placeholder started_at even while still queued.
  const runnerAcquired = Object.hasOwn(job, 'runner_id') ?
    Number.isSafeInteger(job.runner_id) && job.runner_id > 0 : null;
  const runnerStartedAt = ['queued', 'waiting', 'pending', 'requested'].includes(job.status) || runnerAcquired === false
    ? null : job.started_at;
  const phase = pattern => (job.steps ?? []).filter(step => pattern.test(step.name)).map(step => ({ name: step.name, seconds: seconds(step.started_at, step.completed_at), result: step.conclusion }));
  return { name: job.name, sha: job.head_sha, status: job.status, result: job.conclusion, runnerAcquired, queueSeconds: seconds(job.created_at, runnerStartedAt),
    durationSeconds: seconds(runnerStartedAt, job.completed_at),
    runnerPreparation: phase(/Set up job|Initialize containers|setup-node/),
    dependencyInstall: phase(/Install frozen|Install exact|Prepare exact/),
    build: phase(/Build required|Build production|Build Core|Build native/),
    test: phase(/Test workspace|Test isolated|Typecheck|Verify native|Verify production OCI|Audit Core/),
    externalDownload: phase(/^(?:Initialize containers|Prepare exact|Install frozen|Restore content-addressed|Run actions\/setup-node)/),
    externalDownloadNote: 'Container pull and dependency retrieval are phase timings; download-only time is not exposed separately by Actions API.',
    cache: phase(/Restore content-addressed/),
    artifactPreparation: phase(/Pack immutable profile build|Seal verified native producer evidence/),
    artifactRestore: phase(/Restore exact profile producer|Restore exact native producer/),
    artifactTransfer: phase(/upload-artifact|download-artifact/), cacheHit: (job.steps ?? []).find(step => /^Dependency cache hit=/.test(step.name))?.name.split('=')[1] ?? 'NOT_CHECKED',
  };
});
const timing = summarizeCiTiming(run, jobs);
const report = { runId, createdAt: run.created_at, url: run.html_url, sha: run.head_sha, attempt: run.run_attempt, status: run.status, result: run.conclusion,
  ...timing,
  warmColdClassification: 'Use per-job cache results; a rerun is not automatically warm.',
  phaseMeasurementNote: 'Empty phase arrays mean not separately instrumented, not zero. Legacy source/browser steps combine phases; OCI combines image build and runtime checks; native verification includes Docker builds and compose. Download-related steps include other work and are not download-only stopwatch measurements.',
  jobs: observations };
console.log(JSON.stringify(report, null, 2));
