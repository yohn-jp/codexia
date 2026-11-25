#!/usr/bin/env node
// Read-only observed timings. Unseparated legacy phases remain NOT_CHECKED.
import { seconds, summarizeCiTiming } from './timing.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';
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
if (repository !== 'yohn-jp/codexia') throw new Error('Unexpected repository');
const github = createGitHubOctokit({ token: process.env.GH_TOKEN });
const [owner, repo] = repository.split('/');
const run = attempt
  ? (await github.rest.actions.getWorkflowRunAttempt({ owner, repo, run_id: Number(runId), attempt_number: Number(attempt) })).data
  : (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(runId) })).data;
const jobs = await paginateActionsInventory(github, github.rest.actions.listJobsForWorkflowRunAttempt,
  { owner, repo, run_id: Number(runId), attempt_number: run.run_attempt }, 'jobs');
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
