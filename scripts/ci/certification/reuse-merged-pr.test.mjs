import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { mergeCandidate, assertCandidatePlan, assertCompactNeeds, readReusableMainEvidence, selectMergedTaskReuse, verifyReusableMainProof, verifyReusableDedicatedProof, DEDICATED_PROOFS } from './reuse-merged-pr.mjs';
import { createVerificationPlan, planDigest, validateVerificationPlan } from '../impact/plan.mjs';
import { taskInvocation } from '../evidence/task-inputs.mjs';
import { VERIFICATION_GROUPS, requiredBuildProfile } from '../impact/contract.mjs';

const sourceSha = 'a'.repeat(40), base = 'b'.repeat(40), head = 'c'.repeat(40), tree = 'd'.repeat(40);
const repository = 'yohn-jp/codexia', repo = { id: 123, full_name: repository, owner: { id: 10 } }, workflow_id = 42;
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
      created_at: '2026-11-17T10:01:00Z', workflow_run: { id: prRun.id, head_sha: head, repository_id: repo.id, head_repository_id: repo.id } };
    artifacts.push(item);
    contents.set(item.id, content);
    return item;
  };
  add('ci-plan', plan);
  const profileArtifacts = Object.fromEntries(['core', 'full'].filter(profile => plan.groups.includes('build-' + profile))
    .map(profile => [profile, add('ci-profile-build-' + profile, null)]));
  const reports = new Map(plan.groups.map(group => [group, { group, sha: head, planDigest: planDigest(plan),
    results: VERIFICATION_GROUPS[group].filter(task => plan.tasks.includes(task)).map(task => ({ task, status: 'passed' })) }]));
  for (const [group, report] of reports) add('ci-evidence-' + group, report);
  for (const [group, report] of reports) {
    const profile = requiredBuildProfile(group);
    if (profile) {
      report.profileArtifact = { profile, sourceSha: head, planDigest: planDigest(plan), runId: String(prRun.id),
        producerJob: 'build-' + profile, producerAttempt: 1, artifactId: profileArtifacts[profile].id, artifactDigest: digest };
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
    if (endpoint.startsWith('commits/' + sourceSha + '/pulls?')) return state.mergedPulls;
    if (endpoint.startsWith('actions/runs/20/jobs?')) return page('jobs', state.jobs);
    if (endpoint.startsWith('actions/runs/20/artifacts?')) return page('artifacts', state.artifacts);
    throw new Error('unexpected API endpoint: ' + endpoint);
  };
  request.paginate = async (endpoint, parameters = {}, key = null) => {
    const url = new URL(endpoint, 'https://api.github.com/');
    for (const [name, value] of Object.entries({ ...parameters, per_page: 100, page: 1 })) url.searchParams.set(name, String(value));
    const prefix = '/repos/yohn-jp/codexia/';
    const pathname = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname.slice(1);
    const result = await request(pathname + url.search);
    return key === null ? result : result[key];
  };
  const args = { sourceSha, before: base, repository, currentRun, git, request, readArtifact: async item => structuredClone(state.contents.get(item.id)) };
  return { state, args, plan, git };
}

test('same-tree certification returns the exact plan and reports it verified alongside the compact receipt', async t => {
  const { args, plan, state } = fixture();
  const readArtifact = t.mock.fn(args.readArtifact);
  const { receipt, plan: verifiedPlan, reports } = await readReusableMainEvidence({ ...args, readArtifact });
  assert.deepEqual(verifiedPlan, plan);
  assert.deepEqual(reports, [...state.reports.values()]);
  assert.deepEqual(readArtifact.mock.calls.map(call => call.arguments[0].id),
    [receipt.planArtifact.id, ...receipt.evidence.map(item => item.id)]);
  assert.equal(receipt.mode, 'full');
  assert.equal(receipt.sourceSha, sourceSha);
  assert.equal(receipt.evidence.length, plan.groups.length);
  assert.equal(receipt.prNumber, 7);
  assert.equal(receipt.tree, tree);
});

test('compact main proof accepts a full PR plan with optional coverage reuse and rejects unknown metadata', async () => {
  const { args, plan, state } = fixture();
  const artifact = state.artifacts.find(item => item.name === 'ci-plan');
  const coverage = { task: 'coverage', sourceSha: base, proofSourceSha: base, planDigest: '1'.repeat(64),
    workflowRunId: 10, workflowAttempt: 1, workflowId: workflow_id, repositoryId: repo.id, jobId: 40, workflowJob: 'types',
    artifactId: 50, artifactName: 'ci-evidence-types-tests', artifactDigest: digest,
    inputClosure: Object.fromEntries(['source', 'tests', 'dependencies', 'environment', 'toolchain', 'recipe', 'producers']
      .map(input => [input, '2'.repeat(64)])),
    runtime: { platform: 'linux', arch: 'x64', nodeVersion: 'v24.22.3', execPath: '/opt/node/bin/node',
      cwd: '/home/runner/work/codexia/codexia', imageOS: null, imageVersion: null },
    certification: { sourceSha: base, workflowRunId: 10, workflowAttempt: 1, workflowId: workflow_id, repositoryId: repo.id,
      jobId: 41, step: 'Certify every required exact-source matrix element' } };
  state.contents.set(artifact.id, { ...plan, coverageReuse: coverage });
  assert.equal((await verifyReusableMainProof(args)).planDigest, planDigest(plan));
  state.contents.set(artifact.id, { ...plan, taskInputReuse: { coverage } });
  await assert.rejects(verifyReusableMainProof(args), /canonical impact rules/);
});

test('compact main evidence resolves from an exact PR checkout without relaxing main identity', async () => {
  const { args, git } = fixture();
  const currentPrHead = 'f'.repeat(40);
  const prGit = command => command[0] === 'rev-parse' && command[1] === 'HEAD'
    ? currentPrHead + '\n' : git(command);
  await assert.rejects(verifyReusableMainProof({ ...args, git: prGit }), /Checkout is not the expected exact source/);
  const receipt = await verifyReusableMainProof({ ...args, git: prGit, checkoutSha: currentPrHead });
  assert.equal(receipt.sourceSha, sourceSha);
  assert.equal(receipt.headSha, head);
  await assert.rejects(verifyReusableMainProof({ ...args, git: prGit, checkoutSha: base }),
    /Checkout is not the expected exact source/);
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

test('merge identity uses actual Git ancestry and rejects missing history or altered trees', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-merge-proof-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runGit = (args, cwd = directory) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const git = args => runGit(args);
  git(['init', '--quiet', '--initial-branch=main']);
  git(['config', 'user.email', 'fixture@example.test']);
  git(['config', 'user.name', 'CI fixture']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['commit', '--quiet', '--allow-empty', '-m', 'Base']);
  const originalBase = git(['rev-parse', 'HEAD']).trim();
  git(['switch', '--quiet', '-c', 'candidate']);
  await writeFile(path.join(directory, 'candidate.txt'), 'tested content');
  git(['add', 'candidate.txt']);
  git(['commit', '--quiet', '-m', 'Tested candidate']);
  const originalHead = git(['rev-parse', 'HEAD']).trim();

  git(['switch', '--quiet', 'main']);
  git(['merge', '--quiet', '--no-ff', '--no-edit', 'candidate']);
  const originalMerge = git(['rev-parse', 'HEAD']).trim();
  assert.deepEqual(mergeCandidate(originalMerge, originalBase, git), {
    sourceSha: originalMerge, base: originalBase, head: originalHead,
    tree: git(['rev-parse', 'candidate^{tree}']).trim(), files: ['candidate.txt'],
  });
  assert.throws(() => mergeCandidate(originalMerge, originalHead, git), /exactly one merge/u);
  assert.throws(() => mergeCandidate(originalHead, originalBase, git, originalMerge), /two-parent/u);

  const shallow = path.join(directory, 'shallow');
  git(['clone', '--quiet', '--depth=1', pathToFileURL(directory).href, shallow]);
  assert.throws(() => mergeCandidate(originalMerge, originalBase, args => runGit(args, shallow)), /two-parent/u);

  git(['switch', '--quiet', '-c', 'changed', originalBase]);
  git(['merge', '--quiet', '--no-ff', '--no-commit', 'candidate']);
  await writeFile(path.join(directory, 'candidate.txt'), 'changed during merge');
  git(['add', 'candidate.txt']);
  git(['commit', '--quiet', '-m', 'Altered merge content']);
  assert.throws(() => mergeCandidate(git(['rev-parse', 'HEAD']).trim(), originalBase, git), /Merged tree differs/u);

  git(['switch', '--quiet', '-c', 'stale', originalBase]);
  await writeFile(path.join(directory, 'stale.txt'), 'based on old main');
  git(['add', 'stale.txt']);
  git(['commit', '--quiet', '-m', 'Stale candidate']);
  git(['switch', '--quiet', 'main']);
  git(['merge', '--quiet', '--no-ff', '--no-edit', 'stale']);
  assert.throws(() => mergeCandidate(git(['rev-parse', 'HEAD']).trim(), originalMerge, git), /PR head is not based/u);
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

test('merged PR source proof carries the verified merge time for artifact producer ordering', async () => {
  const { args } = fixture(['package.json']);
  const receipt = await verifyReusableMainProof(args);
  assert.equal(receipt.mergedAt, new Date(merged).toISOString());
  assert.equal(receipt.headRef,'feature/example');
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
  const needs = Object.fromEntries(['plan', 'biome', 'unit', 'types', 'profile_core', 'profile_full', 'oci'].map(name =>
    [name, { result: name === 'plan' ? 'success' : 'skipped' }]));
  assert.doesNotThrow(() => assertCompactNeeds(needs));
  assert.throws(() => assertCompactNeeds({ ...needs, plan: { result: 'failure' } }));
  assert.throws(() => assertCompactNeeds({ ...needs, profile_core: { result: 'success' } }));
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
  args.request.paginate = request.paginate;
  return { state, args, job };
}

test('infrastructure reuse requires actual selected scopes rather than a green skipped step', async () => {
  const ansible = dedicatedFixture('.github/workflows/deployment-config.yml', ['deploy/ansible/site.yml'], ['Check Ansible configuration']);
  assert.equal((await verifyReusableDedicatedProof(ansible.args)).jobId, 500);
  const terraform = dedicatedFixture('.github/workflows/deployment-config.yml', ['deploy/cloudflare/terraform/main.tf'], ['Check all Terraform files', 'Validate Cloudflare Terraform']);
  assert.equal((await verifyReusableDedicatedProof(terraform.args)).jobId, 500);
  const mixed = dedicatedFixture('.github/workflows/deployment-config.yml', ['deploy/ansible/site.yml', 'deploy/cloudflare/terraform/main.tf'], ['Check Ansible configuration']);
  await assert.rejects(verifyReusableDedicatedProof(mixed.args), /Terraform/);
  const shared = dedicatedFixture('.github/workflows/deployment-config.yml', ['scripts/shared/python-env.sh', 'deploy/cloudflare/terraform/main.tf'], ['Check all Terraform files', 'Validate Cloudflare Terraform']);
  await assert.rejects(verifyReusableDedicatedProof(shared.args), /Ansible/);
  for (const unit of ['deploy/systemd/codexia-api.socket', 'cmd/codexiactl/assets/codexia-cloudflared.service']) {
    const proof = dedicatedFixture('.github/workflows/deployment-config.yml', [unit], ['Check Ansible configuration']);
    assert.equal((await verifyReusableDedicatedProof(proof.args)).jobId, 500);
  }
});

test('standalone main model job reuses only the successful Verify PR caller lifecycle proof', async () => {
  const { args, job } = dedicatedFixture('.github/workflows/full-model-oci-acceptance.yml', ['package.json']);
  const receipt = await verifyReusableDedicatedProof(args);
  assert.equal(receipt.proofWorkflowPath, '.github/workflows/verify.yml');
  job.steps.find(step => step.name === 'Fail on missing or altered model cache files').conclusion = 'failure';
  await assert.rejects(verifyReusableDedicatedProof(args), /Required proof step/);
});


test('push backup reuse requires exact pre-merge lock and recovery proof', async () => {
  const workflowPath = '.github/workflows/push-backup.yml';
  const { state, args, job } = dedicatedFixture(workflowPath, ['deploy/backup/backup.sh']);
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

// Affected evidence may be inspected for task candidates but can never certify
// the complete main graph or turn absent execution receipts into successful tasks.
test('affected PR without original task receipts falls back to main execution', () => {
  const evidence = { receipt: { sourceSha: 'a'.repeat(40) }, plan: { mode: 'affected' },
    jobs: [{ name: 'types-sources', conclusion: 'success', run_attempt: 1 }],
    reports: [{ group: 'types-sources', workflowRunId: 1, workflowAttempt: 1, results: [] }] };
  assert.equal(selectMergedTaskReuse(evidence, () => true), undefined);
});

test('affected merged PR can contribute only original selected read-only task receipts', async () => {
  // Use the canonical selector to find an affected plan with a typecheck
  // obligation, rather than duplicating its workspace membership.
  const selected = fixture(['modules/story/src/story.test.ts']);
  if (selected.plan.mode !== 'affected') {
    assert.fail('Expected a module-only affected plan');
  }
  const evidence = await readReusableMainEvidence({ ...selected.args, allowAffected: true });
  const report = evidence.reports.find(item => item.group === 'types-sources');
  assert.ok(report);
  const runtime = { platform: 'linux', arch: 'x64', nodeVersion: 'v24.0.0', execPath: '/opt/node/bin/node',
    cwd: '/home/runner/work/codexia/codexia', imageOS: 'ubuntu24', imageVersion: 'fixture' };
  const closure = Object.fromEntries(['source', 'tests', 'dependencies', 'environment', 'toolchain', 'recipe', 'producers']
    .map(name => [name, 'e'.repeat(64)]));
  Object.assign(report, { workflowRunId: evidence.receipt.runId, workflowAttempt: evidence.receipt.attempt,
    workflowJob: 'types', workflowRef: '.github/workflows/verify.yml', workflowSha: head });
  for (const result of report.results) {
    const task = result.task;
    result.invocations = [taskInvocation(task, runtime.execPath)];
    result.inputProof = { format: 'codexia-ci-task-input-proof/v2', mode: 'task-execution', task, status: 'passed',
      sourceSha: report.sha, planDigest: report.planDigest, workflowRunId: report.workflowRunId,
      workflowAttempt: report.workflowAttempt, workflowJob: report.workflowJob, runtime, inputClosure: closure };
  }
  report.producerInventory = {
    format: 'codexia-ci-task-producer-inventory/v1', group: report.group,
    sourceSha: report.sha, planDigest: report.planDigest, workflowRunId: report.workflowRunId,
    workflowAttempt: report.workflowAttempt, workflowJob: report.workflowJob,
    workflowRef: report.workflowRef, workflowSha: report.workflowSha,
    runner: { os: 'Linux', arch: 'X64', nodeVersion: runtime.nodeVersion, imageOS: runtime.imageOS, imageVersion: runtime.imageVersion },
    selectedTasks: report.results.map(item => item.task),
    taskInvocations: report.results.map(({ task, status, invocations, inputProof }) => ({ task, status, invocations, inputProof })),
    groupInvocations: [],
  };
  const reusable = selectMergedTaskReuse(evidence, task => task.startsWith('typecheck-'));
  assert.ok(reusable?.proofs.length > 0);
  const main = createVerificationPlan({ files: selected.plan.files, event: 'push', sha: sourceSha, base });
  assert.deepEqual(validateVerificationPlan({ ...main, mergedTaskReuse: reusable }).tasks, main.tasks);
  assert.equal(planDigest({ ...main, mergedTaskReuse: reusable }), planDigest(main));
  assert.equal(selectMergedTaskReuse(evidence, () => false), undefined);
  report.workflowAttempt++;
  assert.equal(selectMergedTaskReuse(evidence, () => true), undefined);
});
