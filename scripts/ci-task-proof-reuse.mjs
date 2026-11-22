import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { assertPlanEvidence } from './ci-evidence.mjs';
import { selectLatestEvidenceArtifacts, selectLatestJobArtifact, selectLatestPlanArtifact, resolveProducerJobAttempts } from './ci-artifact-selection.mjs';
import { downloadArtifact, extractJsonEntry, selectedArtifacts } from './download-ci-artifacts.mjs';
import { collectGitHubPages } from './release-policy.mjs';
import { assertTaskProducerInventory, assertTrustedTaskInputProof, selectEquivalentTaskProofs } from './ci-task-input-proof.mjs';
import { planDigest, validateVerificationPlan } from './ci-impact.mjs';
import { VERIFICATION_TASKS, requiredBuildProfile } from './ci-contract.mjs';
import { captureCoverageInputClosure, coverageInvocation } from './ci-coverage-inputs.mjs';
import { verifyReusableMainProof } from './reuse-pr-verification.mjs';
import { assertTrustedCertifiedSourceTaskInputProof } from './ci-task-input-proof.mjs';
import { captureTaskInputSource, taskGroup, taskWorkflowJob } from './ci-task-inputs.mjs';
import { coverageRuntime } from './ci-coverage-inputs.mjs';
import { assertProfileArtifactEvidence } from './ci-profile-artifact.mjs';
import { assertNativeArtifactEvidence } from './ci-native-producer.mjs';

const PROOF_REPOSITORY = 'yohn-jp/codexia';
const PROOF_API = 'https://api.github.com/repos/yohn-jp/codexia/';
const VERIFY_PATH = '.github/workflows/verify.yml';
const COVERAGE_JOB = 'types-tests';
const COVERAGE_WORKFLOW_JOB = 'types';
const COVERAGE_ARTIFACT = 'ci-evidence-types-tests';
const CERTIFICATION_STEP = 'Certify every required exact-source matrix element';
const COMPACT_CERTIFICATION_STEP = 'Certify reused merged PR proof';

const positive = value => Number.isSafeInteger(value) && value > 0;

const PROOF_ENDPOINTS = [
  /^actions\/workflows\/verify\.yml$/u,
  /^actions\/workflows\/[1-9]\d*\/runs\?head_sha=[a-f0-9]{40}&event=(?:push|pull_request)&per_page=[1-9]\d*&page=[1-9]\d*$/u,
  /^actions\/runs\/[1-9]\d*$/u,
  /^actions\/runs\/[1-9]\d*\/jobs\?filter=latest&per_page=[1-9]\d*&page=[1-9]\d*$/u,
  /^actions\/runs\/[1-9]\d*\/artifacts\?per_page=[1-9]\d*&page=[1-9]\d*$/u,
  /^actions\/runs\/[1-9]\d*\/attempts\/[1-9]\d*\/jobs\?per_page=100&page=[1-9]\d*$/u,
  /^commits\/[a-f0-9]{40}\/pulls\?per_page=100&page=1$/u,
  /^pulls\/[1-9]\d*$/u,
];

/** A single read-only transport for trusted GitHub proof identities, never arbitrary file contents. */
export function createGitHubProofClient({ repository, token, request = fetch }) {
  assert.equal(repository, PROOF_REPOSITORY, 'Task proof reuse is restricted to the canonical repository');
  assert.ok(typeof token === 'string' && token.length > 0, 'GitHub read token is required');
  const send = async endpoint => {
    if (typeof endpoint !== 'string' || !PROOF_ENDPOINTS.some(pattern => pattern.test(endpoint))) {
      throw new Error('Unexpected GitHub task proof API endpoint');
    }
    const response = await request(PROOF_API + endpoint, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    return response;
  };
  return { send, get: endpoint => getJson(send, endpoint) };
}


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

async function resolveCompactMainTaskProofs({ plan, run, jobs, current, repository, token, request, read, tasks = [] }) {
  const certJob = exactJob(jobs, 'certification', run);
  const certSteps = certJob.steps?.filter(step => step.name === COMPACT_CERTIFICATION_STEP) ?? [];
  assert.equal(certSteps.length, 1, 'Missing or duplicate compact exact-main certification step');
  assert.equal(certSteps[0].conclusion, 'success', 'Compact exact-main certification failed');
  const before = execFileSync('git', ['rev-parse', `${plan.base}^1`], { encoding: 'utf8' }).trim();
  const githubRequest = createGitHubProofClient({ repository, token, request }).send;
  const mainProof = await verifyReusableMainProof({ sourceSha: plan.base, before, repository, currentRun: run,
    checkoutSha: plan.sha,
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
  const coverage = { task: 'coverage', sourceSha: plan.base, proofSourceSha: mainProof.headSha,
    planDigest: proof.planDigest, workflowRunId: sourceRun.id, workflowAttempt: sourceRun.run_attempt,
    workflowId: sourceRun.workflow_id, repositoryId: sourceRun.repository.id, jobId: sourceJob.id,
    workflowJob: proof.workflowJob, artifactId: artifact.id, artifactName: artifact.name, artifactDigest: artifact.digest,
    inputClosure: proof.inputClosure, runtime: proof.runtime, certification: mainCertification };
  const output = { coverage };
  for (const task of tasks) {
    const group = taskGroup(task);
    const report = sourceReports.find(item => item.group === group);
    assert.ok(report, `Merged PR proof task report is missing: ${task}`);
    assertTaskProducerInventory({ plan: sourcePlan, report, inventory: report.producerInventory });
    const result = report.results.find(item => item.task === task);
    assert.equal(result?.status, 'passed', `Merged PR proof task did not pass: ${task}`);
    const taskProof = result.inputProof;
    assert.equal(taskProof?.mode, 'task-execution', `Merged PR task input proof is missing: ${task}`);
    const taskArtifact = sourceEvidence.find(item => item.name === `ci-evidence-${group}`);
    assert.ok(taskArtifact, `Merged PR task proof artifact is missing: ${task}`);
    const taskJobs = sourceJobs.filter(job => job.name === group);
    assert.equal(taskJobs.length, 1, `Merged PR proof has no unique task producer job: ${group}`);
    const taskJob = taskJobs[0];
    assertTrustedCertifiedSourceTaskInputProof({ inputProof: taskProof,
      identity: { sourceSha: mainProof.headSha, planDigest: mainProof.planDigest,
        workflowRunId: sourceRun.id, workflowAttempt: sourceRun.run_attempt },
      sourceRun, job: taskJob, artifact: taskArtifact, mainRun: run, certificationJob: certJob,
      certificationStep: certSteps[0], certification: mainCertification,
      expected: { repositoryId: current.repository.id, workflowId: current.workflow_id, jobId: taskJob.id,
        task, jobName: group, workflowJob: taskWorkflowJob(task), artifactId: taskArtifact.id,
        artifactName: taskArtifact.name, artifactDigest: taskArtifact.digest },
    });
    output[task] = { task, sourceSha: plan.base, proofSourceSha: mainProof.headSha,
      planDigest: taskProof.planDigest, workflowRunId: sourceRun.id, workflowAttempt: sourceRun.run_attempt,
      workflowId: sourceRun.workflow_id, repositoryId: sourceRun.repository.id, jobId: taskJob.id,
      workflowJob: taskProof.workflowJob, artifactId: taskArtifact.id, artifactName: taskArtifact.name,
      artifactDigest: taskArtifact.digest, inputClosure: taskProof.inputClosure, runtime: taskProof.runtime,
      certification: mainCertification };
  }
  return output;
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
  assert.equal(repository, PROOF_REPOSITORY, 'Task proof reuse is restricted to the canonical repository');
  assert.ok(typeof token === 'string' && token.length > 0, 'GitHub read token is required');
  assert.equal(current?.path, VERIFY_PATH, 'Current workflow path mismatch');
  assert.equal(current?.event, 'pull_request', 'Current run is not a pull request');
  assert.equal(current?.head_sha, plan.sha, 'Current run source mismatch');
  assert.ok(positive(current?.workflow_id) && positive(current?.repository?.id), 'Current workflow identity is incomplete');

  const get = createGitHubProofClient({ repository, token, request }).get;
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
    const compact = await resolveCompactMainTaskProofs({ plan, run, jobs, current, repository, token, request, read });
    return compact.coverage;
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

/** Resolve full-plan task proofs only from the latest successful exact-base main certification. */
export async function resolveExactMainTaskProofs({ plan: planValue, current, repository, token, tasks, request = fetch, readArtifact }) {
  const plan = validateVerificationPlan(planValue);
  assert.equal(repository, PROOF_REPOSITORY, 'Task proof reuse is restricted to the canonical repository');
  assert.equal(plan.event, 'pull_request', 'Task proof reuse is only available to pull requests');
  assert.match(plan.base ?? '', /^[a-f0-9]{40}$/u, 'Task proof reuse requires an exact PR base');
  assert.ok(Array.isArray(tasks) && new Set(tasks).size === tasks.length, 'Invalid omitted task proof inventory');
  assert.ok(tasks.every(task => VERIFICATION_TASKS.includes(task) && !plan.tasks.includes(task) && task !== 'coverage'),
    'Task proof request is not an omitted canonical task');
  let coverage;
  try {
    coverage = await resolveExactMainCoverageProof({ plan, current, repository, token, request, readArtifact });
  } catch (error) {
    if (tasks.length === 0) throw error;
    // Coverage is selected and will run normally if its own proof is unavailable.
    // It must not prevent independent omitted tasks from proving their inputs.
  }
  const get = createGitHubProofClient({ repository, token, request }).get;
  const workflow = await get('actions/workflows/verify.yml');
  assert.equal(workflow.id, current.workflow_id, 'Current run uses another workflow');
  const runs = await collectGitHubPages((page, perPage) => get(
    `actions/workflows/${workflow.id}/runs?head_sha=${plan.base}&event=push&per_page=${perPage}&page=${page}`), 'workflow_runs');
  const exactRuns = runs.filter(run => run?.workflow_id === current.workflow_id && run.path === VERIFY_PATH &&
    run.event === 'push' && run.head_branch === 'main' && run.head_sha === plan.base &&
    run.repository?.id === current.repository.id && run.head_repository?.id === current.repository.id);
  assert.ok(exactRuns.length > 0, 'No exact-base main verification run');
  const run = [...exactRuns].sort((left, right) => right.run_number - left.run_number)[0];
  assert.equal(run.status, 'completed', 'Latest exact-base main run is unfinished');
  assert.equal(run.conclusion, 'success', 'Latest exact-base main run failed');
  const jobs = await collectGitHubPages((page, perPage) => get(
    `actions/runs/${run.id}/jobs?filter=latest&per_page=${perPage}&page=${page}`), 'jobs');
  const certificationJob = exactJob(jobs, 'certification', run);
  if (certificationJob.steps?.some(step => step.name === COMPACT_CERTIFICATION_STEP && step.conclusion === 'success')) {
    const read = readArtifact ?? (async (artifact, filename) => JSON.parse(await extractJsonEntry(
      await downloadArtifact(artifact, repository, token, request), filename)));
    return resolveCompactMainTaskProofs({ plan, run, jobs, current, repository, token, request, read, tasks });
  }
  const fullCertificationSteps = certificationJob.steps?.filter(step => step.name === CERTIFICATION_STEP) ?? [];
  assert.equal(fullCertificationSteps.length, 1, 'Task proof source lacks full exact-main certification');
  assert.equal(fullCertificationSteps[0].conclusion, 'success', 'Task proof source certification failed');
  const artifacts = await collectGitHubPages((page, perPage) => get(
    `actions/runs/${run.id}/artifacts?per_page=${perPage}&page=${page}`), 'artifacts');
  const identity = { runId: run.id, sourceSha: plan.base };
  const selectedPlanArtifact = selectedArtifacts({ identity, artifacts }, [
    selectLatestPlanArtifact(artifacts, jobs, identity).id,
  ], identity, 'plan')[0];
  const read = readArtifact ?? (async (artifact, filename) => JSON.parse(await extractJsonEntry(
    await downloadArtifact(artifact, repository, token, request), filename)));
  const mainPlan = validateVerificationPlan(await read(selectedPlanArtifact, 'ci-plan.json'));
  assert.equal(mainPlan.event, 'push');
  assert.equal(mainPlan.mode, 'full', 'Partial main plans cannot authorize task proof reuse');
  assert.deepEqual(mainPlan.tasks, VERIFICATION_TASKS, 'Main task proof does not cover the complete verification inventory');
  const evidenceArtifacts = selectLatestEvidenceArtifacts(mainPlan, artifacts, jobs, identity);
  const selectedEvidence = selectedArtifacts({ identity, artifacts }, evidenceArtifacts.map(item => item.id), identity, 'evidence');
  const reports = await Promise.all(selectedEvidence.map(item => read(item, 'report.json')));
  assertPlanEvidence(mainPlan, jobs, reports);
  if (tasks.some(task => requiredBuildProfile(taskGroup(task)) || task.startsWith('hosted-native-'))) {
    const producerJobs = await resolveProducerJobAttempts(jobs, run, get, ['build-core', 'build-full', 'hosted-native-catalog']);
    assertProfileArtifactEvidence(mainPlan, producerJobs, reports, artifacts, run.id);
    if (tasks.some(task => task.startsWith('hosted-native-'))) assertNativeArtifactEvidence(mainPlan, producerJobs, reports, artifacts, run.id);
  }
  const output = { ...(coverage ? { coverage } : {}) };
  for (const task of tasks) {
    const group = taskGroup(task);
    const report = reports.find(item => item.group === group);
    assert.ok(report, `Exact-main task report is missing: ${task}`);
    assertTaskProducerInventory({ plan: mainPlan, report, inventory: report.producerInventory });
    const result = report.results.find(item => item.task === task);
    assert.equal(result?.status, 'passed', `Exact-main task did not pass: ${task}`);
    const proof = result.inputProof;
    assert.equal(proof?.mode, 'task-execution', `Exact-main task input proof is missing: ${task}`);
    const artifact = evidenceArtifacts.find(item => item.name === `ci-evidence-${group}`);
    assert.ok(artifact, `Exact-main task proof artifact is missing: ${task}`);
    const job = exactJob(jobs, group, run);
    assertTrustedTaskInputProof({ inputProof: proof,
      identity: { sourceSha: plan.base, planDigest: planDigest(mainPlan), workflowRunId: run.id, workflowAttempt: run.run_attempt },
      run, job, artifact,
      expected: { repositoryId: current.repository.id, workflowId: current.workflow_id, task,
        jobName: group, workflowJob: taskWorkflowJob(task), artifactName: `ci-evidence-${group}`,
        artifactId: artifact.id, artifactDigest: artifact.digest },
    });
    output[task] = { task, sourceSha: plan.base, proofSourceSha: plan.base, planDigest: proof.planDigest,
      workflowRunId: run.id, workflowAttempt: run.run_attempt, workflowId: run.workflow_id,
      repositoryId: run.repository.id, jobId: job.id, workflowJob: proof.workflowJob,
      artifactId: artifact.id, artifactName: artifact.name, artifactDigest: artifact.digest,
      inputClosure: proof.inputClosure, runtime: proof.runtime,
      certification: { workflowRunId: run.id, workflowAttempt: run.run_attempt, workflowId: run.workflow_id,
        repositoryId: run.repository.id, sourceSha: plan.base, jobId: certificationJob.id,
        step: fullCertificationSteps[0].name } };
  }
  return output;
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

/** Re-resolve and recompute every omitted-task closure before certifying an affected PR plan. */
export async function assertReusedOmittedTaskProofs({ plan: planValue, current, repository, token, request = fetch }) {
  const plan = validateVerificationPlan(planValue);
  assert.equal(plan.event, 'pull_request', 'Omitted task proof reuse is only available to pull requests');
  assert.equal(plan.mode, 'affected', 'Omitted task proof reuse requires an affected plan');
  assert.equal(plan.taskInputReuse?.format, 'codexia-ci-task-input-reuse/v2', 'Affected plan lacks complete task proof reuse');
  const tasks = VERIFICATION_TASKS.filter(task => !plan.tasks.includes(task) && task !== 'coverage');
  assert.deepEqual(Object.keys(plan.taskInputReuse.omitted).sort(), [...tasks].sort(), 'Affected plan omitted proof inventory changed');
  const trusted = await resolveExactMainTaskProofs({ plan, current, repository, token, tasks, request });
  assert.deepEqual(plan.taskInputReuse.coverage, trusted.coverage, 'Plan static coverage proof reference changed');
  assert.deepEqual(plan.taskInputReuse.omitted, Object.fromEntries(tasks.map(task => [task, trusted[task]])),
    'Plan task proof reference changed after selection');

  const runtime = coverageRuntime();
  const closureFor = captureTaskInputSource({ root: process.cwd(), sha: plan.sha, runtime });
  const baseline = [];
  const candidate = [];
  for (const task of tasks) {
    const receipt = trusted[task];
    const closure = closureFor(task);
    baseline.push({ ...receipt, format: 'codexia-ci-task-input-proof/v2', mode: 'task-execution', status: 'passed',
      sourceSha: receipt.proofSourceSha });
    candidate.push({ task, format: 'codexia-ci-task-input-proof/v2', mode: 'task-execution', status: 'passed',
      sourceSha: plan.sha, planDigest: planDigest(plan), workflowRunId: current.id,
      workflowAttempt: current.run_attempt, workflowJob: taskWorkflowJob(task), inputClosure: closure });
  }
  const equivalent = selectEquivalentTaskProofs({ tasks, baseline, candidate,
    baselineIdentity: { sourceSha: trusted[tasks[0]].proofSourceSha, planDigest: trusted[tasks[0]].planDigest,
      workflowRunId: trusted[tasks[0]].workflowRunId, workflowAttempt: trusted[tasks[0]].workflowAttempt },
    candidateIdentity: { sourceSha: plan.sha, planDigest: planDigest(plan), workflowRunId: current.id,
      workflowAttempt: current.run_attempt },
  });
  assert.deepEqual(equivalent, tasks, 'Candidate and exact-base omitted task inputs are not equivalent');
  return true;
}
