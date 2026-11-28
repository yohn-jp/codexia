import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { matchesGlob } from 'node:path';
import { test } from 'node:test';
import { componentReleaseAffected } from '../../release/components/impact.mjs';
import { PROFILES, VERIFICATION_TASKS } from './contract.mjs';
import {
  isTaskInputDocument,
  UX_PROJECTION_DOCUMENTS,
} from '../evidence/task-inputs.mjs';
import { isTraceTestSource } from '../../strictdoc/test-source-path.mjs';
const { parse } = createRequire(new URL('../../../packages/core/package.json', import.meta.url))('yaml');

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
  const workflow = parse(readFileSync(new URL('../../../.github/workflows/verify.yml', import.meta.url), 'utf8'));
  const profileWorkflow = parse(readFileSync(new URL('../../../.github/workflows/verify-profile.yml', import.meta.url), 'utf8'));
  const browser = profileWorkflow.jobs.browser;
  const steps = browser.steps;
  const restore = steps.find(step => step.id === 'dependencies');
  const saves = steps.filter(step => step.uses?.startsWith('actions/cache/save@'));
  assert.ok(restore.uses.startsWith('actions/cache/restore@'));
  assert.equal(saves.length, 1, 'Only one browser cache writer is permitted');
  const save = saves[0];
  assert.equal(save.if, "success() && github.event_name == 'push' && github.ref == 'refs/heads/main' && matrix.group == 'full-reference' && steps.dependencies.outputs.cache-hit != 'true'");
  assert.equal(save['continue-on-error'], true, 'Cache availability must not change verification results');
  assert.equal(save.with.path, restore.with.path);
  assert.equal(save.with.key, '${{ steps.dependencies.outputs.cache-primary-key }}');
  assert.ok(steps.indexOf(save) > steps.findIndex(step => step.run?.startsWith('node scripts/ci/execution/group.mjs "browser-')),
    'A failed validation must not produce a new cache');
  assert.ok(steps.indexOf(save) < steps.findIndex(step => step.with?.name?.startsWith('ci-evidence-browser-')));
  assert.equal(browser.strategy.matrix.include, '${{ fromJSON(inputs.browser) }}');
  const { createVerificationPlan } = await import('./plan.mjs');
  const main = createVerificationPlan({ files: ['docs/authoring.sdoc'], event: 'push',
    sha: 'a'.repeat(40), base: 'b'.repeat(40) });
  const { verificationPlanOutputs } = await import('./plan.mjs');
  const outputs = verificationPlanOutputs(main);
  assert.ok(JSON.parse(outputs.browser_full).some(shard => shard.group === 'full-reference'), 'Full main verification always has the cache writer');
});

test('host dependencies are restore-only in Verify and cache mutation is scoped to trusted events', () => {
  const workflow = parse(readFileSync(new URL('../../../.github/workflows/verify.yml', import.meta.url), 'utf8'));
  const profileWorkflow = parse(readFileSync(new URL('../../../.github/workflows/verify-profile.yml', import.meta.url), 'utf8'));
  const cache = parse(readFileSync(new URL('../../../.github/workflows/ci-dependency-cache.yml', import.meta.url), 'utf8'));
  const warm = cache.jobs.warm;
  const warmRestore = warm.steps.find(step => step.id === 'dependencies');
  const warmSave = warm.steps.find(step => step.uses?.startsWith('actions/cache/save@'));
  assert.equal(warm.if, "github.event_name != 'pull_request_target' && github.ref == 'refs/heads/main'");
  assert.equal(warmSave.with.key, '${{ steps.dependencies.outputs.cache-primary-key }}');
  for (const job of ['unit', 'types', 'build']) {
    const steps = (job === 'build' ? profileWorkflow : workflow).jobs[job].steps;
    const restore = steps.find(step => step.id === 'dependencies');
    assert.ok(restore.uses.startsWith('actions/cache/restore@'), job);
    assert.equal(restore.with.key, warmRestore.with.key, job);
    assert.equal(restore.with.path, warmRestore.with.path, job);
    assert.ok(!steps.some(step => /^actions\/cache(?:\/save)?@/u.test(step.uses ?? '')), job);
  }
  assert.deepEqual(cache.on.pull_request_target.types, ['closed']);
  const cleanup = cache.jobs.cleanup;
  assert.equal(cleanup.if, "github.event_name == 'pull_request_target' && github.event.action == 'closed'");
  assert.deepEqual(cleanup.permissions, { actions: 'write' });
  assert.ok(cleanup.steps.every(step => !step.uses), 'Privileged cleanup must not checkout or run PR-controlled code');
  assert.match(cleanup.steps[0].run, /--ref "refs\/pull\/\$PR_NUMBER\/merge"/u);
  assert.equal(cleanup.steps[0].env.PR_NUMBER, '${{ github.event.pull_request.number }}');
  assert.ok(workflow.jobs.unit.services.postgres.image.includes(
    "matrix.group != 'architecture' && (matrix.group != 'db' || contains(fromJSON(needs.plan.outputs.plan).tasks, 'http-conformance') || contains(fromJSON(needs.plan.outputs.plan).tasks, 'mcp-conformance'))"));
  assert.equal(workflow.jobs.unit.steps.find(step => step.id === 'dependencies').if, "matrix.group != 'architecture' && matrix.group != 'api' && matrix.group != 'db'");
  assert.equal(profileWorkflow.jobs.build.steps.find(step => step.id === 'dependencies').if, "inputs.profile == 'full'");
  assert.equal(profileWorkflow.jobs.browser.steps.find(step => step.id === 'dependencies').if, "inputs.profile == 'full'");
  for (const name of ['plan', 'certification']) {
    const steps = workflow.jobs[name].steps;
    const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
    const materialize = steps.find(step => step.name === 'Materialize exact evidence inputs');
    assert.equal(checkout.with['fetch-depth'], 0);
    assert.equal(checkout.with['sparse-checkout'], 'scripts');
    assert.equal(materialize.run, 'node scripts/ci/impact/evidence-checkout.mjs');
    assert.ok(steps.indexOf(checkout) < steps.indexOf(materialize));
    assert.ok(steps.indexOf(materialize) < steps.findIndex(step => step.name === 'Install frozen CI evidence dependencies'));
  }
});

test('PR paths and completed-Verify release impact retain component build inputs', () => {
  const releases = ['frontend', 'backend'].map(component => parse(
    readFileSync(new URL(`../../../.github/workflows/${component}-release.yml`, import.meta.url), 'utf8')
  ));
  const releaseScope = JSON.parse(readFileSync(new URL('../../../deploy/release-impact-paths.json', import.meta.url), 'utf8'));
  for (const [index, component] of ['frontend','backend'].entries()) {
    const prOnly = component === 'backend' ? releaseScope.backendPullRequestOnly : [];
    assert.deepEqual(releases[index].on.pull_request.paths, [...releaseScope[component], ...prOnly], component + ' PR path drift');
  }
  const changes = [
    ['Desktop authoring', ['app/src/entries/desktop.tsx'], [true, false]],
    ['TypeSpec contract', ['packages/http-contract/src/routes-persistence.tsp'], [true, true]],
    ['TypeSpec compiler config', ['packages/http-contract/tspconfig.yaml'], [true, true]],
    ['Story browser entry', ['modules/story/src/browser.tsx'], [true, false]],
    ['Backend API', ['packages/api/src/server.ts'], [false, true]],
    ['Backend API source helper', ['packages/api/src/auth/tests/helper.ts'], [false, true]],
    ['Desktop public asset', ['app/public/test/theme.test.css'], [true, false]],
    ['Base compiler settings', ['tsconfig.base.json'], [true, true]],
    ['Initial frontend Assets API uploader', ['scripts/release/frontend/initial-publication.mjs'], [true, false]],
    ['Frontend upload dependencies', ['edge/frontend/package-lock.json'], [true, false]],
    ['Certified edge route contract', ['deploy/cloudflare/ui-routes.json'], [true, false]],
    ['Managed edge planner source', ['cmd/codexiactl/cloudflare_managed_edge.go'], [false, false]],
    ['Packaged Core dependency audit', ['scripts/verification/dependencies/audit-runtime.mjs'], [false, true]],
    ['Shared release evidence pagination', ['scripts/github/paginate-actions.mjs'], [true, true]],
    ['Shared release evidence SDK', ['scripts/ci/evidence/github-rest-sdk.mjs'], [true, true]],
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

test('[TEST-QUAL-001-001] disposable app lifecycle admits only deployment-relevant PR inputs', () => {
  const workflow = parse(readFileSync(new URL('../../../.github/workflows/push-app-lifecycle.yml', import.meta.url), 'utf8'));
  const paths = workflow.on.pull_request.paths;
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
  assert.deepEqual(workflow.jobs.lifecycle.strategy.matrix.scenario, ['app', 'auth'],
    'admitted PRs must preserve both independent state-transition lanes');
  for (const file of [
    'packages/api/src/server.ts',
    'packages/api/src/better-auth.ts',
    'packages/api/src/oauth-owner.ts',
    'packages/api/src/owner-security.ts',
    'packages/api/src/auth/authorize.ts',
    'packages/persistence-postgres/migrations/0001-create.sql',
    'packages/persistence-postgres/src/connection.ts',
    'packages/persistence-contracts/src/owner.ts',
    'packages/module-runtime/src/registry.ts',
    'packages/core/package.json',
    'modules/mcp/package.json',
    'deploy/quadlet/codexia-api.container',
    'deploy/ansible/deploy.yml',
    'deploy/ansible/test-push-app-lifecycle.sh',
    'deploy/backup/backup.sh',
    'deploy/fixtures/sshfs-server/Dockerfile',
    'scripts/deployment/lifecycle/app-update.mjs',
    'scripts/verification/runtime/better-auth-fixture.sh',
    'scripts/build/packaging/profile-package.mjs',
    '.github/workflows/push-app-lifecycle.yml',
    'Dockerfile.backend',
    'pnpm-lock.yaml',
  ]) assert.equal(matchesWorkflowPaths(paths, [file]), true, file);
  for (const file of [
    'packages/persistence-postgres/tests/db-contract/runner.test.mjs',
    'packages/http-contract/test/fastify-persistence-registration.test.ts',
    'packages/core/src/snapshot-reuse.test.ts',
    'packages/api/src/better-auth.test.ts',
    'packages/api/src/auth/tests/owner-contract.test.ts',
    'packages/api/src/recent-activity-store.ts',
    'modules/mcp/src/tools.ts',
    'packages/core/src/formatter.ts',
    'app/src/entries/desktop.tsx',
    'docs/deployment/BACKUP-CONSOLE-OPERATIONS.sdoc',
    'docs/deployment/ANSIBLE-AUTH-RUNTIME.sdoc',
    'docs/deployment/PUSH-DEPLOYMENT.sdoc',
    'docs/deployment/IAC.sdoc',
    '.github/workflows/verify.yml',
    'scripts/deployment/admission/documentation.test.mjs',
    'scripts/ci/impact/plan.mjs',
    'scripts/ci/evidence/download-artifacts.test.mjs',
  ]) assert.equal(matchesWorkflowPaths(paths, [file]), false, file);
  assert.equal(matchesWorkflowPaths(paths, [
    'modules/mcp/src/tools.ts', 'deploy/quadlet/codexia-db.container',
  ]), true, 'runtime transaction changes cannot be hidden in a mixed PR');
});

const plan = async (files, event = 'pull_request') => {
  const { createVerificationPlan } = await import('./plan.mjs');
  return createVerificationPlan({ files, event, sha: 'a'.repeat(40), base: 'b'.repeat(40) });
};

test('official conformance fixtures select their own task and share the DB lane', async () => {
  for (const kind of ['http', 'mcp']) {
    const task = `${kind}-conformance`;
    const result = await plan([`tests/conformance/${kind}/run.mjs`]);
    assert.deepEqual(result.tasks, [task, 'coverage']);
    assert.deepEqual(result.groups, ['unit-db', 'types-tests']);
    assert.equal(result.full_model_oci, false);
  }
  for (const file of ['packages/api/src/server.ts', 'packages/persistence-postgres/src/migrate.ts']) {
    const { tasks } = await plan([file]);
    assert.ok(tasks.includes('http-conformance') && tasks.includes('mcp-conformance'), file);
  }
  assert.ok((await plan(['packages/http-contract/openapi/codexia.openapi.yaml'])).tasks.includes('http-conformance'));
  assert.ok((await plan(['modules/mcp/src/stdio.ts'])).tasks.includes('mcp-conformance'));
});

test('audit Pages PR previews are scoped to Pages-owned inputs; main still publishes', () => {
  const workflow = parse(readFileSync(new URL('../../../.github/workflows/repository-audit.yml', import.meta.url), 'utf8'));
  const paths = workflow.on.pull_request.paths;
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
  for (const file of [
    'scripts/audit/portal.mjs',
    'scripts/strictdoc/verify.mjs',
    'docs/requirements/REQUIREMENT-REGISTER.sdoc',
    'docs/architecture/likec4/codexia.c4',
    'scripts/graphify-pages/pack.mjs',
    'scripts/architecture-diagrams/pack.mjs',
    'scripts/pages-ui/navigation.mjs',
    'scripts/pages-api/pack.mjs',
    'scripts/ux-simulator/generate.mjs',
    'scripts/ci/dashboard/collect.mjs',
    'scripts/verification/artifacts/pages-smoke.mjs',
    'scripts/ci/evidence/trace-receipt.mjs',
    '.github/workflows/repository-audit.yml',
    'docs/design/DEVELOPMENT-PAGES-UX.sdoc',
    'docs/architecture/MCP-V2-MIGRATION.sdoc',
    'docs/verification/CI-CD.sdoc',
    'docs/design/screen-catalog.json',
    'docs/architecture/diagrams/screen-1.mmd',
    'docs/requirements/codexia.sgra',
  ]) assert.equal(matchesWorkflowPaths(paths, [file]), true, file);
  for (const file of [
    'app/src/entries/desktop.tsx',
    'modules/mcp/src/tools.ts',
    'packages/api/src/server.ts',
    'packages/http-contract/src/contract.tsp',
    'deploy/ansible/deploy.yml',
    '.github/workflows/verify.yml',
    '.github/workflows/push-app-lifecycle.yml',
    'scripts/ci/impact/plan.mjs',
    'ios/CodexiaApp/Sources/Root.swift',
  ]) assert.equal(matchesWorkflowPaths(paths, [file]), false, file);
  assert.equal(matchesWorkflowPaths(paths, [
    'packages/api/src/server.ts', 'scripts/pages-api/pack.mjs',
  ]), true, 'mixed PR must retain Pages-owned admission');
});

test('MCP v2 migration edits select exact-source Verify trace proof', async () => {
  const file = 'docs/architecture/MCP-V2-MIGRATION.sdoc';
  assert.deepEqual((await plan([file])).tasks, ['mcp-conformance', 'coverage', 'architecture-g5', 'requirements-trace']);
  assert.equal(isTaskInputDocument(file, 'requirements-trace'), true);
});

test('Pages pack and deploy consume exact producer outputs across workflow attempts', () => {
  const workflow = parse(readFileSync(new URL('../../../.github/workflows/repository-audit.yml', import.meta.url), 'utf8'));
  const { audit, architecture, specification, pack, deploy } = workflow.jobs;
  assert.deepEqual(pack.needs, ['audit', 'architecture', 'specification']);
  const downloads = pack.steps.filter(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(downloads.length, 3);
  for (const [part, producer] of Object.entries({ audit, architecture, specification })) {
    const upload = producer.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    assert.equal(upload.with.name, 'pages-' + part + '-attempt-${{ github.run_attempt }}');
    assert.equal(producer.outputs['artifact-id'], '${{ steps.' + upload.id + '.outputs.artifact-id }}');
    const download = downloads.find(step => step.with.path.endsWith('/pages-' + part));
    assert.equal(download.with['artifact-ids'], '${{ needs.' + part + '.outputs.artifact-id }}');
    assert.equal(download.with.pattern, undefined);
  }
  const bind = pack.steps.find(step => step.id === 'publication');
  assert.equal(bind.env.PAGES_PRODUCER_ATTEMPT, '${{ needs.specification.outputs.producer-attempt }}');
  const upload = pack.steps.find(step => step.uses?.startsWith('actions/upload-pages-artifact@'));
  assert.equal(upload.with.name, '${{ steps.publication.outputs.artifact-name }}');
  assert.equal(deploy.needs, 'pack');
  assert.equal(deploy.steps.find(step => step.id === 'deployment').with.artifact_name, '${{ needs.pack.outputs.artifact-name }}');
  const verify = deploy.steps.find(step => step.id === 'projection');
  assert.equal(verify.name, 'Verify published Pages (${{ needs.pack.outputs.manifest-sha256 }})');
  assert.equal(verify.env.PAGES_MANIFEST_SHA256, '${{ needs.pack.outputs.manifest-sha256 }}');
  assert.equal(verify.env.PAGES_PRODUCER_ATTEMPT, '${{ needs.pack.outputs.producer-attempt }}');
});

test('UX projection source and Pages inputs select scoped canonical proofs', async () => {
  const { UX_PROJECTION_DOCUMENTS } = await import('../evidence/task-inputs.mjs');
  const { OPERATIONAL_ROOT_PATHS, OPERATIONAL_ROOT_PREFIXES } = await import('./plan.mjs');
  const pagesWorkflow = parse(readFileSync(new URL('../../../.github/workflows/repository-audit.yml', import.meta.url), 'utf8'));
  assert.ok(OPERATIONAL_ROOT_PREFIXES.includes('scripts/pages-ui/'));
  assert.ok(OPERATIONAL_ROOT_PREFIXES.includes('scripts/ux-simulator/'));
  assert.ok(matchesWorkflowPaths(pagesWorkflow.on.pull_request.paths, ['scripts/ux-simulator/generate.mjs']));
  for (const file of ['scripts/ux-simulator/generate.mjs', 'scripts/ux-simulator/compare/browser.mjs',
    'scripts/pages-ui/navigation.mjs', 'scripts/audit/ux-artifact.mjs', 'scripts/verification/artifacts/pages-smoke.mjs']) {
    const selected = await plan([file]);
    assert.ok(selected.tasks.includes('unit-root'), file);
    assert.ok(selected.tasks.includes('coverage'), file);
    assert.equal(selected.mode, 'affected', file);
    assert.equal(selected.full_model_oci, false, file);
    assert.ok(!selected.tasks.some(task => /^(?:build|oci|browser)-/u.test(task)), file);
  }
  for (const file of UX_PROJECTION_DOCUMENTS) {
    assert.ok(matchesWorkflowPaths(pagesWorkflow.on.pull_request.paths, [file]), `Pages must rebuild from ${file}`);
    const selected = await plan([file]);
    assert.ok(selected.tasks.includes('unit-root'), file);
    assert.equal(selected.full_model_oci, file === 'app/DESIGN.md', file);
    if (file.startsWith('docs/requirements/')) assert.ok(selected.tasks.includes('requirements-trace'), file);
  }
  for (const file of ['scripts/audit/ux-artifact.mjs', 'scripts/audit/ux-artifact.test.mjs',
    '.github/workflows/repository-audit.yml']) assert.ok(OPERATIONAL_ROOT_PATHS.includes(file), file);
  assert.equal((await plan(['scripts/ci/evidence/task-inputs.mjs'])).mode, 'full', 'shared CI evidence authority preserves full verification');
  const evidenceTest = await plan(['scripts/ci/evidence/task-inputs.test.mjs']);
  assert.equal(evidenceTest.mode, 'affected', 'root-only evidence contract test does not alter execution authority');
  assert.ok(evidenceTest.tasks.includes('unit-root'));
  assert.ok(evidenceTest.tasks.includes('coverage'));
  assert.equal(evidenceTest.full_model_oci, false);
});

test('Verify selects HTTP contract source comparison when any owning route source changes', async () => {
  const owners = [
    ['packages/api/src/server.ts', 'unit-api'],
    ['packages/api/src/persistence-routes.ts', 'unit-api'],
    ['packages/api/src/owner-setup.ts', 'unit-api'],
    ['packages/api/src/better-auth.ts', 'unit-api'],
    ['modules/mcp/src/http.ts', 'unit-mcp'],
    ['modules/publishing/src/http.ts', 'unit-publishing'],
  ];
  for (const [file, owner] of owners) {
    const selection = await plan([file]);
    assert.ok(selection.tasks.includes('unit-http-contract'), `${file} selects source-to-contract verification`);
    assert.ok(selection.tasks.includes(owner), `${file} retains its runtime source owner`);
    assert.ok(selection.groups.includes('unit-core'), `${file} runs the HTTP contract task’s existing Verify group`);
  }
});

test('generated Fastify artifact, registration adapter, and module route manifests invalidate HTTP and trace proofs', async () => {
  for (const file of [
    'packages/api/src/generated/http-contract.json',
    'packages/api/src/http-contributions.ts',
    'packages/api/package.json',
    'modules/mcp/package.json',
    'modules/publishing/package.json',
  ]) {
    const selection = await plan([file]);
    assert.ok(selection.tasks.includes('unit-http-contract'), `${file} selects HTTP route contract verification`);
    assert.ok(selection.tasks.includes('requirements-trace'), `${file} invalidates route provenance`);
  }
});

test('the shared CLI compatibility manifest selects both of its consumers', async () => {
  const selection = await plan(['cmd/codexiactl/release-contract.json']);
  assert.deepEqual(selection.tasks, ['unit-root', 'coverage', 'codexiactl-linux']);
  assert.equal(selection.full_model_oci, false);
});

test('iOS deployment documentation selects the root tests that assert its contents', async () => {
  const selection = await plan(['docs/deployment/IOS-CLIENT.sdoc']);
  assert.deepEqual(selection.tasks, ['unit-root', 'coverage', 'architecture-g5', 'requirements-trace']);
});

test('the relocated Ansible runbook selects its direct root verification consumer', async () => {
  const file = 'docs/deployment/ANSIBLE-PUSH-DEPLOYMENT.sdoc';
  const selection = await plan([file]);
  assert.deepEqual(selection.tasks, ['unit-root', 'coverage', 'architecture-g5', 'requirements-trace', 'codexiactl-linux']);
  assert.equal(isTaskInputDocument(file, 'unit-root'), true);
  assert.equal(selection.full_model_oci, false);
});

test('StrictDoc authority selects trace proof and the requirement register also selects its DB contract', async () => {
  for (const file of [
    'docs/requirements/REQUIREMENTS-GOVERNANCE.sdoc',
    'docs/requirements/REQUIREMENT-REGISTER.sdoc',
    'docs/requirements/STRICTDOC-TRACEABILITY.sdoc',
    'docs/requirements/codexia.sgra',
    'docs/architecture/DOCUMENTATION-AUTHORITY.sdoc',
    'docs/architecture/SPECIFICATION-IMPLEMENTATION-CONTRACT.sdoc',
    'docs/architecture/SPECIFICATION-TOOLCHAIN.sdoc',
    'docs/verification/TRACEABILITY-REGISTER.sdoc',
    'docs/verification/SPECIFICATION-TOOLING-ACCEPTANCE.sdoc',
    'scripts/strictdoc/verify.mjs',
    'scripts/strictdoc/strictdoc_config.py',
    'scripts/strictdoc/requirements.lock.txt',
  ]) {
    const selected = await plan([file]);
    const requirementRegister = file === 'docs/requirements/REQUIREMENT-REGISTER.sdoc';
    const uxAuthority = UX_PROJECTION_DOCUMENTS.includes(file);
    const architectureAuthority = file.startsWith('docs/architecture/');
    const toolingAcceptance = file === 'docs/verification/SPECIFICATION-TOOLING-ACCEPTANCE.sdoc';
    assert.deepEqual(selected.tasks, requirementRegister
      ? ['unit-root', 'db-contract', 'coverage', 'requirements-trace']
      : uxAuthority ? ['unit-root', 'coverage', 'requirements-trace']
        : architectureAuthority ? ['coverage', 'architecture-g5', 'requirements-trace']
          : toolingAcceptance ? ['db-contract', 'http-conformance', 'mcp-conformance', 'coverage', 'requirements-trace'] : ['coverage', 'requirements-trace'], file);
    assert.deepEqual(selected.groups, requirementRegister
      ? ['unit-core', 'unit-db', 'types-tests', 'types-trace']
      : uxAuthority ? ['unit-core', 'types-tests', 'types-trace']
        : architectureAuthority ? ['unit-architecture', 'types-tests', 'types-trace']
          : toolingAcceptance ? ['unit-db', 'types-tests', 'types-trace'] : ['types-tests', 'types-trace'], file);
  }
});

test('selects requirements trace for test-only source changes', async () => {
  for (const file of [
    'packages/api/src/server.test.ts',
    'tests/e2e/core.acceptance.spec.ts',
    'tests/integration/mcp-acceptance.test.mjs',
    'scripts/verification/artifacts/pages-live-ux.test.mjs',
    'scripts/strictdoc/verify.browser.mjs',
    'scripts/ux-simulator/compare/browser.mjs',
    'tests/conformance/http/discovery.test.mjs',
  ]) {
    assert.ok((await plan([file])).tasks.includes('requirements-trace'), file);
  }
});

test('changes to trace inputs select the existing trace task without dropping domain checks', async () => {
  for (const [file, owner] of [
    ['packages/api/src/server.ts', 'unit-api'],
    ['packages/api/src/generated/http-contract.json', 'unit-http-contract'],
    ['packages/http-contract/scripts/generate-fastify.mjs', 'unit-http-contract'],
    ['modules/mcp/src/tools/project.ts', 'unit-mcp'],
    ['packages/persistence-postgres/migrations/0001-initial.sql', 'db-contract'],
    ['packages/persistence-postgres/tests/db-contract/catalog-contract.json', 'db-contract'],
    ['docs/design/SCREEN-CONTROL-CATALOG.sdoc', null],
    ['docs/design/INTERACTION-CONTRACT.sdoc', null],
    ['app/src/entries/desktop.tsx', 'unit-app'],
    ['deploy/ansible/deploy.yml', 'unit-root'],
    ['deploy/ansible/site.yml', 'unit-root'],
    ['deploy/cloudflare/ui-routes.json', 'unit-root'],
    ['deploy/cloudflare/identity-probes.json', 'codexiactl-linux'],
    ['deploy/cloudflare/public-protocol-paths.json', 'codexiactl-linux'],
    ['cmd/codexiactl/cloudflare_managed_edge.go', 'codexiactl-linux'],
    ['cmd/codexiactl/cloudflare_deployment_contract_test.go', 'codexiactl-linux'],
    ['ios/CodexiaApp/Sources/CodexiaApp.swift', 'unit-root'],
    ['deploy/backup/backup.sh', 'db-contract'],
  ]) {
    const selection = await plan([file]);
    assert.ok(selection.tasks.includes('requirements-trace'), file);
    if (owner) assert.ok(selection.tasks.includes(owner), file);
  }
  const unrelated = await plan(['docs/design/UX-SIMULATOR.md']);
  assert.ok(!unrelated.tasks.includes('requirements-trace'));
});

test('Full-model OCI selection follows the standalone workflow and the Verify caller', async () => {
  const { FULL_MODEL_OCI_PATHS, matchesFullModelOciPath } = await import('./plan.mjs');
  const standalone = parse(readFileSync(new URL('../../../.github/workflows/full-model-oci-acceptance.yml', import.meta.url), 'utf8'));
  const pushPaths = standalone.on.push.paths;
  assert.equal(Object.hasOwn(standalone.on, 'workflow_call'), true);
  assert.equal(standalone.on.workflow_dispatch, null);
  assert.deepEqual(standalone.on.push.branches, ['main']);
  assert.equal(Object.hasOwn(standalone.on, 'pull_request'), false);
  assert.deepEqual(pushPaths, FULL_MODEL_OCI_PATHS.filter(file => file !== '.github/workflows/verify.yml'));

  // Verify the standalone GitHub glob selector against the independent PR selector.
  // A synthetic path containing glob metacharacters can be unclassified and thus
  // conservatively select the model even when a standalone exclusion matches.
  for (const expression of pushPaths) {
    const pattern = expression.startsWith('!') ? expression.slice(1) : expression;
    const changedPath = pattern.endsWith('/**') ? `${pattern.slice(0, -3)}/ci-impact-sentinel.mjs` : pattern;
    const standaloneSelected = matchesWorkflowPaths(pushPaths, [changedPath]);
    assert.equal(matchesFullModelOciPath(changedPath), standaloneSelected,
      `Main push and PR glob policy disagree: ${changedPath}`);
    if (standaloneSelected) assert.equal((await plan([changedPath])).full_model_oci, true,
      `An admitted standalone model input cannot be dropped by the PR plan: ${changedPath}`);
  }
  assert.equal((await plan(['.github/workflows/verify.yml'])).full_model_oci, true, 'Verify caller changes require its model proof');
  assert.equal((await plan(['docs/deployment/IAC.sdoc'])).full_model_oci, false,
    'Reviewed deployment documentation is not a real-model input');
  // Valid but unclassified inputs have no complete exclusion proof: PR admission fails closed.
  // The standalone main push path selector remains explicitly owned and independently tested.
  for (const changedPath of [
    '.github/workflows/other.yml',
    'profiles-old/full/config.json',
    'tests/integration/unrelated.acceptance.mjs',
  ]) {
    assert.equal(matchesWorkflowPaths(pushPaths, [changedPath]), false,
      `Unclassified input is not in the standalone main push closure: ${changedPath}`);
    const selected = await plan([changedPath]);
    assert.equal(selected.mode, 'full', `Unclassified path requires full verification: ${changedPath}`);
    assert.equal(selected.full_model_oci, true, `Unclassified path requires conservative PR real-model proof: ${changedPath}`);
  }
  for (const [label, files, expected] of [
    ['DB contract-only test', ['packages/persistence-postgres/tests/db-contract/runner.test.mjs'], false],
    ['HTTP contract-only test', ['packages/http-contract/test/fastify-persistence-registration.test.ts'], false],
    ['MCP unit test in src', ['modules/mcp/src/tool-catalog.test.ts'], false],
    ['Declared module test fixture outside src', ['modules/assistant/tests/browser-workflow.acceptance.mjs'], false],
    ['Declared package fixture outside src', ['packages/api/test/fixtures/better-auth-server.ts'], false],
    ['Core unit test in src', ['packages/core/src/snapshot-reuse.test.ts'], false],
    ['Desktop unit test', ['app/src/api-generated.test.ts'], false],
    ['Native Swift source', ['ios/CodexiaTransport/Sources/CodexiaAPI/Client.swift'], false],
    ['Backend source', ['packages/api/src/server.ts'], true],
    ['Desktop source', ['app/src/api.ts'], true],
    ['Real-model fixture', ['tests/integration/model-oci-lifecycle-arguments.test.mjs'], true],
    ['Profile packager', ['scripts/build/packaging/profile-package.mjs'], true],
    ['Model admission policy', ['scripts/ci/impact/plan.mjs'], true],
    ['API emitted test', ['packages/api/src/server.test.ts'], true],
    ['API emitted spec', ['packages/api/src/server.spec.ts'], true],
    ['API emitted test helper', ['packages/api/src/test/fixtures.ts'], true],
    ['Core compiled spec input', ['packages/core/src/new.spec.ts'], true],
    ['Module compiled spec input', ['modules/mcp/src/worker.spec.ts'], true],
    ['Module emitted test helper', ['modules/mcp/src/test/fixture.ts'], true],
    ['Database emitted test helper', ['packages/persistence-postgres/src/tests/fixture.ts'], true],
    ['Nested module emitted helper', ['modules/mcp/src/domain/test/fixture.ts'], true],
    ['Nested database emitted helper', ['packages/persistence-postgres/src/domain/tests/fixture.ts'], true],
    ['Nested desktop typechecked helper', ['app/src/editor/test/fixture.ts'], true],
    ['Desktop typechecked spec input', ['app/src/editor.spec.ts'], true],
    ['Persistence contract emitted test', ['packages/persistence-contracts/src/index.test.ts'], true],
    ['Persistence contract emitted spec', ['packages/persistence-contracts/src/index.spec.ts'], true],
    ['Persistence contract emitted test helper', ['packages/persistence-contracts/src/tests/helpers.ts'], true],
    ['Mixed source and test', ['modules/mcp/src/tool-catalog.test.ts', 'packages/api/src/server.ts'], true],
  ]) {
    assert.equal(matchesWorkflowPaths(pushPaths, files), expected, `standalone model trigger: ${label}`);
    assert.equal((await plan(files)).full_model_oci, expected, `PR model selection: ${label}`);
  }
  assert.equal((await plan(null)).full_model_oci, true, 'Unknown PR diff must fail closed for the supplemental model proof');
  const unreviewedNativeCode = ['ios/CodexiaTransport/Sources/CodexiaAPI/unreviewed.mjs'];
  assert.equal(matchesWorkflowPaths(pushPaths, unreviewedNativeCode), false);
  assert.equal((await plan(unreviewedNativeCode)).full_model_oci, true,
    'Only the explicitly native Swift source extension can bypass supplemental model admission');
  // An undeclared nested fixture is not a standalone main-push model input,
  // but an unclassified PR path cannot prove the real-model test is irrelevant.
  const unknownNestedFixture = ['app/unknown/test/new-fixture.mjs'];
  assert.equal(matchesWorkflowPaths(pushPaths, unknownNestedFixture), false);
  const unknownNestedPlan = await plan(unknownNestedFixture);
  assert.equal(unknownNestedPlan.mode, 'full');
  assert.equal(unknownNestedPlan.full_model_oci, true);

  // A valid but unclassified path selects full verification; Full-model OCI cannot
  // silently disappear merely because it was absent from the older allowlist.
  for (const unknown of ['scripts/new-unclassified-ci-helper.mjs', 'tests/new-domain/acceptance.mjs', 'docs/new-executable-policy.json']) {
    const selected = await plan([unknown]);
    assert.equal(selected.mode, 'full', `Unclassified path needs full verification: ${unknown}`);
    assert.equal(selected.full_model_oci, true, `Unclassified path needs conservative model admission: ${unknown}`);
  }
  for (const invalid of ['', '/packages/api/src/server.ts', '../packages/api/src/server.ts', 'packages\\api\\src\\server.ts']) {
    const selected = await plan([invalid]);
    assert.equal(selected.mode, 'full', 'Invalid changed paths must select full verification');
    assert.equal(selected.full_model_oci, true, 'Invalid changed paths must not suppress real-model proof');
  }
  assert.equal((await plan(['profiles/full/config.json'], 'push')).full_model_oci, false);

  const verify = parse(readFileSync(new URL('../../../.github/workflows/verify.yml', import.meta.url), 'utf8'));
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
    assert.ok(selected.tasks.includes(`browser-${profile}-ui-v1`));
    assert.ok(selected.tasks.includes(`browser-${profile}-core`));
  }
  assert.ok(!selected.tasks.includes('unit-api'));
});

const NON_SWIFT_TASKS = VERIFICATION_TASKS.filter(task => task !== 'swift-linux');
const SWIFT_LINUX_RECIPES = ['scripts/ios/verify-linux-swift.sh', 'scripts/ios/swift-linux-toolchain.json'];

test('main, manual, shared contracts, lockfiles, manifests and unknown files fail closed to full verification', async () => {
  for (const [files, event] of [
    [['modules/search/src/browser.ts'], 'push'], [[], 'workflow_dispatch'],
    [['packages/contracts/src/index.ts'], 'pull_request'],
    [['packages/persistence-contracts/src/index.ts'], 'pull_request'],
    [['packages/persistence-postgres/src/postgres-store.ts'], 'pull_request'],
    [['packages/persistence-postgres/migrations/0002-anchor-ranges.sql'], 'pull_request'],
    [['pnpm-lock.yaml'], 'pull_request'],
    [['modules/search/package.json'], 'pull_request'], [['new-root-file'], 'pull_request'],
    [null, 'pull_request'],
  ]) {
    assert.deepEqual((await plan(files, event)).tasks, files === null || files.includes('pnpm-lock.yaml') ? VERIFICATION_TASKS : NON_SWIFT_TASKS);
  }
});

test('test-only changes select their owner while non-executable documentation selects inventory only', async () => {
  const selected = await plan(['modules/search/src/browser.test.ts']);
  assert.ok(selected.tasks.includes('unit-search'));
  assert.ok(selected.tasks.includes('test-types-modules'));
  assert.ok(!selected.tasks.includes('build-full'));
  assert.deepEqual((await plan(['docs/authoring.sdoc'])).tasks, ['coverage', 'requirements-trace']);
});

test('PostgreSQL contract fixture changes select the real database contract lane', async () => {
  for (const file of [
    'packages/persistence-postgres/tests/db-contract/application-contract.sql',
    'packages/persistence-postgres/tests/db-contract/toolchain.json',
    'scripts/postgres-contract/contract-runner.mjs',
  ]) {
    const selected = await plan([file]);
    assert.ok(selected.tasks.includes('db-contract'), file);
    assert.ok(selected.tasks.includes('unit-persistence-postgres'), file);
    assert.ok(selected.tasks.includes('typecheck-foundations'), file);
    assert.equal(selected.mode, 'affected', file);
  }
});

test('DB contract source authorities select DB proof while retaining trace and architecture owners', async () => {
  for (const file of [
    'docs/architecture/POSTGRES-CONTRACT-VERIFICATION.sdoc',
    'docs/architecture/DATABASE-DETAIL-CONTRACT.sdoc',
    'docs/architecture/DATA-MODEL.sdoc',
    'docs/requirements/REQUIREMENT-REGISTER.sdoc',
    'docs/verification/SPECIFICATION-TOOLING-ACCEPTANCE.sdoc',
    'deploy/ansible/verify-postgres-roles.sql',
    'packages/api/src/auth-schema.ts',
    'packages/api/src/migrate-auth.ts',
    'packages/persistence-postgres/src/migrate.ts',
    'packages/persistence-postgres/src/migration-set.ts',
  ]) {
    const selected = await plan([file]);
    assert.ok(selected.tasks.includes('db-contract'), file);
  }
  assert.ok((await plan(['docs/requirements/REQUIREMENT-REGISTER.sdoc'])).tasks.includes('requirements-trace'));
  assert.ok((await plan(['docs/architecture/POSTGRES-CONTRACT-VERIFICATION.sdoc'])).tasks.includes('architecture-g5'));
});

test('the canonical age backup script selects both DBV-007 and existing root backup verification', async () => {
  const selected = await plan(['deploy/backup/backup.sh']);
  assert.equal(selected.mode, 'affected');
  assert.deepEqual(selected.tasks, ['unit-root', 'db-contract', 'coverage', 'requirements-trace']);
});

test('existing PostgreSQL migration changes retain full verification', async () => {
  const selected = await plan(['packages/persistence-postgres/migrations/0002-orphaned-evidence-ranges.sql']);
  assert.equal(selected.mode, 'full');
  assert.deepEqual(selected.tasks, NON_SWIFT_TASKS);
});

test('architecture design documents select G5 in the existing Verify unit matrix', async () => {
  const { verificationPlanOutputs } = await import('./plan.mjs');
  const selected = await plan([
    'docs/architecture/SYSTEM-DESIGN.sdoc',
    'docs/architecture/THREAT-MODEL.sdoc',
    'docs/verification/ARCHITECTURE-ATLAS.sdoc',
  ]);
  assert.deepEqual(selected.tasks, ['coverage', 'architecture-g5', 'requirements-trace']);
  assert.deepEqual(selected.groups, ['unit-architecture', 'types-tests', 'types-trace']);
  const outputs = verificationPlanOutputs(selected);
  assert.deepEqual(JSON.parse(outputs.unit), ['architecture']);
  assert.deepEqual(JSON.parse(outputs.types), ['tests', 'trace']);
  assert.deepEqual((await plan(['docs/architecture/API-AUTHN-AUTHZ.sdoc'])).tasks, ['coverage', 'architecture-g5', 'requirements-trace']);
  assert.deepEqual((await plan(['docs/security/authorization.md'])).tasks, ['coverage', 'architecture-g5']);
  assert.deepEqual((await plan(['docs/deployment/IAC.sdoc'])).tasks, ['unit-root', 'coverage', 'architecture-g5', 'requirements-trace']);

  for (const file of [
    'docs/architecture/likec4/model.likec4',
    'docs/architecture/threagile/model.yaml',
    'scripts/architecture/verify.mjs',
    'scripts/architecture/package-lock.json',
    'scripts/architecture-diagrams/pack.mjs',
  ]) {
    const modelSource = await plan([file]);
    assert.deepEqual(modelSource.tasks, NON_SWIFT_TASKS, file);
    assert.ok(modelSource.tasks.includes('architecture-g5'), file);
  }
});

test('impact selection is independent of proof availability; unknown diffs still fail closed', async () => {
  const { createVerificationPlan, verificationPlanOutputs } = await import('./plan.mjs');
  const input = { event: 'pull_request', sha: 'a'.repeat(40), base: 'b'.repeat(40) };
  const affected = createVerificationPlan({ ...input, files: ['docs/authoring.sdoc'] });
  assert.equal(affected.mode, 'affected');
  assert.deepEqual(affected.tasks, ['coverage', 'requirements-trace']);
  assert.equal(affected.excluded.length, VERIFICATION_TASKS.length - 2);
  assert.deepEqual(JSON.parse(verificationPlanOutputs(affected).types), ['tests', 'trace']);

  const unknown = createVerificationPlan({ ...input, files: null });
  assert.equal(unknown.mode, 'full');
  assert.deepEqual(unknown.tasks, VERIFICATION_TASKS);
  assert.deepEqual(JSON.parse(verificationPlanOutputs(unknown).unit), ['core', 'api', 'db', 'modules', 'architecture']);
  assert.deepEqual(createVerificationPlan({ ...input, files: ['unknown.js'] }).tasks, NON_SWIFT_TASKS);
  assert.equal(createVerificationPlan({ ...input, files: ['docs/authoring.sdoc'], event: 'push' }).mode, 'full');
});

test('certification rejects tampered PR base or changed-file inventory without historical proofs', async () => {
  const { createVerificationPlan, assertExactPrImpact } = await import('./plan.mjs');
  const input = { event: 'pull_request', sha: 'a'.repeat(40), base: 'b'.repeat(40) };
  const affected = createVerificationPlan({ ...input, files: ['docs/architecture/SYSTEM-DESIGN.sdoc'] });
  assert.doesNotThrow(() => assertExactPrImpact(affected, input.base, affected.files));
  assert.throws(() => assertExactPrImpact(affected, 'c'.repeat(40), affected.files), /PR base/);
  assert.throws(() => assertExactPrImpact(affected, input.base, ['packages/api/src/server.ts']), /exact PR diff/);
  assert.throws(() => assertExactPrImpact(affected, input.base, null), /exact PR diff/);
  const full = createVerificationPlan({ ...input, files: null });
  assert.doesNotThrow(() => assertExactPrImpact(full, input.base, null), 'Unknown diff already selects full verification');
  assert.throws(() => assertExactPrImpact(full, 'c'.repeat(40), null), /PR base/);
  const knownFull = createVerificationPlan({ ...input, files: ['pnpm-lock.yaml'] });
  assert.throws(() => assertExactPrImpact(knownFull, input.base, ['pnpm-lock.yaml', 'ios/CodexiaEditor/Package.swift']),
    /exact PR diff/, 'Full plans must not omit a changed Swift input');
});

test('OAuth browser acceptance is selected in both profile browser lanes', async () => {
  const selected = await plan(['tests/e2e/oauth-web.acceptance.spec.ts']);
  assert.ok(selected.tasks.includes('test-types-app-e2e'));
  for (const profile of ['core', 'full']) {
    assert.ok(selected.tasks.includes(`build-${profile}`));
    assert.ok(selected.tasks.includes(`browser-${profile}-oauth-web`));
    assert.ok(selected.groups.includes(`browser-${profile}-reference`));
    assert.ok(!selected.groups.includes(`browser-${profile}-ui-v1`));
  }
  assert.ok(!selected.tasks.includes('unit-api'));
});

test('UI review screenshot upload follows selected visual tasks in the browser matrix', async () => {
  const workflow = parse(readFileSync(new URL('../../../.github/workflows/verify.yml', import.meta.url), 'utf8'));
  const profileWorkflow = parse(readFileSync(new URL('../../../.github/workflows/verify-profile.yml', import.meta.url), 'utf8'));
  const upload = profileWorkflow.jobs.browser.steps.find(step => step.with?.name?.startsWith('ui-refinement-visual-'));
  const { verificationPlanOutputs } = await import('./plan.mjs');

  for (const [file, captureUiReview] of [['recent-activity', false], ['redesign-visual', true]]) {
    const selected = await plan([`tests/e2e/${file}.acceptance.spec.ts`]);
    const outputs = verificationPlanOutputs(selected);
    for (const profile of ['core', 'full']) {
      assert.deepEqual(JSON.parse(outputs[`browser_${profile}`]), [{
        group: `${profile}-reference`, profile, captureUiReview,
      }]);
    }
  }
  assert.equal(upload.if, 'always() && matrix.captureUiReview');
  assert.equal(upload.with['if-no-files-found'], 'error');
});

test('every selected task has one execution group and every exclusion has a reason', async () => {
  const { VERIFICATION_GROUPS } = await import('./contract.mjs');
  const selected = await plan(['app/src/editor/SceneEditor.tsx']);
  assert.deepEqual(selected.groups, Object.keys(VERIFICATION_GROUPS).filter(group => VERIFICATION_GROUPS[group].some(task => selected.tasks.includes(task))));
  assert.equal(selected.excluded.length + selected.tasks.length, VERIFICATION_TASKS.length);
  assert.ok(selected.excluded.every(item => item.reason && !selected.tasks.includes(item.task)));
});

test('known operational inputs retain root proof and trace evidence for registered test sources', async () => {
  const { OPERATIONAL_ROOT_PATHS } = await import('./plan.mjs');
  for (const file of [
    'deploy/systemd/codexia-api.socket',
    'deploy/systemd/codexia-api-gate.service',
    'cmd/codexiactl/assets/codexia-cloudflared.service',
    'scripts/deployment/ssh/cloudflared-proxy.sh',
    'scripts/deployment/ssh/install-cloudflared.sh',
  ]) assert.ok(OPERATIONAL_ROOT_PATHS.includes(file), file);
  assert.ok(OPERATIONAL_ROOT_PATHS.includes('deploy/ansible/prepare-api-gate.yml'));
  for (const file of OPERATIONAL_ROOT_PATHS) {
    const selected = await plan([file]);
    const expected = file === 'deploy/backup/backup.sh'
      ? ['unit-root', 'db-contract', 'coverage', 'requirements-trace']
      : file.startsWith('cmd/codexiactl/')
        ? ['unit-root', 'coverage', 'codexiactl-linux']
      : file.startsWith('docs/deployment/')
        ? ['unit-root', 'coverage', 'architecture-g5', 'requirements-trace']
        : file.startsWith('edge/frontend/') && /\.[cm]?[jt]sx?$/u.test(file)
          ? ['unit-root', 'coverage', 'biome-ci']
          : ['unit-root','coverage'];
    if (!expected.includes('requirements-trace') && [
      '.github/workflows/backend-deployment-handoff.yml', '.github/workflows/push-backup.yml',
      'deploy/ansible/deploy-transaction.yml', 'deploy/ansible/deploy.yml',
      'deploy/ansible/restore-drill.yml', 'deploy/backup/s3_transfer.py',
      'docs/deployment/BACKUP.sdoc', 'docs/deployment/DEPLOYMENT-REFERENCE.sdoc',
    ].includes(file)) expected.push('requirements-trace');
    if (file.startsWith('deploy/ansible/') && /\.ya?ml$/u.test(file) && !expected.includes('requirements-trace')) expected.push('requirements-trace');
    if (file.startsWith('deploy/cloudflare/') && file.endsWith('.json') && !expected.includes('requirements-trace')) expected.push('requirements-trace');
    if (isTraceTestSource(file) && !expected.includes('requirements-trace')) expected.push('requirements-trace');
    if (SWIFT_LINUX_RECIPES.includes(file)) expected.push('swift-linux');
    if (file === 'deploy/production.json' || file === '.github/workflows/production-preflight.yml' || ['docs/deployment/ACCESS-POLICY-MIGRATION.sdoc', 'docs/deployment/ANSIBLE-PUSH-DEPLOYMENT.sdoc'].includes(file) ||
        /^deploy\/cloudflare\/[^/]+\.json$/u.test(file)) expected.push('codexiactl-linux');
    assert.deepEqual(selected.tasks, expected, file);
    assert.equal(selected.full_model_oci, false, file);
  }
  for (const file of ['deploy/ansible/new-stage.yml','deploy/backup/new-runtime.mjs','scripts/new-tool.mjs','.github/workflows/unknown.yml']) {
    assert.deepEqual((await plan([file])).tasks, NON_SWIFT_TASKS, file);
  }
  const mixed = await plan(['deploy/ansible/host.yml','app/src/api.ts']);
  assert.ok(mixed.tasks.includes('unit-root') && mixed.tasks.includes('unit-app') && mixed.tasks.includes('browser-core-core'));
  assert.deepEqual((await plan(['deploy/ansible/host.yml','pnpm-lock.yaml'])).tasks, VERIFICATION_TASKS);
  assert.deepEqual((await plan(['deploy/ansible/host.yml'], 'push')).tasks, NON_SWIFT_TASKS);
  assert.deepEqual((await plan(null)).tasks, VERIFICATION_TASKS);
});

test('operational proof remains owned by one exact-head root task and matching independent workflows', async () => {
  const { OPERATIONAL_ROOT_PATHS } = await import('./plan.mjs');
  const readWorkflow = name => parse(readFileSync(new URL('../../../.github/workflows/'+name, import.meta.url), 'utf8'));
  const infra = readWorkflow('deployment-config.yml');
  for (const event of ['pull_request','push']) {
    assert.deepEqual(infra.on[event].branches, ['main'], event);
    for (const path of ['deploy/ansible/**','deploy/backup/**','deploy/quadlet/**','deploy/systemd/**','deploy/postgres/**',
      'cmd/codexiactl/assets/codexia-cloudflared.service']) {
      assert.ok(infra.on[event].paths.includes(path), path);
    }
  }
  assert.equal(infra.jobs.configuration.steps.find(s=>s.uses?.startsWith('actions/checkout')).with.ref, '${{ github.event.pull_request.head.sha || github.sha }}');
  const root = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url),'utf8'));
  for (const command of ['verify:deployment','typecheck:deployment','test:deployment']) {
    assert.ok(root.scripts['test:scripts'].includes('pnpm run '+command));
    assert.ok(!JSON.stringify(infra.jobs).includes('pnpm run '+command));
    assert.ok(!JSON.stringify(readWorkflow('frontend-release.yml').jobs).includes('pnpm run '+command));
  }
  assert.ok(OPERATIONAL_ROOT_PATHS.includes('docs/deployment/DEPLOYMENT-REFERENCE.sdoc'));
  assert.ok(OPERATIONAL_ROOT_PATHS.includes('docs/deployment/BACKUP.sdoc'));
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
  const workflow = parse(readFileSync(new URL('../../../.github/workflows/ansible-base-secrets.yml', import.meta.url), 'utf8'));
  const fixture = workflow.jobs['rootless-secrets'].steps.find(step => step.env?.ANSIBLE_PLAYBOOK);
  assert.equal(fixture.env.ANSIBLE_PLAYBOOK, '${{ github.workspace }}/' + launcher);
  for (const event of ['pull_request', 'push']) {
    assert.deepEqual(workflow.on[event].branches, ['main'], event);
    assert.ok(workflow.on[event].paths.includes(launcher), event);
  }
  assert.deepEqual((await plan([launcher])).tasks, ['unit-root', 'coverage']);
  const shared = 'app/src/api-transport.ts';
  assert.deepEqual((await plan([launcher, shared])).tasks, (await plan([shared])).tasks);
  for (const event of ['push', 'workflow_dispatch']) {
    assert.equal((await plan([launcher], event)).mode, 'full');
  }
});

test('Orval manifest and transport changes verify the deployment API route assertion', async () => {
  for (const file of ['app/src/api-transport.ts', 'app/orval.config.mjs', 'app/scripts/generate-http.mjs', 'app/scripts/orval-desktop-transformer.mjs']) {
    const selected = await plan([file]);
    assert.ok(selected.tasks.includes('unit-root'), file);
    assert.ok(selected.tasks.includes('unit-app'), file);
  }
});

test('the native Swift app owns manual unsigned IPA packaging', () => {
  const native = parse(readFileSync(new URL('../../../.github/workflows/ios-editor.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(native.on), ['workflow_dispatch']);
  const ipa = native.jobs['native-ipa'];
  assert.equal(ipa.if, "${{ github.event_name == 'workflow_dispatch' }}");
  assert.equal(ipa['runs-on'], 'xcode-27');
  assert.ok(ipa.steps.some(step => step.run?.includes('ios/CodexiaApp/Scripts/package-unsigned-ipa.swift')));
  assert.deepEqual(native.jobs.editor.strategy.matrix.lane, ['state-model', 'editor-simulator', 'app-simulator']);
});

test('CI contract-test changes select root, coverage, and trace for test sources, including the iOS freeze diff', async () => {
  const paths = ['scripts/ci/impact/plan.test.mjs', 'scripts/ci/evidence/proof-reuse.test.mjs',
    'scripts/ci/certification/reuse-merged-pr.test.mjs'];
  for (const file of paths) {
    const result = await plan([file]);
    assert.equal(result.mode, 'affected', file);
    assert.deepEqual(result.tasks, isTraceTestSource(file)
      ? ['unit-root', 'coverage', 'requirements-trace']
      : ['unit-root', 'coverage'], file);
    assert.equal(result.full_model_oci, false, file);
  }
  const freeze = await plan([...paths, '.github/workflows/ios-api.yml', '.github/workflows/ios-editor.yml']);
  assert.deepEqual(freeze.tasks, ['unit-root', 'coverage', 'requirements-trace']);
  for (const file of ['scripts/ci/impact/plan.mjs', 'scripts/ci/evidence/proof-reuse.mjs', 'scripts/ci/impact/unknown.test.mjs']) {
    const result = await plan([...paths, file]);
    assert.deepEqual(result.tasks, file === 'scripts/ci/impact/plan.mjs' ? VERIFICATION_TASKS : NON_SWIFT_TASKS, file);
    assert.equal(result.full_model_oci, true, file);
  }
});

test('root, native document, and coverage-only plans have a single owner for contract test execution', async () => {
  const runner = readFileSync(new URL('../execution/group.mjs', import.meta.url),'utf8');
  const root = JSON.parse(readFileSync(new URL('../../../package.json',import.meta.url),'utf8'));
  assert.match(root.scripts['test:scripts'], /node --test 'scripts\/\*\*\/\*\.test\.mjs'/u);
  assert.match(runner, /if \(!plan\.tasks\.includes\('unit-root'\)\) await node\('--test', 'scripts\/ci\/impact\/contract\.test\.mjs'/u);
  assert.deepEqual((await plan(['docs/authoring.sdoc'])).tasks, ['coverage', 'requirements-trace']);
  assert.deepEqual((await plan(['deploy/ansible/host.yml'])).tasks, ['unit-root','coverage','requirements-trace']);
});

test('push backup changes and registered tests retain trace selection with independent exact-head verification', async () => {
  const backup = parse(readFileSync(new URL('../../../.github/workflows/push-backup.yml', import.meta.url), 'utf8'));
  const source = [
    'deploy/backup/backup.sh',
    'deploy/ansible/deploy.yml',
    'deploy/ansible/restore-drill.yml',
    'deploy/ansible/push-deployment-recover.sh',
    'scripts/deployment/recovery/backup.test.mjs',
    'scripts/deployment/recovery/recovery.test.mjs',
    '.github/workflows/push-backup.yml',
  ];
  for (const file of source) {
    const expected = file === 'deploy/backup/backup.sh'
      ? ['unit-root', 'db-contract', 'coverage', 'requirements-trace']
      : ['unit-root', 'coverage'];
    if (['deploy/ansible/deploy.yml', 'deploy/ansible/restore-drill.yml', '.github/workflows/push-backup.yml'].includes(file)) {
      expected.push('requirements-trace');
    }
    if (isTraceTestSource(file) && !expected.includes('requirements-trace')) expected.push('requirements-trace');
    assert.deepEqual((await plan([file])).tasks, expected, file);
    assert.equal((await plan([file])).full_model_oci, false, file);
    for (const event of ['pull_request', 'push']) {
      const paths = backup.on[event].paths;
      assert.ok(paths.some(p => p === file || (p.endsWith('/**') && file.startsWith(p.slice(0, -2)))), file);
    }
  }
  const steps = backup.jobs['backup-contract'].steps;
  assert.equal(steps.find(s => s.uses?.startsWith('actions/checkout')).with.ref, '${{ github.event.pull_request.head.sha || github.sha }}');
  assert.ok(steps.some(s => s.run?.includes('bash -n deploy/backup/backup.sh')));
  assert.ok(steps.some(s => s.run?.includes('scripts/deployment/recovery/backup.test.mjs')));
  assert.deepEqual((await plan([...source, 'pnpm-lock.yaml'])).tasks, VERIFICATION_TASKS);
  assert.deepEqual((await plan(source, 'push')).tasks, NON_SWIFT_TASKS);
});

test('CI dashboard changes remain root-scoped, mixed source remains fully covered', async () => {
  for (const file of [
    'scripts/ci/dashboard/analysis.mjs',
    'scripts/ci/dashboard/site/dashboard.js',
  ]) {
    assert.deepEqual((await plan([file])).tasks, ['unit-root', 'coverage'], file);
    assert.equal((await plan([file])).full_model_oci, false);
  }
  const mixedSource = await plan(['scripts/ci/dashboard/analysis.mjs', 'app/src/entries/desktop.tsx']);
  assert.ok(mixedSource.tasks.includes('build-full') && mixedSource.tasks.includes('browser-full-ui-v1'));
  assert.deepEqual((await plan(['scripts/ci/dashboard/analysis.mjs', 'unknown/unreviewed.txt'])).tasks, NON_SWIFT_TASKS);
  assert.deepEqual((await plan(['scripts/ci/dashboard/analysis.mjs'], 'push')).tasks, NON_SWIFT_TASKS);
});

test('the Passkey browser acceptance source selects its owner proofs and trace evidence', async () => {
  const baseExpected = ['unit-api', 'typecheck-core-api', 'test-types-packages', 'build-core', 'browser-core-passkey-bootstrap', 'coverage', 'biome-ci'];
  for (const [file, expectedModelOci] of [
    ['packages/api/test/passkey-bootstrap.acceptance.test.ts', false],
    ['packages/api/scripts/run-passkey-acceptance.mjs', true],
  ]) {
    const result = await plan([file]);
    const expected = isTraceTestSource(file) ? [...baseExpected, 'requirements-trace'] : baseExpected;
    assert.deepEqual(result.tasks, expected, file);
    assert.equal(result.mode, 'affected', file);
    assert.equal(result.full_model_oci, expectedModelOci, `Full-model OCI admission: ${file}`);
  }
  const browserSpec = await plan(['tests/e2e/passkey-bootstrap.acceptance.spec.ts']);
  assert.ok(browserSpec.tasks.includes('browser-core-passkey-bootstrap'));
  assert.ok(browserSpec.tasks.includes('browser-full-passkey-bootstrap'));
  assert.ok(browserSpec.tasks.includes('test-types-app-e2e'));
});

test('Backup Console browser coverage selects its existing profile reference lanes', async () => {
  const selected = await plan(['tests/e2e/backup-console.acceptance.spec.ts']);
  assert.equal(selected.mode, 'affected');
  assert.ok(selected.tasks.includes('test-types-app-e2e'));
  for (const profile of PROFILES) {
    assert.ok(selected.tasks.includes(`browser-${profile}-backup-console`));
    assert.ok(selected.groups.includes(`browser-${profile}-reference`));
  }
});

test('native Swift-only PR inputs select owner contract without unrelated Desktop or OCI jobs', async () => {
  const owned = [
    '.github/workflows/ios-api.yml',
    '.github/workflows/ios-editor.yml',
    'ios/CodexiaTransport/.gitignore',
    'ios/CodexiaTransport/Package.swift',
    'ios/CodexiaTransport/Package.resolved',
    'ios/CodexiaTransport/check-operation-manifest.py',
    'ios/CodexiaTransport/generate.sh',
    'ios/CodexiaTransport/normalize-openapi.py',
    'ios/CodexiaTransport/openapi-generator-config.yaml',
    'ios/CodexiaTransport/KeychainProbe/KeychainHost.entitlements',
    'ios/CodexiaTransport/KeychainProbe/KeychainProbe.xcodeproj/project.pbxproj',
    'ios/CodexiaTransport/KeychainProbe/KeychainProbe.xcodeproj/xcshareddata/xcschemes/KeychainProbe.xcscheme',
    'ios/CodexiaTransport/Sources/CodexiaAPI/Client.swift',
    'ios/CodexiaTransport/Tests/CodexiaTransportTests/OAuthTests.swift',
    'ios/CodexiaApp/CodexiaApp.xcodeproj/project.pbxproj',
    'ios/CodexiaApp/UITests/AuthoringFlowUITests.swift',
    'ios/CodexiaEditor/.gitignore',
    'ios/CodexiaEditor/Package.swift',
    'ios/CodexiaEditor/Sources/CodexiaEditor/ManuscriptEditor.swift',
  ];
  for (const file of owned) {
    const result = await plan([file]);
    assert.equal(result.mode, 'affected', file);
    const expected = file.endsWith('.swift')
      ? ['unit-root', 'coverage', 'requirements-trace']
      : ['unit-root', 'coverage'];
    if (!file.endsWith('/.gitignore') &&
        (file.startsWith('ios/CodexiaEditor/') ||
          (file.startsWith('ios/CodexiaTransport/') && !file.includes('/KeychainProbe/')))) {
      expected.push('swift-linux');
    }
    assert.deepEqual(result.tasks, expected, file);
    assert.equal(result.full_model_oci, false, file);
  }
  assert.deepEqual((await plan(owned)).tasks, ['unit-root', 'coverage', 'requirements-trace', 'swift-linux']);
  const nativeApi = parse(readFileSync(new URL('../../../.github/workflows/ios-api.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(nativeApi.on), ['workflow_dispatch']);
  assert.equal(nativeApi.jobs.api['runs-on'], 'xcode-27');
});

test('Linux Swift verification follows SwiftPM and generation inputs even in full plans', async () => {
  for (const event of ['pull_request', 'push']) {
    for (const file of [
      'ios/CodexiaEditor/Package.resolved',
      'ios/CodexiaEditor/Tests/CodexiaEditorTests/EditorStateTests.swift',
      'ios/CodexiaTransport/Sources/CodexiaAPI/Client.swift',
      'ios/CodexiaTransport/normalize-openapi.py',
      'packages/http-contract/openapi/codexia.openapi.yaml',
      'packages/http-contract/src/main.tsp',
      'packages/http-contract/package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      ...SWIFT_LINUX_RECIPES,
      '.github/workflows/verify.yml',
      'scripts/ci/execution/group.mjs',
      'scripts/ci/evidence/task-inputs.mjs',
    ]) {
      assert.ok((await plan([file], event)).tasks.includes('swift-linux'), event + ': ' + file);
    }
    for (const file of [
      'ios/CodexiaApp/UITests/AuthoringFlowUITests.swift',
      '.github/workflows/ios-api.yml',
      'packages/api/src/server.ts',
      'scripts/ci/dashboard/timing.mjs',
      'docs/README.md',
    ]) {
      assert.ok(!(await plan([file], event)).tasks.includes('swift-linux'), event + ': ' + file);
    }
  }
  assert.ok((await plan(null)).tasks.includes('swift-linux'), 'Unknown diff fails closed');
});

test('native ownership fails closed for unsupported or mixed inputs and main', async () => {
  const source = 'ios/CodexiaEditor/Sources/CodexiaEditor/ManuscriptEditor.swift';
  for (const file of [
    'ios/CodexiaTransport/Sources/CodexiaAPI/new-helper.mjs',
    'ios/Unreviewed/Sources/Unexpected.swift',
    '.github/workflows/ios-other.yml',
    'pnpm-lock.yaml',
    'packages/api/src/server.ts',
  ]) {
    const mixed = await plan([source, file]);
    assert.deepEqual(mixed.tasks, VERIFICATION_TASKS, file);
  }
  const contract = 'packages/http-contract/openapi/codexia.openapi.yaml';
  const mixedContract = await plan([source, contract]);
  const contractOnly = await plan([contract]);
  for (const task of contractOnly.tasks) assert.ok(mixedContract.tasks.includes(task), task);
  assert.ok(mixedContract.tasks.includes('unit-root'));
  assert.deepEqual((await plan([source], 'push')).tasks, VERIFICATION_TASKS);
  assert.deepEqual((await plan(null)).tasks, VERIFICATION_TASKS);
});


test('Impeccable retains its existing workflow triggers and guards only unneeded heavy steps', () => {
  const workflow = parse(readFileSync(new URL('../../../.github/workflows/impeccable.yml', import.meta.url), 'utf8'));
  const paths = workflow.on.pull_request.paths;
  for (const file of [
    'app/src/workspace/persistence.test.ts',
    'modules/publishing/src/publishing.test.ts',
    'app/src/editor/ManuscriptEditor.tsx',
    '.github/workflows/impeccable.yml',
  ]) assert.equal(matchesWorkflowPaths(paths, [file]), true, file);
  const steps = workflow.jobs.scan.steps;
  const scopeIndex = steps.findIndex(step => step.name === 'Select exact-source design scope');
  assert.ok(scopeIndex > 0);
  assert.match(steps[scopeIndex].run, /design-admission\.mjs/u);
  for (const name of ['Scan application and module source', 'Upload design findings']) {
    assert.equal(steps.find(step => step.name === name).if, "steps.scope.outputs.design == 'true'");
  }
  assert.deepEqual(workflow.on.push.paths, paths);
});

test('native-owned input admission requires the Xcode workflow while its Swift source tree exists', () => {
  const owners = [
    { dir: 'ios/CodexiaTransport/', workflow: 'ios-api.yml', paths: ['ios/CodexiaTransport/**'], job: 'api' },
    { dir: 'ios/CodexiaEditor/', workflow: 'ios-editor.yml',
      paths: ['ios/CodexiaEditor/**', 'ios/CodexiaApp/**'], job: 'editor' },
  ];
  for (const owner of owners) {
    const directory = new URL('../../../' + owner.dir, import.meta.url);
    if (!existsSync(directory)) continue; // Native implementation may be in a separate unmerged workstream.
    const workflowFile = new URL('../../../.github/workflows/' + owner.workflow, import.meta.url);
    assert.ok(existsSync(workflowFile), owner.dir + ' requires its native workflow');
    const workflow = parse(readFileSync(workflowFile, 'utf8'));
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'], owner.workflow);
    assert.equal(workflow.jobs[owner.job]['runs-on'], 'xcode-27', owner.workflow);
    assert.ok(workflow.jobs[owner.job].steps.some(step => String(step.run ?? '').includes('swift test') ||
      String(step.run ?? '').includes('xcodebuild')), owner.workflow + ' must execute a native build/test');
  }
});

test('official product-site inputs stay in independent static delivery and retain Verify coverage', async () => {
  const workflow = parse(readFileSync(new URL('../../../.github/workflows/product-site.yml', import.meta.url), 'utf8'));
  const files = ['edge/product-site/src/index.html', 'edge/product-site/src/site.css', 'edge/product-site/src/site.js', 'edge/product-site/build.mjs', 'edge/product-site/wrangler.jsonc', '.github/workflows/product-site.yml'];
  for (const file of files) {
    const selected = await plan([file]);
    assert.equal(selected.mode, 'affected', file);
    assert.deepEqual(selected.tasks, ['coverage'], file);
    assert.equal(selected.full_model_oci, false, file);
    assert.equal(matchesWorkflowPaths(workflow.on.pull_request.paths, [file]), true, file);
    assert.equal(matchesWorkflowPaths(workflow.on.push.paths, [file]), true, file);
  }
  assert.equal(matchesWorkflowPaths(workflow.on.pull_request.paths, ['app/src/editor.ts']), false);
  assert.ok(workflow.jobs.publish.if.includes("github.repository == 'yohn-jp/codexia'"));
  assert.ok(workflow.jobs.publish.if.includes("github.ref == 'refs/heads/main'"));
  assert.ok(workflow.jobs.publish.if.includes("github.event_name != 'pull_request'"));
});
