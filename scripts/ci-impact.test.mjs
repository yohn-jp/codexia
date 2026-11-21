import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { matchesGlob } from 'node:path';
import { test } from 'node:test';
import { REQUIRED_VERIFICATION_JOBS } from './ci-contract.mjs';
import { componentReleaseAffected } from './release-impact.mjs';
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');

test('full verification uses twenty jobs including planning and certification', () => {
  assert.equal(REQUIRED_VERIFICATION_JOBS.length, 20);
});

test('PR paths and completed-Verify release impact retain component build inputs', () => {
  const releases = ['frontend', 'backend'].map(component => parse(
    readFileSync(new URL(`../.github/workflows/${component}-release.yml`, import.meta.url), 'utf8')
  ));
  const releaseScope = JSON.parse(readFileSync(new URL('../deploy/release-impact-paths.json', import.meta.url), 'utf8'));
  for (const [index, component] of ['frontend','backend'].entries()) {
    assert.deepEqual(releases[index].on.pull_request.paths, releaseScope[component], component + ' release path drift');
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
        : files.some(file => {
          let included = false;
          for (const pattern of release.on.pull_request.paths) {
            const exclude = pattern.startsWith('!');
            if (matchesGlob(file, exclude ? pattern.slice(1) : pattern)) included = !exclude;
          }
          return included;
        }));
      assert.deepEqual(triggered, expected, `${event}: ${label}`);
    }
  }
});

const plan = async (files, event = 'pull_request') => {
  const { createVerificationPlan } = await import('./ci-impact.mjs');
  return createVerificationPlan({ files, event, sha: 'a'.repeat(40), base: 'b'.repeat(40) });
};

test('Full-model OCI impact matches the standalone push paths and the Verify caller', async () => {
  const { FULL_MODEL_OCI_PATHS, matchesFullModelOciPath } = await import('./ci-impact.mjs');
  const standalone = parse(readFileSync(new URL('../.github/workflows/full-model-oci-acceptance.yml', import.meta.url), 'utf8'));
  const pushPaths = standalone.on.push.paths;
  assert.equal(Object.hasOwn(standalone.on, 'workflow_call'), true);
  assert.equal(standalone.on.workflow_dispatch, null);
  assert.deepEqual(standalone.on.push.branches, ['main']);
  assert.equal(Object.hasOwn(standalone.on, 'pull_request'), false);
  assert.deepEqual(pushPaths, FULL_MODEL_OCI_PATHS.filter(file => file !== '.github/workflows/verify.yml'));

  for (const pattern of FULL_MODEL_OCI_PATHS) {
    const changedPath = pattern.endsWith('/**') ? `${pattern.slice(0, -3)}/ci-impact-sentinel.mjs` : pattern;
    assert.equal(matchesFullModelOciPath(changedPath), true, `Expected impact for ${changedPath}`);
    assert.equal((await plan([changedPath])).full_model_oci, true, `Expected plan impact for ${changedPath}`);
  }
  for (const changedPath of [
    '.github/workflows/other.yml',
    'profiles-old/full/config.json',
    'tests/integration/unrelated.acceptance.mjs',
    'docs/deployment/IAC.md',
  ]) {
    assert.equal(matchesFullModelOciPath(changedPath), false, `Unexpected impact for ${changedPath}`);
    assert.equal((await plan([changedPath])).full_model_oci, false, `Unexpected plan impact for ${changedPath}`);
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
  assert.ok(!selected.tasks.some(task => task.startsWith('hosted-native-') || task.startsWith('oci-')));
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
  assert.ok(!selected.tasks.some(task => task.startsWith('hosted-native-')));
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
  const mapped = Object.values(VERIFICATION_GROUPS).flat();
  assert.equal(new Set(mapped).size, mapped.length);
  assert.deepEqual(mapped.toSorted(), VERIFICATION_TASKS.toSorted());
  const selected = await plan(['app/src/editor/SceneEditor.tsx']);
  assert.deepEqual(selected.groups, Object.keys(VERIFICATION_GROUPS).filter(group => VERIFICATION_GROUPS[group].some(task => selected.tasks.includes(task))));
  assert.equal(selected.excluded.length + selected.tasks.length, VERIFICATION_TASKS.length);
  assert.ok(selected.excluded.every(item => item.reason && !selected.tasks.includes(item.task)));
});

test('known operational inputs retain root proof without unrelated browser, OCI or Hosted work', async () => {
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

test('iOS packaging workflow changes retain root proof and its shared inputs stay fully verified', async () => {
  const { OPERATIONAL_ROOT_PATHS } = await import('./ci-impact.mjs');
  const workflowPath = '.github/workflows/ios-unsigned-ipa.yml';
  const workflow = parse(readFileSync(new URL('../' + workflowPath, import.meta.url), 'utf8'));
  assert.ok(OPERATIONAL_ROOT_PATHS.includes(workflowPath));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.jobs.build['runs-on'], 'macos-15');
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
