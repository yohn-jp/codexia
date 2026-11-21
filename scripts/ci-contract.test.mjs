import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { REQUIRED_VERIFICATION_JOBS, VERIFICATION_LEAF_JOBS, UNIT_TARGETS, TYPECHECK_TARGETS, TEST_TYPECHECK_SCOPES, BROWSER_SHARDS, PROFILES, NATIVE_SELECTIONS, VERIFICATION_GROUPS, VERIFICATION_TASKS } from './ci-contract.mjs';
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8'));
const fullModelWorkflow = parse(readFileSync(new URL('../.github/workflows/full-model-oci-acceptance.yml', import.meta.url), 'utf8'));
test('the certified twenty-job inventory retains all fifty-nine obligations beside one supplemental model call', () => {
  assert.equal(REQUIRED_VERIFICATION_JOBS.length, 20);
  assert.equal(VERIFICATION_LEAF_JOBS.length, 19);
  assert.equal(VERIFICATION_TASKS.length, 59);
  assert.deepEqual(Object.keys(workflow.jobs), ['plan', 'full_model_oci', 'unit', 'types', 'build', 'oci', 'browser', 'hosted_catalog', 'hosted', 'certification']);
  const tasks = Object.values(VERIFICATION_GROUPS).flat();
  assert.equal(new Set(tasks).size, tasks.length);
  assert.deepEqual(tasks.toSorted(), VERIFICATION_TASKS.toSorted());
  assert.deepEqual(REQUIRED_VERIFICATION_JOBS, ['plan', ...Object.keys(VERIFICATION_GROUPS), 'certification']);
  for (const [family, axis] of [['unit', 'group'], ['types', 'group'], ['build', 'profile'], ['oci', 'profile'], ['hosted', 'selection']]) {
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
  assert.equal(Object.hasOwn(fullModelWorkflow.on, 'workflow_call'), true);
  assert.equal(Object.hasOwn(fullModelWorkflow.on, 'pull_request'), false);
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
test('browser groups depend on profile producers; independent groups cannot cancel other evidence', () => {
  assert.deepEqual(workflow.concurrency, {
    group: 'verify-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}',
    'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
  });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.plan.name, 'plan');
  for (const [id, job] of Object.entries(workflow.jobs).filter(([id]) => !['plan', 'certification', 'full_model_oci'].includes(id))) {
    assert.deepEqual(job.needs, id === 'browser' ? ['plan', 'build'] : id === 'hosted' ? ['plan','build','hosted_catalog'] : ['plan'], id);
    assert.match(job.if, /needs\.plan\.result == 'success'/);
    assert.equal(job['continue-on-error'], undefined, id);
    if (id === 'hosted_catalog') assert.equal(job.name,'hosted-native-catalog');
    else assert.equal(job.strategy['fail-fast'], false, id);
    assert.ok(job.steps.some(step => step.run?.includes('ci-group.mjs')));
    assert.ok(job.steps.some(step => step.uses === 'actions/upload-artifact@v7.0.2' && step.if === 'always()'));
  }
  const gate = workflow.jobs.certification;
  assert.equal(gate.if, '${{ always() && !cancelled() }}');
  assert.deepEqual(gate.needs.toSorted(), ['plan', 'unit', 'types', 'build', 'oci', 'browser', 'hosted_catalog', 'hosted'].toSorted());
  const planSelector = gate.steps.find(step => step.id === 'select-plan');
  const planDownload = gate.steps.find(step => step.run?.includes('node scripts/download-ci-artifacts.mjs') && step.env?.CODEXIA_CI_ARTIFACT_KIND === 'plan');
  const evidenceSelector = gate.steps.find(step => step.id === 'select-evidence');
  const evidenceDownload = gate.steps.find(step => step.run?.includes('node scripts/download-ci-artifacts.mjs') && step.env?.CODEXIA_CI_ARTIFACT_KIND === 'evidence');
  assert.ok(planSelector);
  assert.ok(planDownload);
  assert.match(planSelector.run, /node scripts\/select-ci-plan\.mjs/);
  assert.equal(planSelector.env.GITHUB_RUN_ID, '${{ github.run_id }}');
  assert.equal(planSelector.env.CODEXIA_EXPECTED_SHA, '${{ github.event.pull_request.head.sha || github.sha }}');
  assert.equal(planDownload.env.CODEXIA_CI_ARTIFACT_IDS, '${{ steps.select-plan.outputs.artifact-id }}');
  assert.equal(planDownload.env.CODEXIA_CI_INVENTORY_PATH, '${{ steps.select-plan.outputs.inventory-path }}');
  assert.equal(planDownload.env.CODEXIA_EXPECTED_SHA, '${{ github.event.pull_request.head.sha || github.sha }}');
  assert.ok(evidenceSelector);
  assert.match(evidenceSelector.run, /node scripts\/select-ci-evidence\.mjs/);
  assert.equal(evidenceSelector.env.GITHUB_RUN_ID, '${{ github.run_id }}');
  assert.equal(evidenceSelector.env.CODEXIA_CI_INVENTORY_PATH, '${{ steps.select-plan.outputs.inventory-path }}');
  assert.equal(evidenceSelector.env.CODEXIA_EXPECTED_SHA, '${{ github.event.pull_request.head.sha || github.sha }}');
  assert.ok(evidenceDownload);
  assert.equal(evidenceDownload.env.CODEXIA_CI_ARTIFACT_IDS, '${{ steps.select-evidence.outputs.artifact-ids }}');
  assert.equal(evidenceDownload.env.CODEXIA_CI_INVENTORY_PATH, '${{ steps.select-plan.outputs.inventory-path }}');
  assert.equal(evidenceDownload.env.CODEXIA_EXPECTED_SHA, '${{ github.event.pull_request.head.sha || github.sha }}');
  assert.ok(gate.steps.indexOf(planSelector) < gate.steps.indexOf(planDownload));
  assert.ok(gate.steps.indexOf(planDownload) < gate.steps.indexOf(evidenceSelector));
  assert.ok(gate.steps.indexOf(evidenceSelector) < gate.steps.indexOf(evidenceDownload));
  assert.doesNotMatch(evidenceDownload.run, /actions\/download-artifact/);
});
test('browser groups retain immutable runtime and restore the exact producer before running selected shards', () => {
  const browser = workflow.jobs.browser;
  const mcrDigest = 'sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579';
  const chromiumDigest = 'sha256:893b8b5c8275d4a58da814521d961db70c0417d0ab716be3bfc004e4943c58b6';
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
    "${{ endsWith(matrix.group, '-webkit') && '",
    mcrDigest,
    "' || '",
    chromiumDigest,
    "' }}",
  ].join(''));
  const runtime = readFileSync(new URL('./verify-browser-runtime.mjs', import.meta.url), 'utf8');
  assert.match(runtime, /VERIFICATION_GROUPS/);
  assert.match(runtime, /requiredProjects/);
  for (const profile of PROFILES) {
    for (const lane of ['writing', 'reference']) {
      const tasks = VERIFICATION_GROUPS[`browser-${profile}-${lane}`];
      assert.ok(tasks.length > 0);
      assert.ok(tasks.every(task => BROWSER_SHARDS.some(shard => task === `browser-${profile}-${shard.id}` && shard.project === 'chromium')));
    }
    const mixed = VERIFICATION_GROUPS[`browser-${profile}-webkit`];
    assert.ok(mixed.includes(`browser-${profile}-webkit`));
    assert.ok(mixed.includes(`browser-${profile}-ui-v1`));
  }
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
  assert.match(runner, /assertProfileReceipt/);
  assert.doesNotMatch(runner, /run\('pnpm', \['build'\], \{ CODEXIA_PROFILE: group/);
  assert.match(runner, /run-browser-shard\.mjs.*--prebuilt/);
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

test('Hosted Native keeps one verified producer and three independent composition consumers',()=>{
  const producer=workflow.jobs.hosted_catalog;
  const consumers=workflow.jobs.hosted;
  assert.match(producer.if,/hosted_catalog == 'true'/);
  assert.equal(producer.name,'hosted-native-catalog');
  assert.ok(producer.steps.some(step=>step.run?.includes('ci-native-producer.mjs seal')));
  assert.deepEqual(consumers.needs,['plan','build','hosted_catalog']);
  assert.match(consumers.if,/always\(\)/);
  assert.equal(consumers.permissions.actions,'read');
  assert.ok(!consumers.steps.some(step=>step.uses==='docker/setup-buildx-action@v3'));
  const restore=consumers.steps.find(step=>step.id==='restore-native');
  assert.match(restore.run,/ci-native-producer\.mjs restore/);
  const execution=consumers.steps.find(step=>step.run?.includes('ci-group.mjs'));
  assert.equal(execution.env.CODEXIA_CI_NATIVE_RESTORE,'${{ steps.restore-native.outcome }}');
  const profileRestore=consumers.steps.find(step=>step.id==='restore-profile');
  assert.match(profileRestore.run,/ci-profile-artifact\.mjs restore full/);
  assert.equal(execution.env.CODEXIA_CI_PROFILE_RESTORE,'${{ steps.restore-profile.outcome }}');
  assert.ok(consumers.steps.indexOf(profileRestore)<consumers.steps.indexOf(execution));
  const runner=readFileSync(new URL('./ci-group.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(runner,/build:workspace/);
});

test('balanced browser lanes retain all independent spec and browser combinations',()=>{
  for(const profile of PROFILES){
    assert.deepEqual(VERIFICATION_GROUPS['browser-'+profile+'-writing'],['core','native-review','persistence-database','redesign-visual'].map(id=>'browser-'+profile+'-'+id));
    assert.deepEqual(VERIFICATION_GROUPS['browser-'+profile+'-reference'],['modular-workspace','review-contributions','recent-activity','job-inbox'].map(id=>'browser-'+profile+'-'+id));
    assert.deepEqual(VERIFICATION_GROUPS['browser-'+profile+'-webkit'],['auth-recovery','ui-v1','webkit'].map(id=>'browser-'+profile+'-'+id));
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
  const families = ['unit', 'types', 'build', 'oci', 'browser', 'hosted_catalog', 'hosted'];
  for (const name of families) assert.match(workflow.jobs[name].if, /needs\.plan\.outputs\.reuse != 'true'/);
  assert.deepEqual(REUSED_MAIN_SKIPPED_JOBS, ['full_model_oci', ...families].map(name => workflow.jobs[name].name));
  const gate = workflow.jobs.certification;
  assert.equal(gate.permissions['pull-requests'], 'read');
  const reused = gate.steps.find(step => step.name === REUSED_MAIN_CERT_STEP);
  assert.equal(reused.if, "needs.plan.outputs.reuse == 'true'");
  assert.equal(reused.run, 'node scripts/reuse-pr-verification.mjs certify');
  assert.match(reused.env.CODEXIA_REUSE_RECEIPT, /needs\.plan\.outputs\.reuse_receipt/);
  assert.equal(gate.steps.find(step => step.name === 'Certify every required exact-source matrix element').if, "needs.plan.outputs.reuse != 'true'");
  assert.ok(gate.steps.some(step => step.with?.name === 'ci-reuse-proof' && step.if === "needs.plan.outputs.reuse == 'true'"));
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
