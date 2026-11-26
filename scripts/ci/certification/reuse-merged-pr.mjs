#!/usr/bin/env node
// Read-only certification of a merged PR's source tree; never promote PR bytes here.
import assert from 'node:assert/strict';
import { CERTIFICATION_DEPENDENCIES } from '../impact/contract.mjs';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateVerificationPlan, planDigest } from '../impact/plan.mjs';
import { assertPlanEvidence } from '../evidence/validation.mjs';
import { assertProfileArtifactEvidence } from '../evidence/profile-artifact.mjs';
import { selectLatestPlanArtifact, selectLatestEvidenceArtifacts, resolveProducerJobAttempts } from '../evidence/artifact-selection.mjs';
import { downloadArtifact, extractJsonEntry, selectedArtifacts } from '../evidence/download-artifacts.mjs';
import { REUSED_MAIN_SKIPPED_JOBS } from '../../release/components/policy.mjs';
import { createGitHubProofClient } from '../evidence/proof-client.mjs';

const WORKFLOW = '.github/workflows/verify.yml';
const FULL_MODEL_JOB = 'full-model-oci / Run pinned Full model lifecycle on rootless Podman';
const FULL_CERT_STEP = 'Certify every required exact-source matrix element';
const shaPattern = /^[a-f0-9]{40}$/u;
const positive = n => Number.isSafeInteger(n) && n > 0;
const sameRepo = (record, id) => record?.id === id;
const success = job => job?.status === 'completed' && job.conclusion === 'success';

export function mergeCandidate(sourceSha, before, git, checkoutSha = sourceSha) {
  assert.match(sourceSha, shaPattern);
  assert.match(before, shaPattern);
  assert.match(checkoutSha, shaPattern);
  assert.equal(git(['rev-parse', 'HEAD']).trim(), checkoutSha, 'Checkout is not the expected exact source');
  const parents = git(['rev-list', '--parents', '-n', '1', sourceSha]).trim().split(/\s+/u);
  assert.equal(parents.length, 3, 'Not a single two-parent merge commit');
  const [source, base, head] = parents;
  assert.equal(source, sourceSha);
  assert.equal(base, before, 'Push must advance exactly one merge commit');
  assert.match(head, shaPattern);
  assert.equal(git(['merge-base', base, head]).trim(), base, 'PR head is not based on the merged parent');
  const tree = git(['rev-parse', sourceSha + '^{tree}']).trim();
  assert.match(tree, shaPattern);
  assert.equal(git(['rev-parse', head + '^{tree}']).trim(), tree, 'Merged tree differs from tested PR head');
  const files = git(['diff', '--name-only', '--no-renames', '-z', base, sourceSha, '--']).split('\0').filter(Boolean);
  return { sourceSha, base, head, tree, files };
}

function assertWorkflowRun(run, context, sha, event) {
  assert.ok(positive(run?.id) && positive(run.run_number) && positive(run.run_attempt), 'Invalid workflow run identity');
  assert.equal(run.workflow_id, context.workflowId, 'Unexpected workflow');
  assert.equal(run.path, context.workflowPath, 'Unexpected workflow path');
  assert.ok(sameRepo(run.repository, context.repoId) && sameRepo(run.head_repository, context.repoId), 'Foreign repository proof');
  assert.equal(run.head_sha, sha, 'Workflow source mismatch');
  assert.equal(run.event, event, 'Workflow event mismatch');
}

function newest(runs) {
  assert.ok(Array.isArray(runs) && runs.length > 0, 'No exact verification run');
  const ids = new Set();
  const numbers = new Set();
  for (const run of runs) {
    assert.ok(positive(run.id) && positive(run.run_number), 'Invalid run number');
    assert.ok(!ids.has(run.id) && !numbers.has(run.run_number), 'Ambiguous workflow run inventory');
    ids.add(run.id);
    numbers.add(run.run_number);
  }
  return [...runs].sort((a, b) => b.run_number - a.run_number)[0];
}

function assertJobRunBindings(jobs, run) {
  assert.ok(Array.isArray(jobs) && jobs.length > 0);
  for (const job of jobs) {
    assert.equal(job.head_sha, run.head_sha, 'Job source mismatch');
    assert.equal(job.run_id, run.id, 'Job run mismatch');
    assert.ok(positive(job.run_attempt) && job.run_attempt <= run.run_attempt, 'Job attempt mismatch');
    assert.equal(job.status, 'completed', 'Unfinished job');
  }
}

function assertCertificationJob(jobs, run) {
  assertJobRunBindings(jobs, run);
  const cert = jobs.filter(job => job.name === 'certification');
  assert.equal(cert.length, 1, 'Missing or duplicate certification job');
  assert.ok(success(cert[0]), 'Certification did not succeed');
  assert.equal(cert[0].run_attempt, run.run_attempt, 'Certification is not from latest attempt');
  return cert[0];
}

async function mergedPrNumber(run, candidate, repoId, request) {
  assert.ok(Array.isArray(run.pull_requests));
  const associations = run.pull_requests.filter(pr => pr?.base?.ref === 'main' &&
    pr.head?.sha === candidate.head && pr.base?.sha === candidate.base && sameRepo(pr.head?.repo, repoId) && sameRepo(pr.base?.repo, repoId));
  if (run.pull_requests.length > 0) {
    assert.equal(associations.length, 1, 'Missing or ambiguous PR association');
    assert.ok(positive(associations[0].number), 'Invalid associated PR number');
    return associations[0].number;
  }
  // GitHub may clear workflow_run.pull_requests after the PR closes.
  // Resolve the association from the actual merge commit instead, not a branch search.
  const pulls = await request.paginate('commits/' + candidate.sourceSha + '/pulls', {}, null);
  assert.ok(Array.isArray(pulls), 'Invalid merge PR association inventory');
  const merged = pulls.filter(pr => pr?.merge_commit_sha === candidate.sourceSha &&
    pr.head?.sha === candidate.head && pr.base?.ref === 'main' && pr.base?.sha === candidate.base &&
    sameRepo(pr.head?.repo, repoId) && sameRepo(pr.base?.repo, repoId));
  assert.equal(merged.length, 1, 'Missing or ambiguous merge commit PR association');
  assert.ok(positive(merged[0].number), 'Invalid associated PR number');
  return merged[0].number;
}

function assertMergedPull(pr, number, candidate, repoId) {
  assert.equal(pr.number, number);
  assert.equal(pr.merged, true, 'PR is not merged');
  assert.equal(pr.state, 'closed');
  assert.equal(pr.merge_commit_sha, candidate.sourceSha, 'PR does not identify this merge commit');
  assert.equal(pr.head?.sha, candidate.head);
  assert.equal(pr.base?.ref, 'main');
  assert.ok(sameRepo(pr.head?.repo, repoId) && sameRepo(pr.base?.repo, repoId), 'Foreign merged PR');
  const mergedAt = Date.parse(pr.merged_at);
  assert.ok(Number.isFinite(mergedAt), 'Invalid merge timestamp');
  return mergedAt;
}

export function assertCandidatePlan(plan, candidate) {
  validateVerificationPlan(plan);
  assert.equal(plan.event, 'pull_request');
  assert.equal(plan.sha, candidate.head, 'PR plan source mismatch');
  assert.equal(plan.base, candidate.base, 'PR was not verified against the merged base');
  assert.deepEqual(plan.files, candidate.files, 'PR impact does not cover actual merge diff');
  // Affected PR checks certify only impacted tasks; compact main reuse requires the complete graph.
  assert.equal(plan.mode, 'full', 'Affected PR proof cannot yet replace complete main verification');
}

export function assertCompactNeeds(needs) {
  assert.deepEqual(Object.keys(needs).sort(), CERTIFICATION_DEPENDENCIES.toSorted(), 'Incomplete compact DAG outcomes');
  assert.equal(needs.plan.result, 'success');
  assert.ok(CERTIFICATION_DEPENDENCIES.filter(name => name !== 'plan').every(name => needs[name].result === 'skipped'),
    'Compact certification requires every expensive group to be skipped');
}

function assertFullModelJob(plan, jobs) {
  const model = jobs.filter(job => job.name === 'full-model-oci' || job.name.startsWith('full-model-oci / '));
  assert.equal(model.length, 1, 'Missing or duplicate Full-model job');
  if (plan.full_model_oci) {
    assert.equal(model[0].name, FULL_MODEL_JOB);
    assert.ok(success(model[0]), 'Selected Full-model proof did not succeed');
  } else {
    assert.equal(model[0].name, 'full-model-oci');
    assert.equal(model[0].conclusion, 'skipped');
  }
}

function apiList(request, endpoint, key, parameters = {}) {
  return request.paginate(endpoint, parameters, key);
}

function mainContext(repository, currentRun, sourceSha, workflowPath) {
  assert.equal(repository, 'yohn-jp/codexia', 'Unexpected repository');
  assert.ok(positive(currentRun?.repository?.id) && positive(currentRun.workflow_id));
  const context = { repoId: currentRun.repository.id, workflowId: currentRun.workflow_id, workflowPath };
  assertWorkflowRun(currentRun, context, sourceSha, 'push');
  assert.equal(currentRun.head_branch, 'main');
  return context;
}

async function mergedPrRun({ context, candidate, request }) {
  const runs = await apiList(request, 'actions/workflows/' + context.workflowId + '/runs', 'workflow_runs',
    { head_sha: candidate.head, event: 'pull_request' });
  const run = newest(runs.filter(value => value?.head_sha === candidate.head && value.event === 'pull_request' &&
    value.workflow_id === context.workflowId && value.path === context.workflowPath &&
    sameRepo(value.repository, context.repoId) && sameRepo(value.head_repository, context.repoId)));
  assertWorkflowRun(run, context, candidate.head, 'pull_request');
  assert.ok(success(run), 'Latest PR verification is not successful');
  const prNumber = await mergedPrNumber(run, candidate, context.repoId, request);
  const pr = await request('pulls/' + prNumber);
  const mergedAt = assertMergedPull(pr, prNumber, candidate, context.repoId);
  assert.equal(run.head_branch, pr.head.ref, 'Workflow branch does not identify the merged PR head');
  const jobs = await apiList(request, 'actions/runs/' + run.id + '/jobs', 'jobs', { filter: 'latest' });
  assertJobRunBindings(jobs, run);
  for (const job of jobs.filter(success)) {
    const completed = Date.parse(job.completed_at);
    assert.ok(Number.isFinite(completed) && completed <= mergedAt, 'PR proof was completed after merge');
  }
  return { run, jobs, prNumber, mergedAt, headRef: pr.head.ref };
}

function assertSuccessfulStep(job, name) {
  const steps = job.steps?.filter(step => step.name === name);
  assert.equal(steps?.length, 1, 'Missing or duplicate proof step: ' + name);
  assert.ok(success(steps[0]), 'Required proof step did not succeed: ' + name);
}

/** Recheck the actual merged tree and the existing canonical PR evidence, using read-only API data. */
export async function readReusableMainEvidence({ sourceSha, before, repository, currentRun, git, request, readArtifact, checkoutSha = sourceSha }) {
  const context = mainContext(repository, currentRun, sourceSha, WORKFLOW);
  const candidate = mergeCandidate(sourceSha, before, git, checkoutSha);
  const { run, jobs, prNumber, mergedAt, headRef } = await mergedPrRun({ context, candidate, request });
  const cert = assertCertificationJob(jobs, run);
  assertSuccessfulStep(cert, FULL_CERT_STEP);
  const artifacts = await apiList(request, 'actions/runs/' + run.id + '/artifacts', 'artifacts');
  const identity = { runId: run.id, sourceSha: candidate.head };
  const inventory = { identity, artifacts };
  const planArtifact = selectLatestPlanArtifact(artifacts, jobs, identity);
  const [selectedPlan] = selectedArtifacts(inventory, [planArtifact.id], identity, 'plan');
  const plan = await readArtifact(selectedPlan, 'ci-plan.json');
  assertCandidatePlan(plan, candidate);
  assertFullModelJob(plan, jobs);
  const evidence = selectLatestEvidenceArtifacts(plan, artifacts, jobs, identity);
  const selected = selectedArtifacts(inventory, evidence.map(item => item.id), identity, 'evidence');
  // Only digest-verified JSON is read. Never restore or execute code from a PR artifact.
  const reports = await Promise.all(selected.map(item => readArtifact(item, 'report.json')));
  assertPlanEvidence(plan, jobs, reports);
  const producerJobs = await resolveProducerJobAttempts(jobs, run,
    (runId, attempt) => request.paginate('actions/runs/' + runId + '/attempts/' + attempt + '/jobs', {}, 'jobs'),
    ['build-core', 'build-full']);
  assertProfileArtifactEvidence(plan, producerJobs, reports, artifacts, run.id);
  for (const job of jobs.filter(job => job.conclusion === 'skipped')) {
    assert.ok(REUSED_MAIN_SKIPPED_JOBS.includes(job.name), 'Unexpected skipped PR job');
  }
  const receipt = {
    version: 1, sourceSha, tree: candidate.tree, baseSha: candidate.base, headSha: candidate.head,
    prNumber, runId: run.id, attempt: run.run_attempt, mergedAt: new Date(mergedAt).toISOString(), headRef, planDigest: planDigest(plan), mode: plan.mode,
    planArtifact: { id: selectedPlan.id, digest: selectedPlan.digest },
    evidence: selected.map(item => ({ id: item.id, digest: item.digest })),
  };
  return { receipt, plan, reports };
}

export async function verifyReusableMainProof(options) {
  return (await readReusableMainEvidence(options)).receipt;
}

// The exact job and positive verification steps are the proof boundary for each
// independent workflow. These are not substitutes for the canonical source graph.
export const DEDICATED_PROOFS = Object.freeze({
  '.github/workflows/ansible-host.yml': {
    job: 'Verify real Ubuntu rootless host convergence',
    steps: ['Install supported Ansible control environment', 'Exercise host stage twice and run Quadlet with Actions-only environment isolation'],
  },
  '.github/workflows/ansible-base-secrets.yml': {
    job: 'Verify rootless Podman, PostgreSQL, and Tunnel Quadlets',
    steps: ['Prepare disposable runtime', 'Check PostgreSQL volume layout',
      'Exercise rootless convergence through a separate bootstrap account', 'Remove the disposable fixture user even after test failure'],
  },
  '.github/workflows/push-backup.yml': {
    job: 'Verify push backup locks, writer quiescence and interrupted deployment recovery',
    steps: ['Check backup and recovery shell syntax', 'Verify push backup lock and recovery contract'],
  },
  '.github/workflows/deployment-config.yml': {
    job: 'Verify Ansible and Terraform configuration',
    steps: ['Select independent infrastructure checks'],
  },
  '.github/workflows/full-model-oci-acceptance.yml': {
    job: FULL_MODEL_JOB,
    steps: ['Install a disposable rootless OCI runtime', 'Write the pinned real model file manifest',
      'Expose the pinned tokenizer at the configured local model path', 'Fail on missing or altered model cache files',
      'Run the real Full model OCI lifecycle acceptance'],
  },
});

function assertInfrastructureSelection(job, files) {
  // The same merged-base diff must select the same independent scopes as the
  // existing deployment-config workflow. Require positive evidence for each.
  const ansible = files.some(file => /^(deploy\/(?:ansible|backup|quadlet|postgres)\/|\.github\/workflows\/deployment-config\.yml$|scripts\/shared\/python-env\.sh$)/u.test(file));
  const terraform = files.some(file => /^(deploy\/cloudflare\/|\.github\/workflows\/deployment-config\.yml$)/u.test(file));
  if (ansible || !terraform) assertSuccessfulStep(job, 'Check Ansible configuration');
  if (terraform || !ansible) {
    assertSuccessfulStep(job, 'Check all Terraform files');
    assertSuccessfulStep(job, 'Validate Cloudflare Terraform');
  }
}

export async function verifyReusableDedicatedProof({ sourceSha, before, repository, currentRun, git, request }) {
  const workflowPath = currentRun?.path;
  assert.ok(Object.hasOwn(DEDICATED_PROOFS, workflowPath), 'Not an independent verification workflow');
  let context = mainContext(repository, currentRun, sourceSha, workflowPath);
  const candidate = mergeCandidate(sourceSha, before, git);
  const definition = DEDICATED_PROOFS[workflowPath];
  if (workflowPath === '.github/workflows/full-model-oci-acceptance.yml') {
    // The PR caller lives in Verify; the main supplemental run is standalone.
    const verify = await request('actions/workflows/verify.yml');
    assert.equal(verify.path, WORKFLOW);
    assert.ok(positive(verify.id), 'Invalid Verify workflow identity');
    context = { ...context, workflowId: verify.id, workflowPath: WORKFLOW };
  }
  const { run, jobs, prNumber } = await mergedPrRun({ context, candidate, request });
  if (context.workflowPath === WORKFLOW) assertSuccessfulStep(assertCertificationJob(jobs, run), FULL_CERT_STEP);
  else assert.equal(jobs.length, 1, 'Unexpected dedicated PR job inventory');
  const matches = jobs.filter(job => job.name === definition.job);
  assert.equal(matches.length, 1, 'Missing or duplicate dedicated proof job');
  const job = matches[0];
  assert.ok(success(job) && positive(job.id), 'Dedicated PR proof did not succeed');
  assert.equal(job.run_attempt, run.run_attempt, 'Dedicated proof is not from latest attempt');
  for (const step of definition.steps) assertSuccessfulStep(job, step);
  if (workflowPath === '.github/workflows/deployment-config.yml') assertInfrastructureSelection(job, candidate.files);
  return { version: 1, sourceSha, tree: candidate.tree, baseSha: candidate.base, headSha: candidate.head,
    prNumber, workflowPath, proofWorkflowPath: context.workflowPath, runId: run.id, attempt: run.run_attempt, jobId: job.id };
}

async function main() {
  const [command] = process.argv.slice(2);
  const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sourceSha, GITHUB_RUN_ID: runId, GH_TOKEN: token,
    GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_EVENT_PATH: eventPath } = process.env;
  assert.ok(['plan', 'certify', 'dedicated'].includes(command));
  assert.equal(event, 'push');
  assert.equal(ref, 'refs/heads/main');
  assert.match(sourceSha ?? '', shaPattern);
  assert.match(runId ?? '', /^[1-9]\d*$/u);
  assert.ok(token && eventPath);
  assert.equal(repository, 'yohn-jp/codexia', 'Unexpected repository');
  const client = createGitHubProofClient({ repository, token });
  const request = client.get;
  const resolve = async () => {
    const payload = JSON.parse(await readFile(eventPath, 'utf8'));
    assert.equal(payload.ref, ref);
    assert.equal(payload.after, sourceSha);
    assert.equal(payload.forced, false);
    assert.equal(payload.deleted, false);
    const currentRun = await request('actions/runs/' + runId);
    assert.equal(String(currentRun.id), runId);
    const verify = command === 'dedicated' ? verifyReusableDedicatedProof : verifyReusableMainProof;
    return verify({ sourceSha, before: payload.before, repository, currentRun, request,
      git: args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15000 }),
      readArtifact: async (artifact, filename) => JSON.parse(await extractJsonEntry(await downloadArtifact(artifact, repository, token), filename)),
    });
  };
  if (command === 'plan' || command === 'dedicated') {
    try {
      await resolve();
      await appendFile(process.env.GITHUB_OUTPUT, 'eligible=true\n');
      const message = 'Eligible merged PR proof revalidated for exact main source ' + sourceSha;
      console.log(message);
      if (command === 'dedicated' && process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
        message + '; independent verification reused for exact main source ' + sourceSha + '.\n');
    } catch (error) {
      // A missing, incompatible or unavailable proof is a request for full execution, not success.
      console.log('Main source proof unavailable; execute full graph: ' + String(error.message).replace(/[\r\n]/gu, ' ').slice(0, 300));
      await appendFile(process.env.GITHUB_OUTPUT, 'eligible=false\n');
    }
    return;
  }
  assertCompactNeeds(JSON.parse(process.env.CODEXIA_REQUIRED_RESULTS ?? 'null'));
  await resolve();
  const message = 'Certified exact main source ' + sourceSha + ' from a freshly revalidated merged PR proof. No release artifact promoted.';
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, message + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
