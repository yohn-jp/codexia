#!/usr/bin/env node
// Read-only certification of a merged PR's source tree; never promote PR bytes here.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateVerificationPlan, planDigest } from './ci-impact.mjs';
import { assertPlanEvidence } from './ci-evidence.mjs';
import { assertProfileArtifactEvidence } from './ci-profile-artifact.mjs';
import { assertNativeArtifactEvidence } from './ci-native-producer.mjs';
import { selectLatestPlanArtifact, selectLatestEvidenceArtifacts } from './ci-artifact-selection.mjs';
import { downloadArtifact, extractJsonEntry, selectedArtifacts } from './download-ci-artifacts.mjs';
import { collectGitHubPages, REUSED_MAIN_SKIPPED_JOBS } from './release-policy.mjs';

const WORKFLOW = '.github/workflows/verify.yml';
const FULL_MODEL_JOB = 'full-model-oci / Run pinned Full model lifecycle on rootless Podman';
const FULL_CERT_STEP = 'Certify every required exact-source matrix element';
const shaPattern = /^[a-f0-9]{40}$/u;
const positive = n => Number.isSafeInteger(n) && n > 0;
const sameRepo = (record, id) => record?.id === id;
const success = job => job?.status === 'completed' && job.conclusion === 'success';

export function mergeCandidate(sourceSha, before, git) {
  assert.match(sourceSha, shaPattern);
  assert.match(before, shaPattern);
  assert.equal(git(['rev-parse', 'HEAD']).trim(), sourceSha, 'Checkout is not exact main source');
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
  assert.equal(run.path, WORKFLOW, 'Unexpected workflow path');
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

function assertJobBindings(jobs, run) {
  assert.ok(Array.isArray(jobs) && jobs.length > 0);
  for (const job of jobs) {
    assert.equal(job.head_sha, run.head_sha, 'Job source mismatch');
    assert.equal(job.run_id, run.id, 'Job run mismatch');
    assert.ok(positive(job.run_attempt) && job.run_attempt <= run.run_attempt, 'Job attempt mismatch');
    assert.equal(job.status, 'completed', 'Unfinished job');
  }
  const cert = jobs.filter(job => job.name === 'certification');
  assert.equal(cert.length, 1, 'Missing or duplicate certification job');
  assert.ok(success(cert[0]), 'Certification did not succeed');
  assert.equal(cert[0].run_attempt, run.run_attempt, 'Certification is not from latest attempt');
  return cert[0];
}

function assertPrAssociation(run, candidate, repoId) {
  assert.ok(Array.isArray(run.pull_requests));
  const associations = run.pull_requests.filter(pr => pr?.base?.ref === 'main' &&
    pr.head?.sha === candidate.head && sameRepo(pr.head?.repo, repoId) && sameRepo(pr.base?.repo, repoId));
  assert.equal(associations.length, 1, 'Missing or ambiguous PR association');
  assert.ok(positive(associations[0].number), 'Invalid associated PR number');
  return associations[0].number;
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
  // Affected selection is not yet a complete input-equivalence proof for excluded obligations.
  assert.equal(plan.mode, 'full', 'Affected PR proof cannot yet replace complete main verification');
}

export function assertCompactNeeds(needs) {
  const families = ['plan', 'unit', 'types', 'build', 'oci', 'browser', 'hosted_catalog', 'hosted'];
  assert.deepEqual(Object.keys(needs).sort(), families.sort(), 'Incomplete compact DAG outcomes');
  assert.equal(needs.plan.result, 'success');
  assert.ok(families.filter(name => name !== 'plan').every(name => needs[name].result === 'skipped'),
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

/** Recheck the actual merged tree and the existing canonical PR evidence, using read-only API data. */
export async function verifyReusableMainProof({ sourceSha, before, repository, currentRun, git, request, readArtifact }) {
  assert.equal(repository, 'yohn-jp/codexia', 'Unexpected repository');
  assert.ok(positive(currentRun?.repository?.id) && positive(currentRun.workflow_id));
  const context = { repoId: currentRun.repository.id, workflowId: currentRun.workflow_id };
  assertWorkflowRun(currentRun, context, sourceSha, 'push');
  assert.equal(currentRun.head_branch, 'main');
  const candidate = mergeCandidate(sourceSha, before, git);
  const list = (endpoint, key) => collectGitHubPages((page, perPage) =>
    request(endpoint + (endpoint.includes('?') ? '&' : '?') + 'per_page=' + perPage + '&page=' + page), key);
  const workflowRuns = sha => list('actions/workflows/' + context.workflowId + '/runs?head_sha=' + sha + '&event=pull_request', 'workflow_runs');
  const jobsFor = id => list('actions/runs/' + id + '/jobs?filter=latest', 'jobs');
  const runs = await workflowRuns(candidate.head);
  // Do not take an older green run when a newer run for this exact head is red or pending.
  const run = newest(runs.filter(value => value?.head_sha === candidate.head && value.event === 'pull_request' &&
    value.workflow_id === context.workflowId && value.path === WORKFLOW &&
    sameRepo(value.repository, context.repoId) && sameRepo(value.head_repository, context.repoId)));
  assertWorkflowRun(run, context, candidate.head, 'pull_request');
  assert.ok(success(run), 'Latest PR verification is not successful');
  const prNumber = assertPrAssociation(run, candidate, context.repoId);
  const mergedAt = assertMergedPull(await request('pulls/' + prNumber), prNumber, candidate, context.repoId);
  const [jobs, artifacts] = await Promise.all([jobsFor(run.id), list('actions/runs/' + run.id + '/artifacts', 'artifacts')]);
  const cert = assertJobBindings(jobs, run);
  const certSteps = cert.steps?.filter(step => step.name === FULL_CERT_STEP);
  assert.equal(certSteps?.length, 1, 'Missing or duplicate full certification step');
  assert.ok(success(certSteps[0]), 'PR certification step did not succeed');
  for (const job of jobs.filter(success)) {
    const completed = Date.parse(job.completed_at);
    assert.ok(Number.isFinite(completed) && completed <= mergedAt, 'PR proof was completed after merge');
  }
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
  assertProfileArtifactEvidence(plan, jobs, reports, artifacts, run.id);
  assertNativeArtifactEvidence(plan, jobs, reports, artifacts, run.id);
  for (const job of jobs.filter(job => job.conclusion === 'skipped')) {
    assert.ok(REUSED_MAIN_SKIPPED_JOBS.includes(job.name), 'Unexpected skipped PR job');
  }
  return {
    version: 1, sourceSha, tree: candidate.tree, baseSha: candidate.base, headSha: candidate.head,
    prNumber, runId: run.id, attempt: run.run_attempt, planDigest: planDigest(plan), mode: plan.mode,
    planArtifact: { id: selectedPlan.id, digest: selectedPlan.digest },
    evidence: selected.map(item => ({ id: item.id, digest: item.digest })),
  };
}

async function main() {
  const [command] = process.argv.slice(2);
  const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sourceSha, GITHUB_RUN_ID: runId, GH_TOKEN: token,
    GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_EVENT_PATH: eventPath } = process.env;
  assert.ok(command === 'plan' || command === 'certify');
  assert.equal(event, 'push');
  assert.equal(ref, 'refs/heads/main');
  assert.match(sourceSha ?? '', shaPattern);
  assert.match(runId ?? '', /^[1-9]\d*$/u);
  assert.ok(token && eventPath);
  const request = async endpoint => {
    const response = await fetch('https://api.github.com/repos/' + repository + '/' + endpoint, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    assert.ok(response.ok, 'GitHub proof lookup failed (HTTP ' + response.status + ')');
    return response.json();
  };
  const resolve = async () => {
    const payload = JSON.parse(await readFile(eventPath, 'utf8'));
    assert.equal(payload.ref, ref);
    assert.equal(payload.after, sourceSha);
    assert.equal(payload.forced, false);
    assert.equal(payload.deleted, false);
    const currentRun = await request('actions/runs/' + runId);
    assert.equal(String(currentRun.id), runId);
    return verifyReusableMainProof({ sourceSha, before: payload.before, repository, currentRun, request,
      git: args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15000 }),
      readArtifact: async (artifact, filename) => JSON.parse(await extractJsonEntry(await downloadArtifact(artifact, repository, token), filename)),
    });
  };
  if (command === 'plan') {
    try {
      const receipt = await resolve();
      await appendFile(process.env.GITHUB_OUTPUT, 'eligible=true\nreceipt=' + JSON.stringify(receipt) + '\n');
      console.log('Eligible merged PR source proof: PR #' + receipt.prNumber + ', run ' + receipt.runId);
    } catch (error) {
      // A missing, incompatible or unavailable proof is a request for full execution, not success.
      console.log('Main source proof unavailable; execute full graph: ' + String(error.message).replace(/[\r\n]/gu, ' ').slice(0, 300));
      await appendFile(process.env.GITHUB_OUTPUT, 'eligible=false\n');
    }
    return;
  }
  assertCompactNeeds(JSON.parse(process.env.CODEXIA_REQUIRED_RESULTS ?? 'null'));
  const receipt = await resolve();
  assert.deepEqual(receipt, JSON.parse(process.env.CODEXIA_REUSE_RECEIPT ?? 'null'), 'PR proof changed after planning');
  await writeFile(process.env.CODEXIA_REUSE_PROOF_PATH, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  const message = 'Certified exact main source ' + sourceSha + ' from merged PR #' + receipt.prNumber +
    ' (' + receipt.mode + ' proof, run ' + receipt.runId + '). No release artifact promoted.';
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, message + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
