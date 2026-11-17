import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeCandidate, assertCandidatePlan, assertCompactNeeds, verifyReusableMainProof, verifyReusableDedicatedProof, DEDICATED_PROOFS } from './reuse-pr-verification.mjs';
import { createVerificationPlan, planDigest } from './ci-impact.mjs';
import { VERIFICATION_GROUPS, requiredBuildProfile } from './ci-contract.mjs';

const sourceSha = 'a'.repeat(40), base = 'b'.repeat(40), head = 'c'.repeat(40), tree = 'd'.repeat(40);
const repository = 'yohn-jp/codexia', repo = { id: 123 }, workflow_id = 42;
const start = '2026-11-17T10:00:00Z', end = '2026-11-17T10:05:00Z', merged = '2026-11-17T10:06:00Z';
const digest = 'sha256:' + 'e'.repeat(64);
const workflowPath = '.github/workflows/verify.yml';
const status = { status: 'completed', conclusion: 'success' };

function fixture(files = ['package.json']) {
  const git = args => {
    if (args[0] === 'rev-list') return [sourceSha, base, head].join(' ') + '\n';
    if (args[0] === 'merge-base') return base + '\n';
    if (args[0] === 'rev-parse') return (args[1] === 'HEAD' ? sourceSha : tree) + '\n';
    if (args[0] === 'diff') return files.join('\0') + '\0';
    throw new Error('unexpected git command');
  };
  const common = { ...status, workflow_id, path: workflowPath, repository: repo, head_repository: repo, run_attempt: 1 };
  const currentRun = { ...common, id: 30, run_number: 30, head_sha: sourceSha, head_branch: 'main', event: 'push', status: 'in_progress', conclusion: null };
  const pr = { number: 7, state: 'closed', merged: true, merged_at: merged, merge_commit_sha: sourceSha, head: { sha: head, ref: 'feature/example', repo }, base: { ref: 'main', sha: base, repo } };
  const prRun = { ...common, id: 20, run_number: 20, head_sha: head, head_branch: 'feature/example', event: 'pull_request',
    pull_requests: [{ number: 7, head: pr.head, base: pr.base }] };
  const plan = createVerificationPlan({ files, event: 'pull_request', sha: head, base });
  const job = (name, run, extra = {}) => ({ name, ...status, run_id: run.id, run_attempt: 1, head_sha: run.head_sha,
    started_at: start, completed_at: end, ...extra });
  const jobs = [
    job('plan', prRun),
    ...plan.groups.map(name => job(name, prRun)),
    job(plan.full_model_oci ? 'full-model-oci / Run pinned Full model lifecycle on rootless Podman' : 'full-model-oci', prRun,
      plan.full_model_oci ? {} : { conclusion: 'skipped' }),
    job('certification', prRun, { steps: [{ name: 'Certify every required exact-source matrix element', ...status }] }),
  ];
  const artifacts = [];
  const contents = new Map();
  const add = (name, content) => {
    const item = { id: artifacts.length + 100, name, expired: false, digest, size_in_bytes: 100,
      created_at: '2026-11-17T10:01:00Z', workflow_run: { id: prRun.id, head_sha: head } };
    artifacts.push(item);
    contents.set(item.id, content);
    return item;
  };
  add('ci-plan', plan);
  const profileArtifacts = Object.fromEntries(['core', 'full'].filter(profile => plan.groups.includes('build-' + profile))
    .map(profile => [profile, add('ci-profile-build-' + profile, null)]));
  const reports = new Map(plan.groups.map(group => [group, { group, sha: head, planDigest: planDigest(plan),
    results: VERIFICATION_GROUPS[group].filter(task => plan.tasks.includes(task)).map(task => ({ task, status: 'passed' })) }]));
  const evidence = new Map([...reports].map(([group, report]) => [group, add('ci-evidence-' + group, report)]));
  const native = evidence.get('hosted-native-catalog');
  for (const [group, report] of reports) {
    const profile = requiredBuildProfile(group);
    if (profile) {
      report.profileArtifact = { profile, sourceSha: head, planDigest: planDigest(plan), runId: String(prRun.id),
        producerJob: 'build-' + profile, producerAttempt: 1, artifactId: profileArtifacts[profile].id, artifactDigest: digest };
    }
    if (group === 'hosted-native-catalog') {
      report.nativeProducer = { identity: { sourceSha: head, planDigest: planDigest(plan), runId: String(prRun.id), producerJob: group, producerAttempt: 1 },
        reportSha256: 'f'.repeat(64), runtimeBaseDigest: digest, buildKitDigest: digest };
    } else if (group.startsWith('hosted-native-')) {
      report.nativeArtifact = { sourceSha: head, planDigest: planDigest(plan), runId: String(prRun.id), producerJob: 'hosted-native-catalog',
        producerAttempt: 1, artifactId: native.id, artifactDigest: digest, reportSha256: 'f'.repeat(64), runtimeBaseDigest: digest, buildKitDigest: digest };
    }
  }
  const state = { pr, prRun, currentRun, jobs, artifacts, contents, reports, runs: [prRun], mergedPulls: [pr] };
  const page = (key, values) => ({ total_count: values.length, [key]: values });
  const request = async endpoint => {
    if (endpoint.startsWith('actions/workflows/')) {
      assert.ok(endpoint.includes('head_sha=' + head));
      return page('workflow_runs', state.runs);
    }
    if (endpoint === 'pulls/7') return state.pr;
    if (endpoint === 'commits/' + sourceSha + '/pulls?per_page=100&page=1') return state.mergedPulls;
    if (endpoint.startsWith('actions/runs/20/jobs?')) return page('jobs', state.jobs);
    if (endpoint.startsWith('actions/runs/20/artifacts?')) return page('artifacts', state.artifacts);
    throw new Error('unexpected API endpoint: ' + endpoint);
  };
  const args = { sourceSha, before: base, repository, currentRun, git, request, readArtifact: async item => structuredClone(state.contents.get(item.id)) };
  return { state, args, plan, git };
}

test('same-tree complete PR proof certifies the merged source with exact artifact identities', async () => {
  const { args, plan } = fixture();
  const receipt = await verifyReusableMainProof(args);
  assert.equal(receipt.mode, 'full');
  assert.equal(receipt.sourceSha, sourceSha);
  assert.equal(receipt.evidence.length, plan.groups.length);
  assert.equal(receipt.prNumber, 7);
  assert.equal(receipt.tree, tree);
});

test('closed PR runs with cleared associations resolve only the actual merged PR', async () => {
  const { state, args } = fixture();
  state.prRun.pull_requests = [];
  assert.equal((await verifyReusableMainProof(args)).prNumber, 7);
  state.mergedPulls = [];
  await assert.rejects(verifyReusableMainProof(args), /merge commit PR association/);
  state.mergedPulls = [state.pr, { ...state.pr, number: 8 }];
  await assert.rejects(verifyReusableMainProof(args), /merge commit PR association/);
});

test('an affected plan cannot silently replace omitted main obligations', async () => {
  const affected = fixture(['docs/README.md']);
  await assert.rejects(verifyReusableMainProof(affected.args), /Affected PR proof/);
});

test('merge identity rejects direct push, wrong first parent, stale base and changed tree', () => {
  const { git } = fixture();
  assert.equal(mergeCandidate(sourceSha, base, git).tree, tree);
  assert.throws(() => mergeCandidate(sourceSha, 'e'.repeat(40), git), /exactly one merge/);
  assert.throws(() => mergeCandidate(sourceSha, base, args => args[0] === 'rev-list' ? sourceSha + ' ' + base : git(args)), /two-parent/);
  assert.throws(() => mergeCandidate(sourceSha, base, args => args[0] === 'merge-base' ? head : git(args)), /not based/);
  assert.throws(() => mergeCandidate(sourceSha, base, args => args[1] === head + '^{tree}' ? base : git(args)), /differs/);
});

test('actual merged diff and original base must equal the canonical PR plan', () => {
  const { git, plan } = fixture();
  const candidate = mergeCandidate(sourceSha, base, git);
  assert.doesNotThrow(() => assertCandidatePlan(plan, candidate));
  assert.throws(() => assertCandidatePlan(createVerificationPlan({ ...plan, base: tree }), candidate), /merged base/);
  assert.throws(() => assertCandidatePlan(createVerificationPlan({ ...plan, files: ['docs/other.md'] }), candidate), /actual merge diff/);
});

test('rejected proof paths fail closed instead of accepting an older green or incomplete result', async () => {
  const mutations = [
    s => { s.pr.merged = false; },
    s => { s.prRun.pull_requests[0].base.sha = tree; },
    s => { s.pr.merge_commit_sha = base; },
    s => { s.pr.head = { ...s.pr.head, repo: { id: 999 } }; },
    s => { s.prRun.head_repository = { id: 999 }; },
    s => { s.prRun.head_branch = 'unrelated'; },
    s => { s.prRun.conclusion = 'failure'; },
    s => { s.runs.push({ ...s.prRun, id: 21, run_number: 21, conclusion: 'cancelled' }); },
    s => { s.runs.push({ ...s.prRun, id: 21, run_number: 21, status: 'in_progress', conclusion: null }); },
    s => { s.prRun.run_attempt = 2; },
    s => { s.jobs = s.jobs.filter(job => job.name !== 'certification'); },
    s => { s.jobs.find(job => job.name === 'certification').steps[0].conclusion = 'skipped'; },
    s => { s.jobs.find(job => job.name === 'certification').completed_at = '2026-11-17T10:07:00Z'; },
    s => { s.artifacts[0].expired = true; },
    s => { s.artifacts[0].digest = 'bad'; },
    s => { s.artifacts = s.artifacts.filter(item => !item.name.startsWith('ci-evidence-')); },
    s => { [...s.reports.values()][0].results[0].status = 'failed'; },
  ];
  for (const mutate of mutations) {
    const { state, args } = fixture();
    mutate(state);
    await assert.rejects(verifyReusableMainProof(args), undefined, String(mutate));
  }
});

test('selected producer and Full-model evidence must still be valid for full proof', async () => {
  const { state, args } = fixture(['package.json']);
  state.jobs.find(job => job.name.startsWith('full-model-oci / ')).conclusion = 'failure';
  await assert.rejects(verifyReusableMainProof(args), /Full-model proof/);
  const next = fixture(['package.json']);
  next.state.reports.get('browser-core-writing').profileArtifact.artifactId = 999;
  await assert.rejects(verifyReusableMainProof(next.args), /stale producer artifact/);
});

test('compact certification cannot proceed on a failed plan or executed heavy family', () => {
  const needs = Object.fromEntries(['plan', 'unit', 'types', 'build', 'oci', 'browser', 'hosted_catalog', 'hosted'].map(name =>
    [name, { result: name === 'plan' ? 'success' : 'skipped' }]));
  assert.doesNotThrow(() => assertCompactNeeds(needs));
  assert.throws(() => assertCompactNeeds({ ...needs, plan: { result: 'failure' } }));
  assert.throws(() => assertCompactNeeds({ ...needs, build: { result: 'success' } }));
});


function dedicatedFixture(workflowPath, files, extraSteps = []) {
  const { state, args } = fixture(files);
  const definition = DEDICATED_PROOFS[workflowPath];
  const model = workflowPath === '.github/workflows/full-model-oci-acceptance.yml';
  state.currentRun.path = workflowPath;
  if (model) state.currentRun.workflow_id = 43;
  else state.prRun.path = workflowPath;
  const job = { ...state.jobs[0], name: definition.job, id: 500, steps: [...definition.steps, ...extraSteps].map(name => ({ name, ...status })) };
  if (model) {
    state.jobs = state.jobs.filter(item => !item.name.startsWith('full-model-oci'));
    state.jobs.push(job);
  } else state.jobs = [job];
  const request = args.request;
  args.request = endpoint => endpoint === 'actions/workflows/verify.yml' ? Promise.resolve({ id: workflow_id, path: workflowPath === '.github/workflows/full-model-oci-acceptance.yml' ? '.github/workflows/verify.yml' : workflowPath }) : request(endpoint);
  return { state, args, job };
}

test('independent runtime proof is reused only for the exact successful PR job and steps', async () => {
  const { state, args, job } = dedicatedFixture('.github/workflows/ansible-runtime-contract.yml', ['deploy/updater/standalone-host.mjs']);
  const receipt = await verifyReusableDedicatedProof(args);
  assert.equal(receipt.jobId, 500);
  assert.equal(receipt.sourceSha, sourceSha);
  job.steps.find(step => step.name.startsWith('Exercise generated')).conclusion = 'skipped';
  await assert.rejects(verifyReusableDedicatedProof(args), /Required proof step/);
  job.steps.find(step => step.name.startsWith('Exercise generated')).conclusion = 'success';
  state.prRun.run_attempt = 2;
  await assert.rejects(verifyReusableDedicatedProof(args), /latest attempt/);
});

test('infrastructure reuse requires actual selected scopes rather than a green skipped step', async () => {
  const ansible = dedicatedFixture('.github/workflows/deployment-config.yml', ['deploy/ansible/site.yml'], ['Check standalone Ansible configuration']);
  assert.equal((await verifyReusableDedicatedProof(ansible.args)).jobId, 500);
  const terraform = dedicatedFixture('.github/workflows/deployment-config.yml', ['deploy/cloudflare/terraform/main.tf'], ['Check all Terraform files', 'Validate Cloudflare Terraform']);
  assert.equal((await verifyReusableDedicatedProof(terraform.args)).jobId, 500);
  const mixed = dedicatedFixture('.github/workflows/deployment-config.yml', ['deploy/ansible/site.yml', 'deploy/cloudflare/terraform/main.tf'], ['Check standalone Ansible configuration']);
  await assert.rejects(verifyReusableDedicatedProof(mixed.args), /Terraform/);
});

test('standalone main model job reuses only the successful Verify PR caller lifecycle proof', async () => {
  const { args, job } = dedicatedFixture('.github/workflows/full-model-oci-acceptance.yml', ['package.json']);
  const receipt = await verifyReusableDedicatedProof(args);
  assert.equal(receipt.proofWorkflowPath, '.github/workflows/verify.yml');
  job.steps.find(step => step.name === 'Fail on missing or altered model cache files').conclusion = 'failure';
  await assert.rejects(verifyReusableDedicatedProof(args), /Required proof step/);
});


test('standalone backup main reuse requires real pre-merge encrypted restore and cleanup proof', async () => {
  const workflowPath = '.github/workflows/standalone-backup.yml';
  const { state, args, job } = dedicatedFixture(workflowPath, ['deploy/updater/standalone-backup.sh']);
  const receipt = await verifyReusableDedicatedProof(args);
  assert.equal(receipt.workflowPath, workflowPath);
  assert.equal(receipt.proofWorkflowPath, workflowPath);
  assert.equal(receipt.jobId, 500);
  for (const step of job.steps) {
    step.conclusion = 'skipped';
    await assert.rejects(verifyReusableDedicatedProof(args), /Required proof step/);
    step.conclusion = 'success';
  }
  state.prRun.run_attempt = 2;
  await assert.rejects(verifyReusableDedicatedProof(args), /latest attempt/);
  state.prRun.run_attempt = 1;
  job.completed_at = '2026-11-17T10:07:00Z';
  await assert.rejects(verifyReusableDedicatedProof(args), /completed after merge/);
  job.completed_at = end;
  state.prRun.conclusion = 'failure';
  await assert.rejects(verifyReusableDedicatedProof(args), /not successful/);
});
