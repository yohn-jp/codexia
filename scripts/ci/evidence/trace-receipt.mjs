import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';
import { resolveProducerJobAttempts, selectLatestJobArtifact } from './artifact-selection.mjs';
import { assertTraceArtifact, downloadArtifact, readBrowserArtifact, readTraceArtifact } from './download-artifacts.mjs';
import { BROWSER_SHARDS, VERIFICATION_GROUPS } from '../impact/contract.mjs';
import { summarizeBrowserCoverage } from '../browser/shards.mjs';

const workflow = '.github/workflows/verify.yml';
const producerName = 'types-trace';
const artifactName = 'ci-evidence-types-trace';
const task = 'requirements-trace';

function latestTraceVerifyRun(runs, { sourceSha, repositoryId, event }) {
  const matches = runs.filter(run => run.event === event && run.path === workflow && run.head_sha === sourceSha &&
    run.repository?.id === repositoryId && run.head_repository?.id === repositoryId &&
    (event === 'pull_request' || run.head_branch === 'main'));
  const newest = matches.toSorted((a, b) => b.run_number - a.run_number)[0];
  if (!newest) return null;
  assert.ok(Number.isSafeInteger(newest.id) && newest.id > 0 && Number.isSafeInteger(newest.run_number) &&
    newest.run_number > 0 && Number.isSafeInteger(newest.run_attempt) && newest.run_attempt > 0,
  'Invalid Verify run identity');
  assert.equal(matches.filter(run => run.run_number === newest.run_number).length, 1, 'Ambiguous Verify run identity');
  return newest;
}

export function selectTraceVerifyRun(runs, expected) {
  const newest = latestTraceVerifyRun(runs, expected);
  return newest?.status === 'completed' && newest.conclusion === 'success' ? newest : null;
}

export async function waitForTraceVerifyRun(readRuns, expected, { waitSeconds = 0, pause = delay } = {}) {
  assert.ok(Number.isSafeInteger(waitSeconds) && waitSeconds >= 0 && waitSeconds <= 600, 'Invalid Verify observation timeout');
  const deadline = performance.now() + waitSeconds * 1000;
  do {
    const newest = latestTraceVerifyRun(await readRuns(), expected);
    if (newest?.status === 'completed') return newest.conclusion === 'success' ? newest : null;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    await pause(Math.min(15_000, remaining));
  } while (performance.now() < deadline);
  return null;
}

function assertTraceCertification(certification, run) {
  assert.ok(certification?.name === 'certification' && certification.head_sha === run.head_sha &&
    certification.run_id === run.id && certification.run_attempt === run.run_attempt &&
    certification.status === 'completed' && certification.conclusion === 'success' &&
    certification.steps?.some(step => step.name === 'Certify every required exact-source matrix element' &&
      step.status === 'completed' && step.conclusion === 'success'),
  'Verify did not certify the current exact-source matrix');
}

function assertArtifactRepository(artifact, repositoryId) {
  assert.equal(artifact.workflow_run?.repository_id, repositoryId, 'Trace artifact repository mismatch');
  assert.equal(artifact.workflow_run?.head_repository_id, repositoryId, 'Trace artifact source repository mismatch');
}

export function summarizeCertifiedTrace({ expected, run, certification, producer, selected, group, trace }) {
  assert.equal(selectTraceVerifyRun([run], expected), run, 'Verify run source mismatch');
  assertTraceCertification(certification, run);
  assertArtifactRepository(selected, expected.repositoryId);
  assert.equal(group.workflowAttempt, producer.run_attempt, 'Wrong trace producer attempt');
  assert.deepEqual(group.results?.map(({ task, status }) => ({ task, status })), [{ task, status: 'passed' }],
    'Verify did not execute the trace task successfully');
  const { sourceSha, repository } = expected;
  const runId = String(run.id);
  assert.equal(String(selected.workflow_run.id), runId, 'Trace artifact belongs to another run');
  assert.equal(selected.workflow_run.head_sha, sourceSha, 'Trace artifact source SHA mismatch');
  assertTraceArtifact(trace, group, { sourceSha, runId }, repository);
  assert.ok(Number.isSafeInteger(selected.id) && selected.id > 0, 'Invalid trace artifact ID');
  assert.match(selected.digest, /^sha256:[a-f0-9]{64}$/u, 'Invalid trace artifact digest');
  const passedCaseIds = trace.caseExecutions.filter(item => item.result === 'PASSED').map(item => item.testId).sort();
  assert.ok(passedCaseIds.every(id => /^TEST-(?:[A-Z0-9]+-)+\d{3}$/u.test(id)), 'Invalid certified case identifier');
  return {
    status: 'CERTIFIED', sourceSha, repository, runId, attempt: producer.run_attempt, job: group.workflowJob, task,
    runUrl: trace.execution.runUrl, artifactId: selected.id, artifactDigest: selected.digest, passedCaseIds,
  };
}

export function summarizeCertifiedBrowser({ expected, run, certification, producer, selected, group, reports, cases }) {
  assert.equal(selectTraceVerifyRun([run], expected), run, 'Verify run source mismatch');
  assertTraceCertification(certification, run);
  assertArtifactRepository(selected, expected.repositoryId);
  assert.equal(selected.workflow_run.id, run.id, 'Browser artifact belongs to another run');
  assert.equal(selected.workflow_run.head_sha, expected.sourceSha, 'Browser artifact source mismatch');
  assert.ok(Number.isSafeInteger(selected.id) && selected.id > 0, 'Invalid browser artifact ID');
  assert.match(selected.digest, /^sha256:[a-f0-9]{64}$/u, 'Invalid browser artifact digest');
  assert.equal(group.group, producer.name, 'Browser evidence group mismatch');
  assert.equal(group.workflowJob, 'browser', 'Unexpected browser workflow job');
  assert.equal(group.workflowAttempt, producer.run_attempt, 'Wrong browser producer attempt');
  assert.equal(group.workflowRunId, run.id, 'Browser evidence run mismatch');
  assert.equal(group.sha, expected.sourceSha, 'Browser evidence source mismatch');
  const allowed = VERIFICATION_GROUPS[group.group] ?? [];
  return reports.flatMap(report => {
    assert.equal(report.sourceSha, expected.sourceSha, 'Browser coverage source mismatch');
    assert.equal(report.schemaVersion, 1, 'Unknown browser coverage schema');
    const task = `browser-${report.profile}-${report.shard}`;
    assert.ok(allowed.includes(task) && group.results.some(item => item.task === task && item.status === 'passed'),
      'Browser coverage did not come from an executed browser task');
    const shard = BROWSER_SHARDS.find(item => item.id === report.shard);
    assert.equal(report.project, shard.project, 'Browser coverage project mismatch');
    assert.equal(report.file, shard.file, 'Browser coverage file mismatch');
    assert.equal(report.outcome, 'PASS', 'Browser coverage did not pass');
    assert.equal(report.runStatus, 'passed', 'Browser run did not pass');
    const observations = report.tests;
    const counts = summarizeBrowserCoverage({ expected: report.expected, outcomes: observations.map(item => item.outcome) });
    for (const [key, value] of Object.entries(counts)) assert.equal(report[key], value, `Browser coverage ${key} count mismatch`);
    assert.ok(counts.failed === 0 && counts.executed > 0, 'Browser coverage lacks a successful execution');
    const file = `tests/e2e/${shard.file}`;
    assert.ok(observations.every(item => item.file === file), 'Browser observations include a foreign file');
    const passedCaseIds = cases.filter(item => {
      const source = item.sourceRefs?.[0];
      if (item.result !== 'NOT_RUN' || source?.path !== file || !Number.isInteger(source.line) || !item.name) return false;
      const matches = observations.filter(observation => observation.line === source.line &&
        (observation.title === item.name || observation.title?.endsWith(` › ${item.name}`)));
      return matches.length === 1 && matches[0].outcome === 'expected' &&
        matches[0].attempts?.length === 1 && matches[0].attempts[0].status === 'passed';
    }).map(item => item.testId).sort();
    return passedCaseIds.length ? [{
      job: producer.name, task, profile: report.profile, project: report.project, attempt: producer.run_attempt,
      artifactId: selected.id, artifactDigest: selected.digest, passedCaseIds,
    }] : [];
  });
}

async function readReceipt(expected, token, waitSeconds) {
  const { repository, repositoryId, sourceSha, event } = expected;
  const github = createGitHubOctokit({ token });
  const [owner, repo] = repository.split('/');
  const target = { owner, repo };
  const actions = github.rest.actions;
  const readRuns = () => paginateActionsInventory(github, actions.listWorkflowRuns,
    { ...target, workflow_id: 'verify.yml', head_sha: sourceSha, event }, 'workflow_runs');
  const run = await waitForTraceVerifyRun(readRuns, expected, { waitSeconds });
  if (!run) return { status: 'NOT_AVAILABLE', sourceSha };
  const args = { ...target, run_id: run.id };
  const [latestJobs, artifacts] = await Promise.all([
    paginateActionsInventory(github, actions.listJobsForWorkflowRun, { ...args, filter: 'latest' }, 'jobs'),
    paginateActionsInventory(github, actions.listWorkflowRunArtifacts, args, 'artifacts'),
  ]);
  const certifications = latestJobs.filter(job => job.name === 'certification');
  assert.equal(certifications.length, 1, 'Expected one Verify certification job');
  const [certification] = certifications;
  assertTraceCertification(certification, run);
  const browserNames = Object.keys(VERIFICATION_GROUPS).filter(name => name.startsWith('browser-'));
  const jobs = await resolveProducerJobAttempts(latestJobs, run,
    (runId, attempt) => paginateActionsInventory(github, actions.listJobsForWorkflowRunAttempt,
      { ...target, run_id: runId, attempt_number: attempt }, 'jobs'), [producerName, ...browserNames]);
  const identity = { runId: String(run.id), sourceSha };
  const selected = selectLatestJobArtifact(artifactName, producerName, artifacts, jobs, identity);
  assertArtifactRepository(selected, repositoryId);
  const { group, trace } = await readTraceArtifact(await downloadArtifact(selected, repository, token));
  const receipt = summarizeCertifiedTrace({ expected, run, certification, producer: jobs.find(job => job.name === producerName),
    selected, group, trace });
  const productBrowser = await Promise.all(jobs.filter(job => browserNames.includes(job.name) && job.conclusion === 'success').map(async producer => {
    try {
      const artifact = selectLatestJobArtifact(`ci-evidence-${producer.name}`, producer.name, artifacts, jobs, identity);
      assertArtifactRepository(artifact, repositoryId);
      const { group: browserGroup, reports } = await readBrowserArtifact(
        await downloadArtifact(artifact, repository, token), producer.name);
      return summarizeCertifiedBrowser({ expected, run, certification, producer, selected: artifact, group: browserGroup, reports, cases: trace.caseExecutions });
    } catch (error) {
      console.error(`Browser case evidence unavailable for ${producer.name}:`, error.message);
      return [];
    }
  }));
  return { ...receipt, productBrowser: productBrowser.flat() };
}

async function main() {
  const [sourceSha, event, output, ...extra] = process.argv.slice(2);
  const { GH_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: id } = process.env;
  const repositoryId = Number(id);
  const waitSeconds = Number(process.env.CODEXIA_TRACE_VERIFY_WAIT_SECONDS ?? 0);
  assert.match(sourceSha ?? '', /^[a-f0-9]{40}$/u);
  assert.ok(['push', 'pull_request', 'workflow_dispatch'].includes(event) && output && extra.length === 0,
    'Usage: trace-receipt.mjs SHA EVENT OUTPUT');
  assert.equal(repository, 'yohn-jp/codexia');
  assert.ok(Number.isSafeInteger(repositoryId) && repositoryId > 0, 'Missing repository ID');
  assert.ok(token, 'GitHub Actions read token is required');
  const receipt = await readReceipt({ sourceSha, event, repository, repositoryId }, token, waitSeconds).catch(error => {
    console.error('Verify trace artifact was not authenticated:', error.message);
    return { status: 'NOT_AVAILABLE', sourceSha };
  });
  await writeFile(output, JSON.stringify(receipt) + '\n', { flag: 'wx' });
  console.log(receipt.status === 'CERTIFIED'
    ? `Verify trace receipt certified: run ${receipt.runId}, producer attempt ${receipt.attempt}, artifact ${receipt.artifactId}, ${receipt.passedCaseIds.length} passing trace cases, ${receipt.productBrowser.reduce((total, browser) => total + browser.passedCaseIds.length, 0)} passing browser case observations.`
    : 'No certified Verify trace receipt is available for this source.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
