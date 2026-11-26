import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { assertPlanEvidence } from './validation.mjs';
import { selectLatestEvidenceArtifacts, selectLatestPlanArtifact } from './artifact-selection.mjs';
import { downloadArtifact, extractJsonEntry, selectedArtifacts } from './download-artifacts.mjs';
import { assertTaskProducerInventory, assertTrustedTaskInputProof, selectEquivalentTaskProofs } from './input-proof.mjs';
import { planDigest, validateVerificationPlan } from '../impact/plan.mjs';
import { captureCoverageInputClosure, coverageInvocation } from './coverage-inputs.mjs';
import { readReusableMainEvidence } from '../certification/reuse-merged-pr.mjs';
import { assertTrustedCertifiedSourceTaskInputProof } from './input-proof.mjs';
import { coverageRuntime } from './coverage-inputs.mjs';
import { createGitHubProofClient } from './proof-client.mjs';

const VERIFY_PATH = '.github/workflows/verify.yml';
const PROOF_REPOSITORY = 'yohn-jp/codexia';
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

async function resolveCompactMainCoverageProof({ plan, run, jobs, current, repository, token, request, read }) {
  const certJob = exactJob(jobs, 'certification', run);
  const certSteps = certJob.steps?.filter(step => step.name === COMPACT_CERTIFICATION_STEP) ?? [];
  assert.equal(certSteps.length, 1, 'Missing or duplicate compact exact-main certification step');
  assert.equal(certSteps[0].conclusion, 'success', 'Compact exact-main certification failed');
  const before = execFileSync('git', ['rev-parse', `${plan.base}^1`], { encoding: 'utf8' }).trim();
  const githubRequest = createGitHubProofClient({ repository, token, request });
  const { receipt: mainProof, plan: sourcePlan, reports: sourceReports } = await readReusableMainEvidence({
    sourceSha: plan.base, before, repository, currentRun: run,
    checkoutSha: plan.sha,
    git: args => execFileSync('git', args, { encoding: 'utf8' }),
    request: githubRequest.get,
    readArtifact: read,
  });
  const sourceRun = await githubRequest.get(`actions/runs/${mainProof.runId}`);
  const sourceJobs = await githubRequest.paginate(`actions/runs/${mainProof.runId}/jobs`, { filter: 'latest' }, 'jobs');
  const sourceCoverageJob = sourceJobs.filter(job => job.name === COVERAGE_JOB);
  assert.equal(sourceCoverageJob.length, 1, 'Merged PR proof has no unique coverage producer job');
  const sourceJob = sourceCoverageJob[0];
  const sourceArtifacts = await githubRequest.paginate(`actions/runs/${mainProof.runId}/artifacts`, {}, 'artifacts');
  // Recheck live identities against the evidence just verified. Immutable bytes only need to be read once.
  const identity = { runId: mainProof.runId, sourceSha: mainProof.headSha };
  const inventory = { identity, artifacts: sourceArtifacts };
  const [sourcePlanArtifact] = selectedArtifacts(inventory, [mainProof.planArtifact.id], identity, 'plan');
  assert.equal(sourcePlanArtifact.digest, mainProof.planArtifact.digest, 'Certified PR plan artifact changed');
  const sourceEvidence = selectedArtifacts(inventory, mainProof.evidence.map(ref => ref.id), identity, 'evidence');
  assert.deepEqual(sourceEvidence.map(({ id, digest }) => ({ id, digest })), mainProof.evidence,
    'Certified PR evidence artifact changed');
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
  const coverage = { task: 'coverage', sourceSha: plan.base, proofSourceSha: mainProof.headSha,
    planDigest: proof.planDigest, workflowRunId: sourceRun.id, workflowAttempt: sourceRun.run_attempt,
    workflowId: sourceRun.workflow_id, repositoryId: sourceRun.repository.id, jobId: sourceJob.id,
    workflowJob: proof.workflowJob, artifactId: artifact.id, artifactName: artifact.name, artifactDigest: artifact.digest,
    inputClosure: proof.inputClosure, runtime: proof.runtime, certification: mainCertification };
  return coverage;
}

/** Resolve optional static coverage reuse from an exact-base main certification. */
export async function resolveExactMainCoverageProof({ plan: planValue, current, repository, token, request = fetch, readArtifact }) {
  const plan = validateVerificationPlan(planValue);
  assert.equal(plan.event, 'pull_request', 'Task proof reuse is only available to pull requests');
  assert.match(plan.base ?? '', /^[a-f0-9]{40}$/u, 'Task proof reuse requires an exact PR base');
  assert.ok(plan.tasks.includes('coverage'), 'Coverage task is not selected');
  assert.equal(repository, PROOF_REPOSITORY, 'Task proof reuse is restricted to the canonical repository');
  assert.ok(typeof token === 'string' && token.length > 0, 'GitHub read token is required');
  assert.equal(current?.path, VERIFY_PATH, 'Current workflow path mismatch');
  assert.equal(current?.event, 'pull_request', 'Current run is not a pull request');
  assert.equal(current?.head_sha, plan.sha, 'Current run source mismatch');
  assert.ok(positive(current?.workflow_id) && positive(current?.repository?.id), 'Current workflow identity is incomplete');

  const github = createGitHubProofClient({ repository, token, request });
  const get = github.get;
  const workflow = await get('actions/workflows/verify.yml');
  assert.equal(workflow.id, current.workflow_id, 'Current run uses another workflow');
  assert.equal(workflow.path, VERIFY_PATH, 'Current workflow path changed');
  const runs = await github.paginate(`actions/workflows/${workflow.id}/runs`, { head_sha: plan.base, event: 'push' }, 'workflow_runs');
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
  assert.ok(positive(run.id) && positive(run.run_attempt), 'Invalid exact-main run identity');
  // Never fall back to an older run or attempt when the newest exact-base proof failed.
  assert.equal(run.status, 'completed', 'Latest exact-base main run is unfinished');
  assert.equal(run.conclusion, 'success', 'Latest exact-base main run failed');
  const jobs = await github.paginate(`actions/runs/${run.id}/jobs`, { filter: 'latest' }, 'jobs');
  const read = readArtifact ?? (async (artifact, filename) => JSON.parse(await extractJsonEntry(
    await downloadArtifact(artifact, repository, token, request), filename)));
  const certificationJob = exactJob(jobs, 'certification', run);
  if (certificationJob.steps?.some(step => step.name === COMPACT_CERTIFICATION_STEP && step.conclusion === 'success')) {
    return resolveCompactMainCoverageProof({ plan, run, jobs, current, repository, token, request, read });
  }
  const fullCertificationSteps = certificationJob.steps?.filter(step => step.name === CERTIFICATION_STEP) ?? [];
  assert.equal(fullCertificationSteps.length, 1, 'Task proof source lacks full exact-main certification');
  assert.equal(fullCertificationSteps[0].conclusion, 'success', 'Task proof source certification failed');
  const artifacts = await github.paginate(`actions/runs/${run.id}/artifacts`, {}, 'artifacts');
  const identity = { runId: run.id, sourceSha: plan.base };
  const selectedPlanArtifact = selectedArtifacts({ identity, artifacts }, [
    selectLatestPlanArtifact(artifacts, jobs, identity).id,
  ], identity, 'plan')[0];
  const mainPlan = validateVerificationPlan(await read(selectedPlanArtifact, 'ci-plan.json'));
  assert.equal(mainPlan.event, 'push');
  assert.equal(mainPlan.mode, 'full', 'Partial main plans cannot authorize task proof reuse');
  const evidenceArtifacts = selectLatestEvidenceArtifacts(mainPlan, artifacts, jobs, identity);
  const selectedEvidence = selectedArtifacts({ identity, artifacts }, evidenceArtifacts.map(item => item.id), identity, 'evidence');
  const reports = await Promise.all(selectedEvidence.map(item => read(item, 'report.json')));
  assertPlanEvidence(mainPlan, jobs, reports);
  const report = reports.find(item => item.group === COVERAGE_JOB);
  assert.ok(report, 'Exact-main coverage report is missing');
  assertTaskProducerInventory({ plan: mainPlan, report, inventory: report.producerInventory });
  const result = report.results.find(item => item.task === 'coverage');
  assert.equal(result?.status, 'passed', 'Exact-main coverage task did not pass');
  const proof = result.inputProof;
  assert.ok(proof, 'Exact-main coverage input proof is missing');
  const artifact = evidenceArtifacts.find(item => item.name === COVERAGE_ARTIFACT);
  assert.ok(artifact, 'Exact-main coverage artifact is missing');
  const job = exactJob(jobs, COVERAGE_JOB, run);
  assertTrustedTaskInputProof({ inputProof: proof,
    identity: { sourceSha: plan.base, planDigest: planDigest(mainPlan), workflowRunId: run.id, workflowAttempt: run.run_attempt },
    run, job, artifact,
    expected: { repositoryId: current.repository.id, workflowId: current.workflow_id, task: 'coverage',
      jobName: COVERAGE_JOB, workflowJob: COVERAGE_WORKFLOW_JOB, artifactName: COVERAGE_ARTIFACT,
      artifactId: artifact.id, artifactDigest: artifact.digest },
  });
  return { task: 'coverage', sourceSha: plan.base, proofSourceSha: plan.base, planDigest: proof.planDigest,
    workflowRunId: run.id, workflowAttempt: run.run_attempt, workflowId: run.workflow_id,
    repositoryId: run.repository.id, jobId: job.id, workflowJob: proof.workflowJob,
    artifactId: artifact.id, artifactName: artifact.name, artifactDigest: artifact.digest,
    inputClosure: proof.inputClosure, runtime: proof.runtime,
    certification: { workflowRunId: run.id, workflowAttempt: run.run_attempt, workflowId: run.workflow_id,
      repositoryId: run.repository.id, sourceSha: plan.base, jobId: certificationJob.id,
      step: fullCertificationSteps[0].name } };

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
  assert.deepEqual(plan.coverageReuse, trusted, 'Plan task proof reference changed after selection');
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

