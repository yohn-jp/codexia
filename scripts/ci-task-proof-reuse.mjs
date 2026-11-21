import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { assertPlanEvidence } from './ci-evidence.mjs';
import { selectLatestEvidenceArtifacts, selectLatestJobArtifact, selectLatestPlanArtifact } from './ci-artifact-selection.mjs';
import { downloadArtifact, extractJsonEntry, selectedArtifacts } from './download-ci-artifacts.mjs';
import { collectGitHubPages } from './release-policy.mjs';
import { assertTaskProducerInventory, assertTrustedTaskInputProof, selectEquivalentTaskProofs } from './ci-task-input-proof.mjs';
import { planDigest, validateVerificationPlan } from './ci-impact.mjs';
import { VERIFICATION_TASKS } from './ci-contract.mjs';
import { captureCoverageInputClosure, coverageInvocation } from './ci-coverage-inputs.mjs';
import { verifyReusableMainProof } from './reuse-pr-verification.mjs';
import { assertTrustedCertifiedSourceTaskInputProof } from './ci-task-input-proof.mjs';

const VERIFY_PATH = '.github/workflows/verify.yml';
const COVERAGE_JOB = 'types-tests';
const COVERAGE_WORKFLOW_JOB = 'types';
const COVERAGE_ARTIFACT = 'ci-evidence-types-tests';
const CERTIFICATION_STEP = 'Certify every required exact-source matrix element';
const COMPACT_CERTIFICATION_STEP = 'Certify reused merged PR proof';

const positive = value => Number.isSafeInteger(value) && value > 0;

function exactJob(jobs, name, run) {
  const matches = jobs.filter(job => job?.name === name);
  assert.equal(matches.length, 1, `Missing or duplicate exact-main job ${name}`);
  const job = matches[0];
  assert.equal(job.head_sha, run.head_sha, `Task proof job source mismatch: ${name}`);
  assert.equal(String(job.run_id), String(run.id), `Task proof job run mismatch: ${name}`);
  assert.equal(job.run_attempt, run.run_attempt, `Task proof job attempt mismatch: ${name}`);
  assert.equal(job.status, 'completed', `Task proof job is unfinished: ${name}`);
  assert.equal(job.conclusion, 'success', `Task proof job failed: ${name}`);
  return job;
}

function assertCertifiedMainRun(run, jobs, current, baseSha) {
  assert.ok(positive(run.id) && positive(run.run_number) && positive(run.run_attempt), 'Invalid exact-main run identity');
  assert.equal(run.workflow_id, current.workflow_id, 'Task proof workflow mismatch');
  assert.equal(run.path, VERIFY_PATH, 'Task proof workflow path mismatch');
  assert.equal(run.repository?.id, current.repository?.id, 'Task proof repository mismatch');
  assert.equal(run.head_repository?.id, current.repository?.id, 'Task proof producer is from a foreign repository');
  assert.equal(run.head_sha, baseSha, 'Task proof source is not the exact PR base');
  assert.equal(run.event, 'push', 'Task proof producer is not a main push');
  assert.equal(run.head_branch, 'main', 'Task proof producer branch mismatch');
  assert.equal(run.status, 'completed', 'Task proof main run is unfinished');
  assert.equal(run.conclusion, 'success', 'Task proof main run did not succeed');

  const certification = exactJob(jobs, 'certification', run);
  assert.ok(Array.isArray(certification.steps), 'Main certification step inventory missing');
  const steps = certification.steps.filter(step => step.name === CERTIFICATION_STEP);
  assert.equal(steps.length, 1, 'Missing or duplicate exact-main certification step');
  assert.equal(steps[0].conclusion, 'success', 'Exact-main task evidence was not certified');
  return exactJob(jobs, COVERAGE_JOB, run);
}

async function resolveCompactMainCoverageProof({ plan, run, jobs, current, repository, token, request, read }) {
  const certJob = exactJob(jobs, 'certification', run);
  const certSteps = certJob.steps?.filter(step => step.name === COMPACT_CERTIFICATION_STEP) ?? [];
  assert.equal(certSteps.length, 1, 'Missing or duplicate compact exact-main certification step');
  assert.equal(certSteps[0].conclusion, 'success', 'Compact exact-main certification failed');
  const before = execFileSync('git', ['rev-parse', `${plan.base}^1`], { encoding: 'utf8' }).trim();
  const githubRequest = async endpoint => request(`https://api.github.com/repos/${repository}/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  const mainProof = await verifyReusableMainProof({ sourceSha: plan.base, before, repository, currentRun: run,
    git: args => execFileSync('git', args, { encoding: 'utf8' }),
    request: async endpoint => {
      const response = await githubRequest(endpoint);
      assert.ok(response.ok, `Merged PR proof lookup failed: HTTP ${response.status}`);
      return response.json();
    },
    readArtifact: async (artifact, filename) => JSON.parse(await extractJsonEntry(await downloadArtifact(artifact, repository, token, request), filename)),
  });
  const sourceRun = await getJson(githubRequest, `actions/runs/${mainProof.runId}`);
  const sourceJobs = await collectGitHubPages((page, perPage) => getJson(githubRequest,
    `actions/runs/${mainProof.runId}/jobs?filter=latest&per_page=${perPage}&page=${page}`), 'jobs');
  const sourceCoverageJob = sourceJobs.filter(job => job.name === COVERAGE_JOB);
  assert.equal(sourceCoverageJob.length, 1, 'Merged PR proof has no unique coverage producer job');
  const sourceJob = sourceCoverageJob[0];
  const sourceArtifacts = await collectGitHubPages((page, perPage) => getJson(githubRequest,
    `actions/runs/${mainProof.runId}/artifacts?per_page=${perPage}&page=${page}`), 'artifacts');
  const sourcePlanArtifact = sourceArtifacts.find(item => item.id === mainProof.planArtifact.id);
  assert.ok(sourcePlanArtifact, 'Certified PR plan artifact is missing');
  const sourcePlan = validateVerificationPlan(await read(sourcePlanArtifact, 'ci-plan.json'));
  assert.equal(planDigest(sourcePlan), mainProof.planDigest, 'Certified PR plan digest changed');
  const sourceEvidence = mainProof.evidence.map(ref => {
    const artifact = sourceArtifacts.find(item => item.id === ref.id);
    assert.ok(artifact && artifact.digest === ref.digest, 'Certified PR evidence artifact changed');
    return artifact;
  });
  const sourceReports = await Promise.all(sourceEvidence.map(item => read(item, 'report.json')));
  assertPlanEvidence(sourcePlan, sourceJobs, sourceReports);
  const report = sourceReports.find(item => item.group === COVERAGE_JOB);
  assert.ok(report, 'Certified PR coverage report is missing');
  assertTaskProducerInventory({ plan: sourcePlan, report, inventory: report.producerInventory });
  const result = report.results.find(item => item.task === 'coverage');
  assert.equal(result?.status, 'passed', 'Certified PR coverage task did not pass');
  const proof = result.inputProof;
  const artifact = sourceEvidence.find(item => item.name === COVERAGE_ARTIFACT);
  assert.ok(artifact, 'Certified PR task proof artifact is missing');
  const mainCertification = { workflowRunId: run.id, workflowAttempt: run.run_attempt, workflowId: run.workflow_id,
    repositoryId: run.repository.id, sourceSha: plan.base, jobId: certJob.id, step: COMPACT_CERTIFICATION_STEP };
  assertTrustedCertifiedSourceTaskInputProof({ inputProof: proof,
    identity: { sourceSha: mainProof.headSha, planDigest: mainProof.planDigest,
      workflowRunId: sourceRun.id, workflowAttempt: sourceRun.run_attempt },
    sourceRun, job: sourceJob, artifact, mainRun: run, certificationJob: certJob,
    certificationStep: certSteps[0], certification: mainCertification,
    expected: { repositoryId: current.repository.id, workflowId: current.workflow_id, jobId: sourceJob.id,
      jobName: COVERAGE_JOB, workflowJob: COVERAGE_WORKFLOW_JOB, artifactId: artifact.id, artifactName: COVERAGE_ARTIFACT, artifactDigest: artifact.digest },
  });
  return { task: 'coverage', sourceSha: plan.base, proofSourceSha: mainProof.headSha,
    planDigest: proof.planDigest, workflowRunId: sourceRun.id, workflowAttempt: sourceRun.run_attempt,
    workflowId: sourceRun.workflow_id, repositoryId: sourceRun.repository.id, jobId: sourceJob.id,
    workflowJob: proof.workflowJob, artifactId: artifact.id, artifactName: artifact.name, artifactDigest: artifact.digest,
    inputClosure: proof.inputClosure, runtime: proof.runtime, certification: mainCertification };
}

async function getJson(request, endpoint) {
  const response = await request(endpoint);
  assert.ok(response.ok, `GitHub task proof lookup failed: HTTP ${response.status}`);
  return response.json();
}

/** Resolve coverage input evidence only from the latest successful full exact-base main run. */
export async function resolveExactMainCoverageProof({ plan: planValue, current, repository, token, request = fetch, readArtifact }) {
  const plan = validateVerificationPlan(planValue);
  assert.equal(plan.event, 'pull_request', 'Task proof reuse is only available to pull requests');
  assert.match(plan.base ?? '', /^[a-f0-9]{40}$/u, 'Task proof reuse requires an exact PR base');
  assert.ok(plan.tasks.includes('coverage'), 'Coverage task is not selected');
  assert.ok(typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/u.test(repository), 'Invalid proof repository');
  assert.ok(typeof token === 'string' && token.length > 0, 'GitHub read token is required');
  assert.equal(current?.path, VERIFY_PATH, 'Current workflow path mismatch');
  assert.equal(current?.event, 'pull_request', 'Current run is not a pull request');
  assert.equal(current?.head_sha, plan.sha, 'Current run source mismatch');
  assert.ok(positive(current?.workflow_id) && positive(current?.repository?.id), 'Current workflow identity is incomplete');

  const get = async endpoint => {
    const response = await request(`https://api.github.com/repos/${repository}/${endpoint}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    assert.ok(response.ok, `GitHub task proof lookup failed: HTTP ${response.status}`);
    return response.json();
  };
  const workflow = await get('actions/workflows/verify.yml');
  assert.equal(workflow.id, current.workflow_id, 'Current run uses another workflow');
  assert.equal(workflow.path, VERIFY_PATH, 'Current workflow path changed');
  const runs = await collectGitHubPages((page, perPage) => get(
    `actions/workflows/${workflow.id}/runs?head_sha=${plan.base}&event=push&per_page=${perPage}&page=${page}`), 'workflow_runs');
  const exactRuns = runs.filter(run => run?.workflow_id === current.workflow_id && run.path === VERIFY_PATH &&
    run.event === 'push' && run.head_branch === 'main' && run.head_sha === plan.base &&
    run.repository?.id === current.repository.id && run.head_repository?.id === current.repository.id);
  assert.ok(exactRuns.length > 0, 'No exact-base main verification run');
  const runNumbers = new Set();
  for (const run of exactRuns) {
    assert.ok(positive(run.run_number) && !runNumbers.has(run.run_number), 'Ambiguous exact-base main run inventory');
    runNumbers.add(run.run_number);
  }
  const run = [...exactRuns].sort((left, right) => right.run_number - left.run_number)[0];
  // Never fall back to an older run or attempt when the newest exact-base proof failed.
  assert.equal(run.status, 'completed', 'Latest exact-base main run is unfinished');
  assert.equal(run.conclusion, 'success', 'Latest exact-base main run failed');
  const jobs = await collectGitHubPages((page, perPage) => get(
    `actions/runs/${run.id}/jobs?filter=latest&per_page=${perPage}&page=${page}`), 'jobs');
  const read = readArtifact ?? (async (artifact, filename) => JSON.parse(await extractJsonEntry(
    await downloadArtifact(artifact, repository, token, request), filename)));
  const certificationJob = exactJob(jobs, 'certification', run);
  if (certificationJob.steps?.some(step => step.name === COMPACT_CERTIFICATION_STEP && step.conclusion === 'success')) {
    return resolveCompactMainCoverageProof({ plan, run, jobs, current, repository, token, request, read });
  }
  const coverageJob = assertCertifiedMainRun(run, jobs, current, plan.base);
  const fullCertification = exactJob(jobs, 'certification', run);
  const fullStep = fullCertification.steps.find(step => step.name === CERTIFICATION_STEP);
  const artifacts = await collectGitHubPages((page, perPage) => get(
    `actions/runs/${run.id}/artifacts?per_page=${perPage}&page=${page}`), 'artifacts');
  const identity = { runId: run.id, sourceSha: plan.base };
  const planArtifact = selectLatestPlanArtifact(artifacts, jobs, identity);
  const selectedPlanArtifact = selectedArtifacts({ identity, artifacts }, [planArtifact.id], identity, 'plan')[0];
  const mainPlan = validateVerificationPlan(await read(selectedPlanArtifact, 'ci-plan.json'));
  assert.equal(mainPlan.event, 'push');
  assert.equal(mainPlan.mode, 'full', 'Partial main plans cannot authorize task proof reuse');
  assert.deepEqual(mainPlan.tasks, VERIFICATION_TASKS, 'Main task proof does not cover the complete verification inventory');
  const evidenceArtifacts = selectLatestEvidenceArtifacts(mainPlan, artifacts, jobs, identity);
  const selectedEvidence = selectedArtifacts({ identity, artifacts }, evidenceArtifacts.map(item => item.id), identity, 'evidence');
  const reports = await Promise.all(selectedEvidence.map(item => read(item, 'report.json')));
  assertPlanEvidence(mainPlan, jobs, reports);
  const coverageReport = reports.find(report => report.group === COVERAGE_JOB);
  assert.ok(coverageReport, 'Exact-main coverage report is missing');
  assertTaskProducerInventory({ plan: mainPlan, report: coverageReport, inventory: coverageReport.producerInventory });
  const proofEntry = coverageReport.results.find(result => result.task === 'coverage');
  assert.equal(proofEntry?.status, 'passed', 'Exact-main coverage task did not pass');
  const proof = proofEntry.inputProof;
  const artifact = evidenceArtifacts.find(item => item.name === COVERAGE_ARTIFACT);
  assert.ok(artifact, 'Exact-main coverage artifact is missing');
  assertTrustedTaskInputProof({ inputProof: proof,
    identity: { sourceSha: plan.base, planDigest: planDigest(mainPlan), workflowRunId: run.id, workflowAttempt: run.run_attempt },
    run, job: coverageJob, artifact,
    expected: { repositoryId: current.repository.id, workflowId: current.workflow_id, jobName: COVERAGE_JOB,
      workflowJob: COVERAGE_WORKFLOW_JOB,
      artifactName: COVERAGE_ARTIFACT, artifactId: artifact.id, artifactDigest: artifact.digest },
  });
  return {
    task: 'coverage', sourceSha: plan.base, proofSourceSha: plan.base, planDigest: proof.planDigest, workflowRunId: run.id,
    workflowAttempt: run.run_attempt, workflowId: run.workflow_id, repositoryId: run.repository.id,
    jobId: coverageJob.id, workflowJob: proof.workflowJob,
    artifactId: artifact.id, artifactName: artifact.name, artifactDigest: artifact.digest,
    inputClosure: proof.inputClosure, runtime: proof.runtime,
    certification: { workflowRunId: run.id, workflowAttempt: run.run_attempt, workflowId: run.workflow_id,
      repositoryId: run.repository.id, sourceSha: plan.base, jobId: fullCertification.id, step: fullStep.name },
  };
}

/** Re-resolve the exact-base proof and recompute the candidate closure in certification. */
export async function assertReusedCoverageProof({ plan: planValue, report, current, repository, token, request = fetch }) {
  const plan = validateVerificationPlan(planValue);
  assert.ok(report && typeof report === 'object', 'Missing task proof consumer report');
  assert.equal(report.group, COVERAGE_JOB, 'Task proof was consumed by an unexpected job');
  assertTaskProducerInventory({ plan, report, inventory: report.producerInventory });
  const result = report.results.find(item => item.task === 'coverage');
  assert.equal(result?.status, 'passed', 'Reused coverage result did not pass');
  const candidateProof = result.inputProof;
  assert.ok(candidateProof?.reusedFrom, 'Coverage result does not record task proof consumption');
  const trusted = await resolveExactMainCoverageProof({ plan, current, repository, token, request });
  assert.deepEqual(plan.taskInputReuse?.coverage, trusted, 'Plan task proof reference changed after selection');
  assert.deepEqual(candidateProof.reusedFrom, trusted, 'Consumed task proof identity changed');

  const runtime = candidateProof.runtime;
  assert.equal(runtime.cwd, process.cwd(), 'Candidate proof checkout path mismatch');
  assert.equal(runtime.platform, process.platform, 'Candidate proof platform mismatch');
  assert.equal(runtime.arch, process.arch, 'Candidate proof architecture mismatch');
  assert.equal(runtime.nodeVersion, report.producerInventory.runner.nodeVersion, 'Candidate proof Node version mismatch');
  assert.equal(runtime.imageOS, report.producerInventory.runner.imageOS, 'Candidate proof runner image mismatch');
  assert.equal(runtime.imageVersion, report.producerInventory.runner.imageVersion, 'Candidate proof runner image version mismatch');
  const candidateClosure = await captureCoverageInputClosure({ root: process.cwd(), runtime,
    invocation: coverageInvocation(runtime.execPath), workflowJob: COVERAGE_WORKFLOW_JOB });
  assert.deepEqual(candidateProof.inputClosure, candidateClosure, 'Candidate task input closure is not reproducible');

  const baselineProof = { ...trusted, sourceSha: trusted.proofSourceSha,
    format: 'codexia-ci-task-input-proof/v2', mode: 'static-coverage', status: 'passed' };
  assert.deepEqual(selectEquivalentTaskProofs({ tasks: ['coverage'], baseline: [baselineProof], candidate: [candidateProof],
    baselineIdentity: { sourceSha: trusted.proofSourceSha, planDigest: trusted.planDigest,
      workflowRunId: trusted.workflowRunId, workflowAttempt: trusted.workflowAttempt },
    candidateIdentity: { sourceSha: plan.sha, planDigest: planDigest(plan),
      workflowRunId: current.id, workflowAttempt: current.run_attempt },
  }), ['coverage'], 'Candidate and exact-base task inputs are not equivalent');
  return true;
}
