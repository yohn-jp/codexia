import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';
import { resolveProducerJobAttempts, selectLatestJobArtifact } from './artifact-selection.mjs';
import { assertTraceArtifact, downloadArtifact, readTraceArtifact } from './download-artifacts.mjs';

const workflow = '.github/workflows/verify.yml';
const producerName = 'types-trace';
const artifactName = 'ci-evidence-types-trace';
const task = 'requirements-trace';

export function selectTraceVerifyRun(runs, { sourceSha, repositoryId, event }) {
  const matches = runs.filter(run => run.event === event && run.path === workflow && run.head_sha === sourceSha &&
    run.repository?.id === repositoryId && run.head_repository?.id === repositoryId &&
    (event === 'pull_request' || run.head_branch === 'main'));
  const newest = matches.toSorted((a, b) => b.run_number - a.run_number)[0];
  if (!newest || newest.status !== 'completed' || newest.conclusion !== 'success') return null;
  assert.ok(Number.isSafeInteger(newest.id) && newest.id > 0 && Number.isSafeInteger(newest.run_number) &&
    newest.run_number > 0 && Number.isSafeInteger(newest.run_attempt) && newest.run_attempt > 0,
  'Invalid Verify run identity');
  assert.equal(matches.filter(run => run.run_number === newest.run_number).length, 1, 'Ambiguous Verify run identity');
  return newest;
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

async function readReceipt(expected, token) {
  const { repository, repositoryId, sourceSha, event } = expected;
  const github = createGitHubOctokit({ token });
  const [owner, repo] = repository.split('/');
  const target = { owner, repo };
  const actions = github.rest.actions;
  const runs = await paginateActionsInventory(github, actions.listWorkflowRuns,
    { ...target, workflow_id: 'verify.yml', head_sha: sourceSha, event }, 'workflow_runs');
  const run = selectTraceVerifyRun(runs, expected);
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
  const jobs = await resolveProducerJobAttempts(latestJobs, run,
    (runId, attempt) => paginateActionsInventory(github, actions.listJobsForWorkflowRunAttempt,
      { ...target, run_id: runId, attempt_number: attempt }, 'jobs'), [producerName]);
  const identity = { runId: String(run.id), sourceSha };
  const selected = selectLatestJobArtifact(artifactName, producerName, artifacts, jobs, identity);
  assertArtifactRepository(selected, repositoryId);
  const { group, trace } = await readTraceArtifact(await downloadArtifact(selected, repository, token));
  return summarizeCertifiedTrace({ expected, run, certification, producer: jobs.find(job => job.name === producerName),
    selected, group, trace });
}

async function main() {
  const [sourceSha, event, output, ...extra] = process.argv.slice(2);
  const { GH_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: id } = process.env;
  const repositoryId = Number(id);
  assert.match(sourceSha ?? '', /^[a-f0-9]{40}$/u);
  assert.ok(['push', 'pull_request', 'workflow_dispatch'].includes(event) && output && extra.length === 0,
    'Usage: trace-receipt.mjs SHA EVENT OUTPUT');
  assert.equal(repository, 'yohn-jp/codexia');
  assert.ok(Number.isSafeInteger(repositoryId) && repositoryId > 0, 'Missing repository ID');
  assert.ok(token, 'GitHub Actions read token is required');
  const receipt = await readReceipt({ sourceSha, event, repository, repositoryId }, token).catch(error => {
    console.error('Verify trace artifact was not authenticated:', error.message);
    return { status: 'NOT_AVAILABLE', sourceSha };
  });
  await writeFile(output, JSON.stringify(receipt) + '\n', { flag: 'wx' });
  console.log(receipt.status === 'CERTIFIED'
    ? `Verify trace receipt certified: run ${receipt.runId}, producer attempt ${receipt.attempt}, artifact ${receipt.artifactId}, ${receipt.passedCaseIds.length} passing cases.`
    : 'No certified Verify trace receipt is available for this source.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
