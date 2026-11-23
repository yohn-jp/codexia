import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { REQUIRED_VERIFICATION_JOBS, BROWSER_SHARDS, PROFILES, VERIFICATION_GROUPS, VERIFICATION_TASKS, requiresWorkspacePreparation } from './ci-contract.mjs';
import { browserRuntimeRequirements, PLAYWRIGHT_IMAGE_DIGESTS } from './ci-browser-image-digests.mjs';
import { createVerificationPlan, matchesFullModelOciPath } from './ci-impact.mjs';
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8'));
const fullModelWorkflow = parse(readFileSync(new URL('../.github/workflows/full-model-oci-acceptance.yml', import.meta.url), 'utf8'));
test('the certified graph covers every declared obligation within the twenty-job cap', () => {
  assert.ok(REQUIRED_VERIFICATION_JOBS.length <= 20, 'CI-CD.md caps certification at twenty jobs, including plan and certification');
  assert.deepEqual(Object.keys(workflow.jobs), ['plan', 'full_model_oci', 'unit', 'types', 'build', 'oci', 'browser', 'certification']);
  const tasks = Object.values(VERIFICATION_GROUPS).flat();
  assert.equal(new Set(tasks).size, tasks.length);
  assert.deepEqual(tasks.toSorted(), VERIFICATION_TASKS.toSorted());
  assert.ok(VERIFICATION_GROUPS['unit-core'].includes('db-contract'));
  assert.ok(VERIFICATION_TASKS.includes('db-contract'));
  assert.match(readFileSync(new URL('./ci-group.mjs', import.meta.url), 'utf8'), /CODEXIA_CI_REPORT_DIR: path\.join\(reportDirectory, task\)/u);
  assert.deepEqual(VERIFICATION_GROUPS['unit-architecture'], ['architecture-g5']);
  assert.equal(requiresWorkspacePreparation(['architecture-g5']), false);
  assert.equal(requiresWorkspacePreparation(['unit-root']), true);
  const runner = readFileSync(new URL('./ci-group.mjs', import.meta.url), 'utf8');
  assert.match(runner, /CODEXIA_ARCHITECTURE_EVIDENCE_DIR: path\.join\(reportDirectory, 'architecture'\)/u);
  assert.deepEqual(REQUIRED_VERIFICATION_JOBS, ['plan', ...Object.keys(VERIFICATION_GROUPS), 'certification']);
  for (const [family, axis] of [['unit', 'group'], ['types', 'group'], ['build', 'profile'], ['oci', 'profile']]) {
    assert.equal(workflow.jobs[family].strategy.matrix[axis], '${{ fromJSON(needs.plan.outputs.' + family + ') }}');
  }
  assert.equal(workflow.jobs.browser.strategy.matrix.include, '${{ fromJSON(needs.plan.outputs.browser) }}');
  const modelJob = workflow.jobs.full_model_oci;
  assert.equal(modelJob.name, 'full-model-oci');
  assert.equal(modelJob.uses, './.github/workflows/full-model-oci-acceptance.yml');
  assert.deepEqual(modelJob.needs, ['plan']);
  assert.equal(modelJob.if, "needs.plan.result == 'success' && needs.plan.outputs.full_model_oci == 'true'");
  assert.equal(modelJob['continue-on-error'], undefined);
  assert.equal(REQUIRED_VERIFICATION_JOBS.includes(modelJob.name), false);
  assert.equal(workflow.jobs.certification.needs.includes('full_model_oci'), false);
  assert.ok(VERIFICATION_GROUPS['types-tests'].includes('requirements-trace'));
  assert.equal(VERIFICATION_TASKS.filter(task => task === 'requirements-trace').length, 1);
  const strictdocSetup = workflow.jobs.types.steps.find(step => step.name === 'Install pinned StrictDoc and Chromium');
  assert.equal(strictdocSetup.if, "matrix.group == 'tests'");
  assert.match(strictdocSetup.run, /requirements\.lock\.txt/u);
  assert.match(strictdocSetup.run, /playwright install --with-deps chromium/u);
  const python = workflow.jobs.types.steps.find(step => step.uses === 'actions/setup-python@v6.1.0');
  assert.equal(python.if, "matrix.group == 'tests'");
  assert.equal(python.with['python-version'], '3.12');
  const typesCheckout = workflow.jobs.types.steps.find(step => step.uses === 'actions/checkout@v7.0.1');
  assert.equal(typesCheckout.with['fetch-depth'], "${{ matrix.group == 'tests' && '0' || '1' }}");
  const groupRunner = readFileSync(new URL('./ci-group.mjs', import.meta.url), 'utf8');
  assert.match(groupRunner, /CODEXIA_CI_SOURCE_SHA:\s*sha/u);
  assert.match(groupRunner, /CODEXIA_CI_TASK:\s*task/u);
  assert.match(groupRunner, /CODEXIA_CI_REPORT_DIR:\s*path\.join\(reportDirectory, task\)/u);
  assert.equal(Object.hasOwn(fullModelWorkflow.on, 'workflow_call'), true);
  assert.equal(Object.hasOwn(fullModelWorkflow.on, 'pull_request'), false);
  const apiUnitJob = workflow.jobs.unit;
  assert.equal(apiUnitJob.env.CODEXIA_AUTH_TEST_DATABASE_URL,
    'postgres://codexia:codexia@127.0.0.1:5432/codexia_auth_test');
  assert.equal(apiUnitJob.env.CODEXIA_AUTH_TEST_DISPOSABLE, '1');
  const authDatabase = apiUnitJob.steps.find(step => step.name === 'Create isolated Better Auth persistence database');
  assert.equal(authDatabase.if, "matrix.group == 'core'");
  assert.equal(authDatabase.env.POSTGRES_CONTAINER, '${{ job.services.postgres.id }}');
  assert.match(authDatabase.run, /createdb -U codexia codexia_auth_test/u);
  const modelJobConfig = fullModelWorkflow.jobs['full-model-oci'];
  assert.ok(!Object.values(modelJobConfig.env).some(value => String(value).includes('${{ runner.')));
  for (const stepName of [
    'Download the real model files from their pinned revisions',
    'Fail on missing or altered model cache files',
    'Run the real Full model OCI lifecycle acceptance',
  ]) {
    const step = modelJobConfig.steps.find(item => item.name === stepName);
    assert.equal(step.env.CODEXIA_P13_MODEL_CACHE, '${{ runner.temp }}/codexia-p13-model-cache', stepName);
  }
  assert.equal(modelJobConfig.steps.find(item => item.name === 'Download the real model files from their pinned revisions').env.HF_HOME,
    '${{ runner.temp }}/huggingface-home');
  const manifest = modelJobConfig.steps.find(item => item.id === 'model-manifest');
  assert.match(manifest.run, /sha256sum.*p13-model-files\.tsv/u);
  const restore = modelJobConfig.steps.find(item => item.id === 'model-cache');
  const save = modelJobConfig.steps.find(item => item.uses?.startsWith('actions/cache/save@'));
  assert.equal(restore.with.key, 'p13-full-models-ubuntu-26.04-manifest-${{ steps.model-manifest.outputs.digest }}');
  assert.equal(save.with.key, restore.with.key);
  assert.match(modelJobConfig.steps.find(item => item.name === 'Fail on missing or altered model cache files').run, /sha256sum --check --strict/u);
  assert.equal(modelJobConfig.steps.find(item => item.uses?.startsWith('actions/checkout@')).with.ref, '${{ github.event.pull_request.head.sha || github.sha }}');
});
test('HTTP contract sources select the dedicated unit and typecheck tasks', () => {
  const plan = createVerificationPlan({
    files: ['packages/http-contract/src/main.tsp'],
    event: 'pull_request',
    sha: 'a'.repeat(40),
    base: 'b'.repeat(40),
  });
  assert.equal(plan.mode, 'affected');
  assert.equal(plan.full_model_oci, true);
  assert.ok(plan.tasks.includes('unit-http-contract'));
  assert.ok(plan.tasks.includes('typecheck-http-contract'));
  assert.ok(plan.tasks.includes('test-types-packages'));
  assert.ok(plan.groups.includes('unit-core'));
  assert.ok(plan.groups.includes('types-sources'));
  assert.ok(!plan.tasks.includes('oci-full'));
  assert.ok(matchesFullModelOciPath('packages/api/src/server.ts'));
  assert.ok(matchesFullModelOciPath('packages/http-contract/openapi/codexia.openapi.yaml'));
});
test('browser groups depend on profile producers; independent groups cannot cancel other evidence', () => {
  assert.deepEqual(workflow.concurrency, {
    group: 'verify-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}',
    'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
  });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.plan.name, 'plan');
  for (const [id, job] of Object.entries(workflow.jobs).filter(([id]) => !['plan', 'certification', 'full_model_oci'].includes(id))) {
    assert.deepEqual(job.needs, id === 'browser' ? ['plan', 'build'] : ['plan'], id);
    assert.match(job.if, /needs\.plan\.result == 'success'/);
    assert.equal(job['continue-on-error'], undefined, id);
    assert.equal(job.strategy['fail-fast'], false, id);
    assert.ok(job.steps.some(step => step.run?.includes('ci-group.mjs')));
    assert.ok(job.steps.some(step => step.uses === 'actions/upload-artifact@v7.0.2' && step.if === 'always()'));
  }
  const gate = workflow.jobs.certification;
  assert.equal(gate.if, '${{ always() && !cancelled() }}');
  assert.deepEqual(gate.needs.toSorted(), ['plan', 'unit', 'types', 'build', 'oci', 'browser'].toSorted());
  const planSelector = gate.steps.find(step => step.id === 'select-plan');
  const planDownload = gate.steps.find(step => step.uses === 'actions/download-artifact@v8.0.2' && step.with?.path === '${{ runner.temp }}/ci-plan');
  const evidenceSelector = gate.steps.find(step => step.id === 'select-evidence');
  const evidenceDownload = gate.steps.find(step => step.name === 'Download selected execution evidence by exact artifact ID');
  assert.ok(planSelector);
  assert.ok(planDownload);
  assert.match(planSelector.run, /node scripts\/select-ci-plan\.mjs/);
  assert.equal(planSelector.env.GITHUB_RUN_ID, '${{ github.run_id }}');
  assert.equal(planSelector.env.CODEXIA_EXPECTED_SHA, '${{ github.event.pull_request.head.sha || github.sha }}');
  assert.equal(planDownload.with['artifact-ids'], '${{ steps.select-plan.outputs.artifact-id }}');
  assert.equal(planDownload.with['merge-multiple'], true);
  assert.ok(evidenceSelector);
  assert.match(evidenceSelector.run, /node scripts\/select-ci-evidence\.mjs/);
  assert.equal(evidenceSelector.env.GITHUB_RUN_ID, '${{ github.run_id }}');
  assert.equal(evidenceSelector.env.CODEXIA_CI_INVENTORY_PATH, '${{ steps.select-plan.outputs.inventory-path }}');
  assert.equal(evidenceSelector.env.CODEXIA_EXPECTED_SHA, '${{ github.event.pull_request.head.sha || github.sha }}');
  assert.ok(evidenceDownload);
  assert.equal(evidenceDownload.with['artifact-ids'], '${{ steps.select-evidence.outputs.artifact-ids }}');
  assert.equal(evidenceDownload.with.path, '${{ runner.temp }}/ci-evidence/${{ steps.select-evidence.outputs.artifact-subdirectory }}');
  assert.ok(gate.steps.indexOf(planSelector) < gate.steps.indexOf(planDownload));
  assert.ok(gate.steps.indexOf(planDownload) < gate.steps.indexOf(evidenceSelector));
  assert.ok(gate.steps.indexOf(evidenceSelector) < gate.steps.indexOf(evidenceDownload));
  assert.equal(evidenceDownload.uses, 'actions/download-artifact@v8.0.2');
});
test('browser groups retain immutable runtime and restore the exact producer before running selected shards', () => {
  const browser = workflow.jobs.browser;
  const { webkit: mcrDigest, chromium: chromiumDigest } = PLAYWRIGHT_IMAGE_DIGESTS;
  assert.match(mcrDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(chromiumDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(mcrDigest, chromiumDigest, 'Single-browser and multi-browser images must remain distinct');
  assert.equal(browser.container.image, [
    "${{ endsWith(matrix.group, '-webkit') && 'mcr.microsoft.com/playwright@",
    mcrDigest,
    "' || format('ghcr.io/{0}/playwright-ubuntu-chromium@",
    chromiumDigest,
    "', github.repository) }}",
  ].join(''));
  assert.equal(browser.container.options, '--init --ipc=host');
  assert.deepEqual(browser.container.credentials, {
    username: "${{ endsWith(matrix.group, '-webkit') && '' || github.actor }}",
    password: "${{ endsWith(matrix.group, '-webkit') && '' || secrets.GITHUB_TOKEN }}",
  });
  assert.equal(browser.permissions.packages, 'read');
  assert.equal(browser.env.CODEXIA_CI_BROWSER_GROUP, '${{ matrix.group }}');
  assert.equal(browser.env.CODEXIA_PLAYWRIGHT_IMAGE_DIGEST, [
    "${{ endsWith(matrix.group, '-webkit') && '", mcrDigest,
    "' || '", chromiumDigest, "' }}",
  ].join(''));
  const diagnostics = browser.steps.find(step => step.uses === 'actions/upload-artifact@v7.0.2' && step.with.name.startsWith('playwright-failure-'));
  assert.ok(diagnostics);
  assert.equal(diagnostics.if, 'always()');
  assert.match(diagnostics.with.name, /playwright-failure-\$\{\{ matrix\.group \}\}-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(diagnostics.with.path, /tests\/e2e\/test-results\/\*\*\/trace\.zip/);
  assert.match(diagnostics.with.path, /tests\/e2e\/test-results\/\*\*\/error-context\.md/);
  assert.match(diagnostics.with.path, /tests\/e2e\/test-results\/\*\*\/journal-draft-\*-diagnostic\.json/);
  assert.equal(diagnostics.with['if-no-files-found'], 'ignore');
  const runnerIndex = browser.steps.findIndex(step => step.run?.includes('ci-group.mjs'));
  const diagnosticsIndex = browser.steps.indexOf(diagnostics);
  const reportIndex = browser.steps.findIndex(step => step.uses === 'actions/upload-artifact@v7.0.2' && step.with.name.startsWith('ci-evidence-browser-'));
  assert.ok(runnerIndex < diagnosticsIndex && diagnosticsIndex < reportIndex);
  const runner = readFileSync(new URL('./ci-group.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(runner, /(?:apt(?:-get)?\s|playwright install|--with-deps)/);
  assert.match(browser.if, /always\(\)/);
  const restore = browser.steps.find(step => step.id === 'restore-profile');
  assert.ok(restore);
  assert.match(restore.run, /ci-profile-artifact\.mjs restore/);
  assert.equal(browser.permissions['actions'], 'read');
  assert.match(restore.run,/\$CODEXIA_CI_PROFILE_RECEIPT/);
  assert.equal(restore.env.CODEXIA_CI_PROFILE_RECEIPT, browser.steps[runnerIndex].env.CODEXIA_CI_PROFILE_RECEIPT);
  assert.equal(browser.steps[runnerIndex].env.CODEXIA_CI_PROFILE_RESTORE, '${{ steps.restore-profile.outcome }}');
  assert.ok(browser.steps.indexOf(restore) < runnerIndex);
  const producer = workflow.jobs.build.steps.find(step => step.run?.includes('ci-profile-artifact.mjs pack'));
  assert.ok(producer);
  assert.ok(workflow.jobs.build.steps.some(step => step.uses === 'actions/upload-artifact@v7.0.2' && step.with.name === 'ci-profile-build-${{ matrix.profile }}'));
  assert.doesNotMatch(runner, /run\('pnpm', \['build'\], \{ CODEXIA_PROFILE: group/);
  assert.match(runner, /run-browser-shard\.mjs.*--prebuilt/);
});

test('browser runtime requirements distinguish Chromium and mixed browser lanes', () => {
  for (const profile of PROFILES) {
    for (const lane of ['writing', 'reference']) {
      const requirements = browserRuntimeRequirements(`browser-${profile}-${lane}`);
      assert.deepEqual(requirements.projects, new Set(['chromium']));
      assert.equal(requirements.imageDigest, PLAYWRIGHT_IMAGE_DIGESTS.chromium);
    }
    const mixed = browserRuntimeRequirements(`browser-${profile}-webkit`);
    assert.deepEqual(mixed.projects, new Set(['chromium', 'webkit']));
    assert.equal(mixed.imageDigest, PLAYWRIGHT_IMAGE_DIGESTS.webkit);
    assert.ok(VERIFICATION_GROUPS[`browser-${profile}-webkit`].includes(`browser-${profile}-ui-v1`));
  }
  assert.throws(() => browserRuntimeRequirements('browser-preview-writing'), /Unknown CI browser group/u);
});

test('browser consumers report blocked tasks without launching a child on missing or foreign producer proof', t => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const sha = execFileSync('git', ['-c', `safe.directory=${cwd}`, 'rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const plan = createVerificationPlan({ files: null, event: 'workflow_dispatch', sha });
  const directory = mkdtempSync(path.join(tmpdir(), 'codexia-browser-producer-proof-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const planFile = path.join(directory, 'plan.json');
  const receiptFile = path.join(directory, 'profile.json');
  writeFileSync(planFile, JSON.stringify(plan));
  writeFileSync(receiptFile, JSON.stringify({ profile: 'core', sourceSha: '0'.repeat(40) }));

  for (const [restore, failure] of [
    ['failure', /Profile build\/restore prerequisite failed/u],
    ['success', /Profile receipt source mismatch/u],
  ]) {
    const reportDirectory = path.join(directory, restore);
    const result = spawnSync(process.execPath, ['scripts/ci-group.mjs', 'browser-core-writing'], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEXIA_CI_PLAN_PATH: planFile,
        CODEXIA_CI_REPORT_DIR: reportDirectory,
        CODEXIA_CI_PROFILE_RESTORE: restore,
        CODEXIA_CI_PROFILE_RECEIPT: receiptFile,
        CODEXIA_CI_BROWSER_GROUP: 'invalid-test-lane',
        GITHUB_RUN_ID: '7',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'browser',
        GITHUB_WORKFLOW_REF: 'fixture/verify.yml@main',
        GITHUB_WORKFLOW_SHA: sha,
        GITHUB_STEP_SUMMARY: '',
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(readFileSync(path.join(reportDirectory, 'report.json'), 'utf8'));
    assert.ok(report.results.some(task => task.task === 'browser-core-core'));
    assert.deepEqual(report.producerInventory.groupInvocations, []);
    for (const task of report.results) {
      assert.equal(task.status, 'blocked', task.task);
      assert.match(task.error, failure);
      assert.deepEqual(task.invocations, []);
    }
  }
});
test('all source checkouts bind exact PR head/main source without persisted credentials', () => {
  for (const job of Object.values(workflow.jobs).filter(job => job.uses !== './.github/workflows/full-model-oci-acceptance.yml')) {
    const checkout = job.steps.find(step => step.uses === 'actions/checkout@v7.0.1');
    assert.equal(checkout.with.ref, '${{ github.event.pull_request.head.sha || github.sha }}');
    assert.equal(checkout.with['persist-credentials'], false);
    const execution = job.steps.find(step => /node scripts\/(?:ci-impact|ci-group|certify-ci)\.mjs/.test(step.run ?? ''));
    assert.equal(execution.env.CODEXIA_CI_PLAN_PATH, '${{ runner.temp }}/ci-plan/ci-plan.json');
    for (const step of job.steps.filter(step => step.uses === 'actions/download-artifact@v8.0.2' && step.with.name === 'ci-plan')) {
      assert.equal(step.with.path, '${{ runner.temp }}/ci-plan');
    }
  }
});

test('every default browser spec is assigned a Chromium shard and WebKit UI is preserved', () => {
  const directory = fileURLToPath(new URL('../tests/e2e/', import.meta.url));
  const discover = current => readdirSync(current, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(current, entry.name);
    return entry.isDirectory() && entry.name !== 'test-results'
      ? discover(full)
      : entry.isFile() && /\.spec\.tsx?$/.test(entry.name) ? [path.relative(directory, full)] : [];
  });
  // This host acceptance requires a separate external lifecycle environment.
  const hostOnly = 'core64-lifecycle.host.acceptance.spec.ts';
  const specs = discover(directory).filter(file => file !== hostOnly);
  assert.deepEqual(specs.toSorted(), BROWSER_SHARDS.filter(shard => shard.project === 'chromium').map(shard => shard.file).toSorted());
  assert.deepEqual(BROWSER_SHARDS.filter(shard => shard.project === 'webkit').map(shard => shard.file), ['ui-v1.acceptance.spec.ts']);
  const config = readFileSync(new URL('../tests/e2e/playwright.config.ts', import.meta.url), 'utf8');
  assert.match(config, /testIgnore: "\*\*\/core64-lifecycle\.host\.acceptance\.spec\.ts"/);
  assert.match(config, /fullyParallel: false/);
  assert.match(config, /workers: 1/);
});

test('browser lanes cover each profile and use compatible browser images', () => {
  for (const profile of PROFILES) {
    const prefix = `browser-${profile}-`;
    const writing = VERIFICATION_GROUPS[prefix + 'writing'];
    const reference = VERIFICATION_GROUPS[prefix + 'reference'];
    const webkit = VERIFICATION_GROUPS[prefix + 'webkit'];
    const tasks = [...writing, ...reference, ...webkit];
    assert.deepEqual(tasks.toSorted(), BROWSER_SHARDS.map(shard => prefix + shard.id).toSorted());
    for (const shard of BROWSER_SHARDS.filter(shard => shard.project === 'webkit')) {
      assert.ok(webkit.includes(prefix + shard.id), 'WebKit must run on the multi-browser image');
    }
    assert.ok(BROWSER_SHARDS.some(shard => shard.project === 'chromium' && webkit.includes(prefix + shard.id)));
    assert.equal(reference.at(-1), prefix + 'redesign-visual', 'Keep visual measurements after the parallel shards');
  }
});



test('compact main proof is resolved only on main push, skips all heavy families and independently certifies', async () => {
  const { REUSED_MAIN_SKIPPED_JOBS, REUSED_MAIN_CERT_STEP } = await import('./release-policy.mjs');
  const plan = workflow.jobs.plan;
  const reuse = plan.steps.find(step => step.id === 'reuse');
  assert.equal(reuse.if, "github.event_name == 'push' && github.ref == 'refs/heads/main'");
  assert.equal(reuse.run, 'node scripts/reuse-pr-verification.mjs plan');
  assert.equal(plan.permissions.actions, 'read');
  assert.equal(plan.permissions['pull-requests'], 'read');
  const families = ['unit', 'types', 'build', 'oci', 'browser'];
  for (const name of families) assert.match(workflow.jobs[name].if, /needs\.plan\.outputs\.reuse != 'true'/);
  assert.deepEqual(REUSED_MAIN_SKIPPED_JOBS, ['full_model_oci', ...families].map(name => workflow.jobs[name].name));
  const gate = workflow.jobs.certification;
  assert.equal(gate.permissions['pull-requests'], 'read');
  const reused = gate.steps.find(step => step.name === REUSED_MAIN_CERT_STEP);
  assert.equal(reused.if, "needs.plan.outputs.reuse == 'true'");
  assert.equal(reused.run, 'node scripts/reuse-pr-verification.mjs certify');
  assert.equal(reused.env.CODEXIA_REUSE_RECEIPT, undefined);
  assert.equal(gate.steps.find(step => step.name === 'Certify every required exact-source matrix element').if, "needs.plan.outputs.reuse != 'true'");
  assert.equal(gate.steps.some(step => step.with?.name === 'ci-reuse-proof'), false);
});


test('independent main verification reuses exact PR proof without disabling PR or manual execution', async () => {
  const { DEDICATED_PROOFS } = await import('./reuse-pr-verification.mjs');
  for (const [filename, proof] of Object.entries(DEDICATED_PROOFS)) {
    const definition = parse(readFileSync(new URL('../' + filename, import.meta.url), 'utf8'));
    const job = Object.values(definition.jobs)[0];
    const gate = job.steps.find(step => step.id === 'reuse');
    assert.equal(gate.if, "github.event_name == 'push' && github.ref == 'refs/heads/main'");
    assert.equal(gate.run, 'node scripts/reuse-pr-verification.mjs dedicated');
    assert.equal(job.permissions.actions, 'read');
    assert.equal(job.permissions['pull-requests'], 'read');
    for (const step of job.steps.slice(job.steps.indexOf(gate) + 1)) assert.match(step.if, /steps\.reuse\.outputs\.eligible != 'true'/);
    for (const name of proof.steps) assert.ok(job.steps.some(step => step.name === name), name);
    if (!filename.endsWith('full-model-oci-acceptance.yml')) assert.equal(job.name, proof.job);
  }
  assert.deepEqual(workflow.jobs.full_model_oci.permissions, { contents: 'read', actions: 'read', 'pull-requests': 'read' });
});

test('release workflow_run dispatch is main-only while PR artifact builds and main provenance gates remain intact', () => {
  for (const filename of ['backend-release.yml', 'frontend-release.yml']) {
    const definition = parse(readFileSync(new URL('../.github/workflows/' + filename, import.meta.url), 'utf8'));
    assert.deepEqual(definition.on.workflow_run.workflows, ['Verify Codexia']);
    assert.deepEqual(definition.on.workflow_run.types, ['completed']);
    assert.deepEqual(definition.on.workflow_run.branches, ['main']);
    assert.deepEqual(definition.on.pull_request.branches, ['main'], 'PR validation must remain enabled');
    const admission = definition.jobs.source;
    for (const required of [
      "github.event_name == 'workflow_run'",
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.repository.full_name == github.repository",
      "github.event.workflow_run.head_repository.full_name == github.repository",
    ]) assert.ok(admission.if.includes(required), `${filename} must retain source authorization: ${required}`);
  }
});

test('Passkey bootstrap remains in the canonical browser verification graph', () => {
  assert.ok(VERIFICATION_TASKS.includes('browser-core-passkey-bootstrap'));
  assert.ok(Object.values(VERIFICATION_GROUPS).some(tasks => tasks.includes('browser-core-passkey-bootstrap')));
});
