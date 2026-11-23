import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { matchesGlob } from 'node:path';
import { test } from 'node:test';
import { componentReleaseAffected } from './release-impact.mjs';
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');

function matchesWorkflowPaths(patterns, files) {
  return files.some(file => {
    let included = false;
    for (const pattern of patterns) {
      const exclude = pattern.startsWith('!');
      if (matchesGlob(file, exclude ? pattern.slice(1) : pattern)) included = !exclude;
    }
    return included;
  });
}

test('browser cache has a single trusted main-push writer without changing test coverage', async () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8'));
  const browser = workflow.jobs.browser;
  const steps = browser.steps;
  const restore = steps.find(step => step.id === 'dependencies');
  const saves = steps.filter(step => step.uses?.startsWith('actions/cache/save@'));
  assert.equal(restore.uses, 'actions/cache/restore@v6.1.0');
  assert.equal(saves.length, 1, 'Only one browser cache writer is permitted');
  const save = saves[0];
  assert.equal(save.if, "success() && github.event_name == 'push' && github.ref == 'refs/heads/main' && matrix.group == 'core-reference' && steps.dependencies.outputs.cache-hit != 'true'");
  assert.equal(save['continue-on-error'], true, 'Cache availability must not change verification results');
  assert.equal(save.with.path, restore.with.path);
  assert.equal(save.with.key, '${{ steps.dependencies.outputs.cache-primary-key }}');
  assert.ok(steps.indexOf(save) > steps.findIndex(step => step.run?.startsWith('node scripts/ci-group.mjs "browser-')),
    'A failed validation must not produce a new cache');
  assert.ok(steps.indexOf(save) < steps.findIndex(step => step.with?.name?.startsWith('ci-evidence-browser-')));
  assert.equal(browser.strategy.matrix.include, '${{ fromJSON(needs.plan.outputs.browser) }}');
  const { createVerificationPlan } = await import('./ci-impact.mjs');
  const main = createVerificationPlan({ files: ['docs/authoring.md'], event: 'push',
    sha: 'a'.repeat(40), base: 'b'.repeat(40) });
  assert.ok(main.groups.includes('browser-core-reference'), 'Full main verification always has the cache writer');
});

test('PR paths and completed-Verify release impact retain component build inputs', () => {
  const releases = ['frontend', 'backend'].map(component => parse(
    readFileSync(new URL(`../.github/workflows/${component}-release.yml`, import.meta.url), 'utf8')
  ));
  const releaseScope = JSON.parse(readFileSync(new URL('../deploy/release-impact-paths.json', import.meta.url), 'utf8'));
  for (const [index, component] of ['frontend','backend'].entries()) {
    const prOnly = component === 'backend' ? releaseScope.backendPullRequestOnly : [];
    assert.deepEqual(releases[index].on.pull_request.paths, [...releaseScope[component], ...prOnly], component + ' PR path drift');
  }
  const changes = [
    ['Desktop authoring', ['app/src/main.tsx'], [true, false]],
    ['Story browser entry', ['modules/story/src/browser.tsx'], [true, false]],
    ['Backend API', ['packages/api/src/server.ts'], [false, true]],
    ['Base compiler settings', ['tsconfig.base.json'], [true, true]],
    ['Docker context', ['.dockerignore'], [false, true]],
    ['Dockerfile context override', ['Dockerfile.backend.dockerignore'], [false, true]],
    ['Mixed Story changes', ['modules/story/src/browser.tsx', 'modules/story/src/index.ts'], [true, true]],
  ];
  for (const release of releases) {
    assert.deepEqual(release.on.workflow_run.workflows, ['Verify Codexia']);
    assert.deepEqual(release.on.workflow_run.types, ['completed']);
    assert.equal(release.on.push, undefined);
  }
  for (const event of ['pull_request', 'workflow_run']) {
    for (const [label, files, expected] of changes) {
      const triggered = releases.map((release, i) => event === 'workflow_run'
        ? componentReleaseAffected(['frontend', 'backend'][i], files)
        : matchesWorkflowPaths(release.on.pull_request.paths, files));
      assert.deepEqual(triggered, expected, `${event}: ${label}`);
    }
  }
});

const plan = async (files, event = 'pull_request') => {
  const { createVerificationPlan } = await import('./ci-impact.mjs');
  return createVerificationPlan({ files, event, sha: 'a'.repeat(40), base: 'b'.repeat(40) });
};

test('iOS deployment documentation selects the root tests that assert its contents', async () => {
  const selection = await plan(['docs/deployment/IOS-CLIENT.md']);
  assert.deepEqual(selection.tasks, ['unit-root', 'coverage']);
});

test('StrictDoc authority and source files select only the trace task and its existing CI group', async () => {
  for (const file of [
    'docs/requirements/README.md',
    'docs/requirements/REQUIREMENT-REGISTER.md',
    'docs/requirements/STRICTDOC-TRACEABILITY.md',
    'docs/requirements/STRICTDOC-GRAMMAR.gra.md',
    'scripts/strictdoc/verify.mjs',
    'scripts/strictdoc/strictdoc_config.py',
    'scripts/strictdoc/requirements.lock.txt',
  ]) {
    const selected = await plan([file]);
    assert.deepEqual(selected.tasks, ['coverage', 'requirements-trace'], file);
    assert.deepEqual(selected.groups, ['types-tests'], file);
  }
});

test('Full-model OCI selection follows the standalone workflow and the Verify caller', async () => {
  const { FULL_MODEL_OCI_PATHS } = await import('./ci-impact.mjs');
  const standalone = parse(readFileSync(new URL('../.github/workflows/full-model-oci-acceptance.yml', import.meta.url), 'utf8'));
  const pushPaths = standalone.on.push.paths;
  assert.equal(Object.hasOwn(standalone.on, 'workflow_call'), true);
  assert.equal(standalone.on.workflow_dispatch, null);
  assert.deepEqual(standalone.on.push.branches, ['main']);
  assert.equal(Object.hasOwn(standalone.on, 'pull_request'), false);
  assert.deepEqual(pushPaths, FULL_MODEL_OCI_PATHS.filter(file => file !== '.github/workflows/verify.yml'));

  // GitHub's standalone path declarations define which inputs require the real model suite.
  for (const expression of pushPaths) {
    const excluded = expression.startsWith('!');
    const pattern = excluded ? expression.slice(1) : expression;
    const changedPath = pattern.endsWith('/**') ? `${pattern.slice(0, -3)}/ci-impact-sentinel.mjs` : pattern;
    assert.equal((await plan([changedPath])).full_model_oci, !excluded, changedPath);
  }
  assert.equal((await plan(['.github/workflows/verify.yml'])).full_model_oci, true, 'Verify caller changes require its model proof');
  for (const changedPath of [
    '.github/workflows/other.yml',
    'profiles-old/full/config.json',
    'tests/integration/unrelated.acceptance.mjs',
    'docs/deployment/IAC.md',
  ]) {
    assert.equal((await plan([changedPath])).full_model_oci, false, `Unexpected plan impact for ${changedPath}`);
  }
  const nativeConfig = 'app/native/capacitor.config.ts';
  const bridgeDeclaration = 'app/native/plugins/codexia-auth/src/index.d.mts';
  for (const [files, expected] of [
    [[nativeConfig, 'app/native/scripts/configure-oauth-callback.mjs'], false],
    [['app/native/plugins/codexia-auth/ios/CodexiaAuthPlugin.swift'], false],
    [[bridgeDeclaration], true],
    [[nativeConfig, bridgeDeclaration], true],
    [[nativeConfig, 'app/src/entries/mobile.tsx'], true],
    [['app/native/new-build-input.ts'], true],
  ]) {
    assert.equal(matchesWorkflowPaths(pushPaths, files), expected, `main push: ${files.join(', ')}`);
    assert.equal((await plan(files)).full_model_oci, expected, `PR: ${files.join(', ')}`);
  }
  assert.equal((await plan(null)).full_model_oci, false);
  assert.equal((await plan(['profiles/full/config.json'], 'push')).full_model_oci, false);

  const verify = parse(readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8'));
  assert.equal(verify.jobs.full_model_oci.uses, './.github/workflows/full-model-oci-acceptance.yml');
  assert.equal(verify.jobs.full_model_oci.if, "needs.plan.result == 'success' && needs.plan.outputs.full_model_oci == 'true'");
});

test('Search browser changes do not run unrelated units or native image builds', async () => {
  const selected = await plan(['modules/search/src/browser.ts', 'modules/search/src/browser.test.ts']);
  assert.ok(selected.tasks.includes('unit-search'));
  assert.ok(selected.tasks.includes('build-full'));
  assert.ok(selected.tasks.includes('browser-full-modular-workspace'));
  assert.ok(selected.tasks.includes('browser-full-ui-v1'));
  assert.ok(!selected.tasks.includes('unit-core'));
  assert.ok(!selected.tasks.includes('unit-speaker'));
  assert.ok(!selected.tasks.some(task => task.startsWith('oci-')));
});

test('shared app changes retain both profile browser coverage without backend units', async () => {
  const selected = await plan(['app/src/application/SharedApplication.tsx']);
  assert.ok(selected.tasks.includes('unit-app'));
  for (const profile of ['core', 'full']) {
    assert.ok(selected.tasks.includes(`build-${profile}`));
    assert.ok(selected.tasks.includes(`browser-${profile}-webkit`));
    assert.ok(selected.tasks.includes(`browser-${profile}-core`));
  }
  assert.ok(!selected.tasks.includes('unit-api'));
});

test('main, manual, shared contracts, lockfiles, manifests and unknown files fail closed to full verification', async () => {
  const { VERIFICATION_TASKS } = await import('./ci-contract.mjs');
  for (const [files, event] of [
    [['modules/search/src/browser.ts'], 'push'], [[], 'workflow_dispatch'],
    [['packages/contracts/src/index.ts'], 'pull_request'],
    [['packages/persistence-contracts/src/index.ts'], 'pull_request'],
    [['packages/persistence-postgres/src/postgres-store.ts'], 'pull_request'],
    [['pnpm-lock.yaml'], 'pull_request'],
    [['modules/search/package.json'], 'pull_request'], [['new-root-file'], 'pull_request'],
    [null, 'pull_request'],
  ]) {
    assert.deepEqual((await plan(files, event)).tasks, VERIFICATION_TASKS);
  }
});

test('test-only changes select their owner while non-executable documentation selects inventory only', async () => {
  const selected = await plan(['modules/search/src/browser.test.ts']);
  assert.ok(selected.tasks.includes('unit-search'));
  assert.ok(selected.tasks.includes('test-types-modules'));
  assert.ok(!selected.tasks.includes('build-full'));
  assert.deepEqual((await plan(['docs/authoring.md'])).tasks, ['coverage']);
});

test('proof ineligibility can expand an affected PR plan to the complete task inventory without losing its actual diff', async () => {
  const { createVerificationPlan, verificationPlanOutputs } = await import('./ci-impact.mjs');
  const affected = createVerificationPlan({ files: ['modules/search/src/browser.ts'], event: 'pull_request',
    sha: 'a'.repeat(40), base: 'b'.repeat(40) });
  const fallback = createVerificationPlan({ ...affected, forceFull: true });
  const { VERIFICATION_TASKS } = await import('./ci-contract.mjs');
  assert.equal(affected.mode, 'affected');
  assert.equal(fallback.mode, 'full');
  assert.equal(fallback.forceFull, true);
  assert.deepEqual(fallback.files, affected.files, 'Fallback retains the exact source diff for later first-parent validation');
  assert.deepEqual(fallback.tasks, VERIFICATION_TASKS);
  assert.equal(fallback.full_model_oci, affected.full_model_oci);
  const outputs = verificationPlanOutputs(fallback);
  assert.deepEqual(JSON.parse(outputs.unit), ['core', 'modules']);
  assert.deepEqual(JSON.parse(outputs.types), ['sources', 'tests']);
  assert.equal(JSON.parse(outputs.plan).forceFull, true);
});

test('OAuth browser acceptance is selected in both profile browser lanes', async () => {
  const selected = await plan(['tests/e2e/oauth-web.acceptance.spec.ts']);
  assert.ok(selected.tasks.includes('test-types-app-e2e'));
  for (const profile of ['core', 'full']) {
    assert.ok(selected.tasks.includes(`build-${profile}`));
    assert.ok(selected.tasks.includes(`browser-${profile}-oauth-web`));
    assert.ok(selected.groups.includes(`browser-${profile}-webkit`));
  }
  assert.ok(!selected.tasks.includes('unit-api'));
});

test('every selected task has one execution group and every exclusion has a reason', async () => {
  const { VERIFICATION_GROUPS, VERIFICATION_TASKS } = await import('./ci-contract.mjs');
  const selected = await plan(['app/src/editor/SceneEditor.tsx']);
  assert.deepEqual(selected.groups, Object.keys(VERIFICATION_GROUPS).filter(group => VERIFICATION_GROUPS[group].some(task => selected.tasks.includes(task))));
  assert.equal(selected.excluded.length + selected.tasks.length, VERIFICATION_TASKS.length);
  assert.ok(selected.excluded.every(item => item.reason && !selected.tasks.includes(item.task)));
});

test('known operational inputs retain root proof without unrelated browser or OCI work', async () => {
  const { OPERATIONAL_ROOT_PATHS } = await import('./ci-impact.mjs');
  const { VERIFICATION_TASKS } = await import('./ci-contract.mjs');
  for (const file of OPERATIONAL_ROOT_PATHS) {
    const selected = await plan([file]);
    assert.deepEqual(selected.tasks, ['unit-root','coverage'], file);
    assert.equal(selected.full_model_oci, false, file);
  }
  for (const file of ['deploy/ansible/new-stage.yml','deploy/backup/new-runtime.mjs','scripts/new-tool.mjs','.github/workflows/unknown.yml']) {
    assert.deepEqual((await plan([file])).tasks, VERIFICATION_TASKS, file);
  }
  const mixed = await plan(['deploy/ansible/host.yml','app/src/api.ts']);
  assert.ok(mixed.tasks.includes('unit-root') && mixed.tasks.includes('unit-app') && mixed.tasks.includes('browser-core-core'));
  assert.deepEqual((await plan(['deploy/ansible/host.yml','pnpm-lock.yaml'])).tasks, VERIFICATION_TASKS);
  assert.deepEqual((await plan(['deploy/ansible/host.yml'], 'push')).tasks, VERIFICATION_TASKS);
  assert.deepEqual((await plan(null)).tasks, VERIFICATION_TASKS);
});

test('operational proof remains owned by one exact-head root task and matching independent workflows', async () => {
  const { OPERATIONAL_ROOT_PATHS } = await import('./ci-impact.mjs');
  const readWorkflow = name => parse(readFileSync(new URL('../.github/workflows/'+name, import.meta.url), 'utf8'));
  const infra = readWorkflow('deployment-config.yml');
  for (const event of ['pull_request','push']) {
    assert.deepEqual(infra.on[event].branches, ['main'], event);
    for (const path of ['deploy/ansible/**','deploy/backup/**','deploy/quadlet/**','deploy/postgres/**','deploy/cloudflare/**']) {
      assert.ok(infra.on[event].paths.includes(path), path);
    }
  }
  assert.equal(infra.jobs.configuration.steps.find(s=>s.uses?.startsWith('actions/checkout')).with.ref, '${{ github.event.pull_request.head.sha || github.sha }}');
  const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url),'utf8'));
  for (const command of ['verify:deployment','typecheck:deployment','test:deployment']) {
    assert.ok(root.scripts['test:scripts'].includes('pnpm run '+command));
    assert.ok(!JSON.stringify(infra.jobs).includes('pnpm run '+command));
    assert.ok(!JSON.stringify(readWorkflow('frontend-release.yml').jobs).includes('pnpm run '+command));
  }
  assert.ok(OPERATIONAL_ROOT_PATHS.includes('docs/deployment/README.md'));
  assert.ok(OPERATIONAL_ROOT_PATHS.includes('docs/deployment/BACKUP.md'));
  assert.ok(OPERATIONAL_ROOT_PATHS.includes('.github/workflows/tailscale-connectivity.yml'));
  const audit = readWorkflow('repository-audit.yml');
  assert.ok(!Object.hasOwn(audit.on,'workflow_run'));
  assert.ok(!Object.hasOwn(audit.on,'delete'));
  assert.deepEqual(audit.on.push.branches,['main']);
  assert.equal(Object.hasOwn(audit.on,'schedule'),false);
  assert.ok(Object.hasOwn(audit.on,'workflow_dispatch'));
  assert.ok(Object.hasOwn(audit.on,'pull_request'));
});

test('Mitogen launcher changes select the rootless contract on PR and main', async () => {
  const launcher = 'deploy/ansible/ci-mitogen-playbook.sh';
  const workflow = parse(readFileSync(new URL('../.github/workflows/ansible-base-secrets.yml', import.meta.url), 'utf8'));
  const fixture = workflow.jobs['rootless-secrets'].steps.find(step => step.env?.ANSIBLE_PLAYBOOK);
  assert.equal(fixture.env.ANSIBLE_PLAYBOOK, '${{ github.workspace }}/' + launcher);
  for (const event of ['pull_request', 'push']) {
    assert.deepEqual(workflow.on[event].branches, ['main'], event);
    assert.ok(workflow.on[event].paths.includes(launcher), event);
  }
  assert.deepEqual((await plan([launcher])).tasks, ['unit-root', 'coverage']);
  const shared = 'app/src/api.ts';
  assert.deepEqual((await plan([launcher, shared])).tasks, (await plan([shared])).tasks);
  for (const event of ['push', 'workflow_dispatch']) {
    assert.equal((await plan([launcher], event)).mode, 'full');
  }
});

test('iOS packaging workflow changes retain root proof and its shared inputs stay fully verified', async () => {
  const { OPERATIONAL_ROOT_PATHS } = await import('./ci-impact.mjs');
  const workflowPath = '.github/workflows/ios-unsigned-ipa.yml';
  const workflow = parse(readFileSync(new URL('../' + workflowPath, import.meta.url), 'utf8'));
  assert.ok(OPERATIONAL_ROOT_PATHS.includes(workflowPath));
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'workflow_dispatch']);
  for (const input of ['app/native/**', 'scripts/html-document.mjs', 'scripts/ios/**', 'scripts/read-regular-file.mjs']) {
    assert.ok(workflow.on.pull_request.paths.includes(input), input);
  }
  assert.equal(workflow.jobs.build['runs-on'], 'xcode-27');
  assert.ok(workflow.jobs.build.steps.some(step => step.run?.includes('scripts/ios/validate-web-bundle.mjs')));
  assert.ok(workflow.jobs.build.steps.some(step => step.run?.includes('scripts/ios/package-unsigned-ipa.mjs')));

  const workflowOnly = await plan([workflowPath]);
  assert.deepEqual(workflowOnly.tasks, ['unit-root', 'coverage']);
  assert.equal(workflowOnly.full_model_oci, false);

  const sharedImplementationPaths = [
    'scripts/ios/validate-web-bundle.mjs',
    'scripts/ios/package-unsigned-ipa.mjs',
    'app/native/capacitor.config.ts',
    'app/src/oauth.ts',
    'pnpm-lock.yaml',
  ];
  for (const sharedPath of sharedImplementationPaths) {
    const withWorkflow = await plan([workflowPath, sharedPath]);
    const implementationOnly = await plan([sharedPath]);
    for (const task of implementationOnly.tasks) assert.ok(withWorkflow.tasks.includes(task), `${sharedPath}: lost ${task}`);
    assert.equal(withWorkflow.mode, implementationOnly.mode, sharedPath);
    assert.equal(withWorkflow.full_model_oci, implementationOnly.full_model_oci, sharedPath);
  }

  const unknownMixed = await plan([workflowPath, 'scripts/new-ios-input.mjs']);
  const unknownOnly = await plan(['scripts/new-ios-input.mjs']);
  assert.deepEqual(unknownMixed.tasks, unknownOnly.tasks);
  assert.equal(unknownMixed.mode, 'full');
});

test('root and coverage-only plans have a single owner for contract test execution', async () => {
  const runner = readFileSync(new URL('./ci-group.mjs', import.meta.url),'utf8');
  const root = JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.match(root.scripts['test:scripts'], /node --test 'scripts\/\*\*\/\*\.test\.mjs'/u);
  assert.match(runner, /if \(!plan\.tasks\.includes\('unit-root'\)\) await node\('--test', 'scripts\/ci-contract\.test\.mjs'/u);
  assert.deepEqual((await plan(['docs/authoring.md'])).tasks, ['coverage']);
  assert.deepEqual((await plan(['deploy/ansible/host.yml'])).tasks, ['unit-root','coverage']);
});

test('push backup changes retain root and independent exact-head verification', async () => {
  const { VERIFICATION_TASKS } = await import('./ci-contract.mjs');
  const backup = parse(readFileSync(new URL('../.github/workflows/push-backup.yml', import.meta.url), 'utf8'));
  const source = [
    'deploy/backup/backup.sh',
    'deploy/ansible/deploy.yml',
    'deploy/ansible/restore-drill.yml',
    'deploy/ansible/push-deployment-recover.sh',
    'scripts/push-deployment-backup.test.mjs',
    'scripts/push-deployment-recovery.test.mjs',
    '.github/workflows/push-backup.yml',
  ];
  for (const file of source) {
    assert.deepEqual((await plan([file])).tasks, ['unit-root', 'coverage'], file);
    assert.equal((await plan([file])).full_model_oci, false, file);
    for (const event of ['pull_request', 'push']) {
      const paths = backup.on[event].paths;
      assert.ok(paths.some(p => p === file || (p.endsWith('/**') && file.startsWith(p.slice(0, -2)))), file);
    }
  }
  const steps = backup.jobs['backup-contract'].steps;
  assert.equal(steps.find(s => s.uses?.startsWith('actions/checkout')).with.ref, '${{ github.event.pull_request.head.sha || github.sha }}');
  assert.ok(steps.some(s => s.run?.includes('bash -n deploy/backup/backup.sh')));
  assert.ok(steps.some(s => s.run?.includes('scripts/push-deployment-backup.test.mjs')));
  assert.deepEqual((await plan([...source, 'pnpm-lock.yaml'])).tasks, VERIFICATION_TASKS);
  assert.deepEqual((await plan(source, 'push')).tasks, VERIFICATION_TASKS);
});

test('iOS packaging and CI dashboard changes remain root-scoped, mixed source remains fully covered', async () => {
  const { VERIFICATION_TASKS } = await import('./ci-contract.mjs');
  for (const file of [
    '.github/workflows/ios-unsigned-ipa.yml',
    'scripts/ios/package-unsigned-ipa.mjs',
    'app/native/package.json',
    'scripts/ci-dashboard/analysis.mjs',
    'scripts/ci-dashboard/site/dashboard.js',
  ]) {
    assert.deepEqual((await plan([file])).tasks, ['unit-root', 'coverage'], file);
    assert.equal((await plan([file])).full_model_oci, false);
  }
  const changed = await plan(['.github/workflows/ios-unsigned-ipa.yml', 'app/src/main.tsx']);
  assert.ok(changed.tasks.includes('build-full') && changed.tasks.includes('browser-full-webkit'));
  assert.deepEqual((await plan(['scripts/ci-dashboard/analysis.mjs', 'unknown/unreviewed.txt'])).tasks, VERIFICATION_TASKS);
  assert.deepEqual((await plan(['.github/workflows/ios-unsigned-ipa.yml'], 'push')).tasks, VERIFICATION_TASKS);
});

test('the Passkey browser acceptance source is owned by the API unit, package typecheck, and dedicated Core Chromium shard', async () => {
  const expected = ['unit-api', 'typecheck-core-api', 'test-types-packages', 'build-core', 'browser-core-passkey-bootstrap', 'coverage'];
  for (const file of [
    'packages/api/test/passkey-bootstrap.acceptance.test.ts',
    'packages/api/scripts/run-passkey-acceptance.mjs',
  ]) {
    const result = await plan([file]);
    assert.deepEqual(result.tasks, expected, file);
    assert.equal(result.mode, 'affected', file);
    assert.equal(result.full_model_oci, true, 'package paths remain in the separate Full-model OCI impact closure');
  }
  const browserSpec = await plan(['tests/e2e/passkey-bootstrap.acceptance.spec.ts']);
  assert.ok(browserSpec.tasks.includes('browser-core-passkey-bootstrap'));
  assert.ok(browserSpec.tasks.includes('browser-full-passkey-bootstrap'));
  assert.ok(browserSpec.tasks.includes('test-types-app-e2e'));
});
