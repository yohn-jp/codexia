import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLAYWRIGHT_IMAGE_DIGESTS } from '../browser/image-digests.mjs';
import { captureTaskInputSource, taskInvocation, taskWorkflowJob, UX_PROJECTION_DOCUMENTS, isRequirementsTraceInput, isNonExecutableDocumentation, isTaskInputDocument } from './task-inputs.mjs';
import { createVerificationPlan } from '../impact/plan.mjs';

function captureTaskInputClosure({ root, sha, task, runtime }) {
  return captureTaskInputSource({ root, sha, runtime })(task);
}

async function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codexia-task-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'ci@example.test');
  await git(root, 'config', 'user.name', 'CI');
  await mkdir(path.join(root, 'scripts/ci/execution'), { recursive: true });
  await mkdir(path.join(root, 'scripts/ci/impact'), { recursive: true });
  await mkdir(path.join(root, 'scripts/ci/browser'), { recursive: true });
  await mkdir(path.join(root, 'scripts/architecture'), { recursive: true });
  await mkdir(path.join(root, '.github/workflows'), { recursive: true });
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/ci/execution/group.mjs',
    'scripts/ci/impact/contract.mjs', 'scripts/ci/execution/workspace.mjs', '.github/workflows/verify.yml',
    'scripts/ci/evidence/package.json',
    'scripts/architecture/package.json', 'scripts/architecture/package-lock.json', 'scripts/architecture/verify.mjs',
    'packages/core/package.json', 'packages/core/src/index.ts', 'packages/core/index.test.mjs',
    'app/package.json', 'app/src/api.ts', 'docs/README.md']) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    const content = file === 'package.json' ? JSON.stringify({ packageManager: 'pnpm@12.21.0' })
      : file.endsWith('/package.json') ? JSON.stringify({ name: '@codexia/core', dependencies: {} }) : file + '\n';
    await writeFile(target, content);
  }
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'fixture');
  return root;
}

const runtime = { platform: 'linux', arch: 'x64', nodeVersion: 'v24.22.3', execPath: '/opt/node/bin/node',
  cwd: '/home/runner/work/codexia/codexia', imageOS: 'ubuntu24', imageVersion: '20261122.1' };

test('task input closure is stable for an unchanged tree and ignores only impact-excluded documentation', async t => {
  const root = await fixture(t);
  const input = { root, sha: await git(root, 'rev-parse', 'HEAD'), task: 'unit-core', runtime };
  const first = captureTaskInputClosure(input);
  assert.deepEqual(captureTaskInputClosure(input), first);
  await writeFile(path.join(root, 'docs/README.md'), 'documentation changed\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'docs only');
  const docsOnly = captureTaskInputClosure({ ...input, sha: await git(root, 'rev-parse', 'HEAD') });
  assert.deepEqual(docsOnly, first, 'documentation excluded by the canonical impact rules does not change task inputs');
});

test('unit-api proof binds the imported public app adapter and its runtime dependency manifest', async t => {
  const root = await fixture(t);
  const sha = await git(root, 'rev-parse', 'HEAD');
  const input = { root, sha, task: 'unit-api', runtime };
  const original = captureTaskInputClosure(input);

  await writeFile(path.join(root, 'app/src/api.ts'), 'export const api = {} as const;\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'change public app adapter');
  const sourceChanged = captureTaskInputClosure({ ...input, sha: await git(root, 'rev-parse', 'HEAD') });
  assert.notEqual(sourceChanged.source, original.source, 'app adapter source must invalidate the API task proof');

  await git(root, 'reset', '--hard', sha);
  await writeFile(path.join(root, 'app/package.json'), JSON.stringify({ name: '@codexia/app', dependencies: { 'oauth4webapi': '3.8.9' } }));
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'change app runtime dependencies');
  const dependencyChanged = captureTaskInputClosure({ ...input, sha: await git(root, 'rev-parse', 'HEAD') });
  assert.notEqual(dependencyChanged.dependencies, original.dependencies,
    'app runtime dependencies used by the imported adapter must invalidate the API task proof');
});

test('task input closure binds source, test, dependency, environment, toolchain, recipe, and producer inputs', async t => {
  const root = await fixture(t);
  const sha = await git(root, 'rev-parse', 'HEAD');
  const input = { root, sha, task: 'unit-core', runtime };
  const original = captureTaskInputClosure(input);
  for (const [file, nextSha, dimension] of [
    ['packages/core/src/index.ts', 'source change\n', 'source'],
    ['packages/core/index.test.mjs', 'test change\n', 'tests'],
    ['packages/core/package.json', 'dependency change\n', 'dependencies'],
    ['scripts/ci/evidence/package.json', 'CI evidence dependency change\n', 'dependencies'],
    ['scripts/architecture/package-lock.json', 'isolated architecture dependency change\n', 'dependencies'],
  ]) {
    await writeFile(path.join(root, file), nextSha);
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'change ' + dimension);
    const changed = captureTaskInputClosure({ ...input, sha: await git(root, 'rev-parse', 'HEAD') });
    assert.notEqual(changed[dimension], original[dimension], `${dimension} change must invalidate the proof`);
    await git(root, 'reset', '--hard', sha);
  }
  const changedRuntime = captureTaskInputClosure({ ...input,
    runtime: { ...runtime, imageVersion: '20261123.1' } });
  assert.notEqual(changedRuntime.environment, original.environment);
  assert.notEqual(changedRuntime.toolchain, original.toolchain);
  const changedRecipe = captureTaskInputClosure({ ...input, task: 'unit-app' });
  assert.notEqual(changedRecipe.recipe, original.recipe);
  assert.notEqual(changedRecipe.producers, original.producers);
});

test('a historical task closure uses the package manager from its requested Git tree', async t => {
  const root = await fixture(t);
  const input = { root, sha: await git(root, 'rev-parse', 'HEAD'), task: 'unit-core', runtime };
  const historical = captureTaskInputClosure(input);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@12.22.0' }));
  await git(root, 'add', 'package.json');
  await git(root, 'commit', '-qm', 'new toolchain');
  assert.deepEqual(captureTaskInputClosure(input), historical);
  const current = captureTaskInputClosure({ ...input, sha: await git(root, 'rev-parse', 'HEAD') });
  assert.notEqual(current.toolchain, historical.toolchain);
});

test('a deployment document checked by root tests is included in the task source closure', async t => {
  const root = await fixture(t);
  const input = { root, sha: await git(root, 'rev-parse', 'HEAD'), task: 'unit-root', runtime };
  const original = captureTaskInputClosure(input);
  await mkdir(path.join(root, 'docs/deployment'), { recursive: true });
  let previous = original;
  for (const file of ['docs/deployment/IOS-CLIENT.sdoc', 'docs/deployment/ANSIBLE-PUSH-DEPLOYMENT.sdoc']) {
    const target = path.join(root, file);
    await writeFile(target, 'asserted deployment contract\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'add executable documentation input');
    const added = captureTaskInputClosure({ ...input, sha: await git(root, 'rev-parse', 'HEAD') });
    assert.notEqual(added.source, previous.source, file);
    await writeFile(target, 'changed deployment contract\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'edit executable documentation input');
    const changed = captureTaskInputClosure({ ...input, sha: await git(root, 'rev-parse', 'HEAD') });
    assert.notEqual(changed.source, added.source, file);
    previous = changed;
  }
});

test('design authority changes invalidate the trace proof source without changing unrelated task input', async t => {
  const root = await fixture(t);
  const before = { root, sha: await git(root, 'rev-parse', 'HEAD'), runtime };
  await mkdir(path.join(root, 'docs/design'), { recursive: true });
  await writeFile(path.join(root, 'docs/design/INTERACTION-CONTRACT.sdoc'), '# Interaction authority\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'change UI trace authority');
  const after = { ...before, sha: await git(root, 'rev-parse', 'HEAD') };
  for (const task of ['requirements-trace', 'unit-core']) {
    const first = captureTaskInputClosure({ ...before, task });
    const second = captureTaskInputClosure({ ...after, task });
    assert.equal(first.source === second.source, task === 'unit-core', task);
  }
});

test('task proof identities distinguish shared Git inputs from actual invocation inputs', async t => {
  const root = await fixture(t);
  const sha = await git(root, 'rev-parse', 'HEAD');
  const capture = captureTaskInputSource({ root, sha, runtime });
  const core = capture('unit-core');
  const app = capture('unit-app');
  const browser = capture('browser-full-ui-v1');

  // All tasks bind the same immutable source tree; task-specific execution must
  // still have a different recipe, environment or producer identity.
  for (const field of ['source', 'tests', 'dependencies', 'toolchain']) {
    assert.equal(core[field], app[field], field);
    assert.equal(browser[field], app[field], field);
    assert.match(core[field], /^[0-9a-f]{64}$/u, field);
  }
  assert.notEqual(core.recipe, app.recipe);
  assert.notEqual(browser.recipe, app.recipe);
  assert.notEqual(browser.environment, app.environment);
  assert.notEqual(browser.producers, app.producers);

  const canonical = taskInvocation('unit-app', runtime.execPath);
  assert.equal(Array.isArray(canonical), false);
  const misconfigured = capture('unit-app', {
    ...canonical,
    arguments: [...canonical.arguments, '--skip-tests'],
    environmentKeys: [...canonical.environmentKeys, 'ADDED_RUNTIME_INPUT'],
  });
  assert.notEqual(misconfigured.recipe, app.recipe, 'Changed execution must not reuse a certified recipe');
  for (const field of ['source', 'tests', 'dependencies', 'environment', 'toolchain', 'producers']) {
    assert.equal(misconfigured[field], app[field], field);
  }
  assert.throws(() => capture('unit-does-not-exist'), /exactly one verification group/u);
});

test('uncommitted worktree changes cannot influence proof for a pinned Git SHA', async t => {
  const root = await fixture(t);
  const sha = await git(root, 'rev-parse', 'HEAD');
  const original = captureTaskInputClosure({ root, sha, task: 'unit-core', runtime });
  await writeFile(path.join(root, 'packages/core/src/index.ts'), 'local uncommitted source mutation\\n');
  assert.deepEqual(captureTaskInputClosure({ root, sha, task: 'unit-core', runtime }), original);
  await git(root, 'add', 'packages/core/src/index.ts');
  await git(root, 'commit', '-qm', 'commit changed source');
  const committed = captureTaskInputClosure({ root, sha: await git(root, 'rev-parse', 'HEAD'), task: 'unit-core', runtime });
  assert.notEqual(committed.source, original.source, 'Commit content must change source proof');
  for (const field of ['tests', 'dependencies', 'environment', 'toolchain', 'recipe', 'producers']) {
    assert.equal(committed[field], original[field], field);
  }
});

test('browser input proofs bind the Chromium image for every lane', async t => {
  const root = await fixture(t);
  const sha = await git(root, 'rev-parse', 'HEAD');
  const mutatedRoot = await mkdtemp(path.join(os.tmpdir(), 'codexia-browser-image-proof-'));
  const mutatedScripts = path.join(mutatedRoot, 'scripts/ci/evidence');
  await mkdir(mutatedScripts, { recursive: true });
  await mkdir(path.join(mutatedRoot, 'scripts/ci/impact'), { recursive: true });
  await mkdir(path.join(mutatedRoot, 'scripts/ci/browser'), { recursive: true });
  t.after(() => rm(mutatedRoot, { recursive: true, force: true }));
  await cp(new URL('task-inputs.mjs', import.meta.url), path.join(mutatedScripts, 'task-inputs.mjs'));
  await cp(new URL('../impact/contract.mjs', import.meta.url), path.join(mutatedRoot, 'scripts/ci/impact/contract.mjs'));
  await cp(new URL('../browser/image-digests.mjs', import.meta.url), path.join(mutatedRoot, 'scripts/ci/browser/image-digests.mjs'));
  const toolchainDirectory = path.join(mutatedRoot, 'packages/persistence-postgres/tests/db-contract');
  await mkdir(toolchainDirectory, { recursive: true });
  await cp(new URL('../../../packages/persistence-postgres/tests/db-contract/toolchain.json', import.meta.url),
    path.join(toolchainDirectory, 'toolchain.json'));
  const digestsFile = path.join(mutatedRoot, 'scripts/ci/browser/image-digests.mjs');
  const digests = await readFile(digestsFile, 'utf8');
  await writeFile(digestsFile, digests.replace(PLAYWRIGHT_IMAGE_DIGESTS.chromium, `sha256:${'f'.repeat(64)}`));
  await mkdir(path.join(mutatedRoot, 'scripts/architecture'), { recursive: true });
  await cp(new URL('../../architecture/constants.mjs', import.meta.url), path.join(mutatedRoot, 'scripts/architecture/constants.mjs'));
  await mkdir(path.join(mutatedRoot, 'scripts/strictdoc'), { recursive: true });
  await cp(new URL('../../strictdoc/test-source-path.mjs', import.meta.url), path.join(mutatedRoot, 'scripts/strictdoc/test-source-path.mjs'));
  const { captureTaskInputSource: captureWithChangedChromiumImage } = await import(
    pathToFileURL(path.join(mutatedScripts, 'task-inputs.mjs')).href
  );
  const inputs = { root, sha, runtime };
  const original = captureTaskInputSource(inputs);
  const changed = captureWithChangedChromiumImage(inputs);
  for (const profile of ['core', 'full']) {
    for (const shard of ['ui-v1', 'core', 'oauth-web', 'auth-recovery', 'passkey-bootstrap']) {
      const task = `browser-${profile}-${shard}`;
      assert.notEqual(changed(task).environment, original(task).environment, `${task} runs in the changed Chromium image`);
    }
  }
});

test('Passkey browser shard binds the dedicated acceptance environment', () => {
  assert.deepEqual(taskInvocation('browser-core-passkey-bootstrap', '/opt/node/bin/node'), {
    executable: '/opt/node/bin/node',
    arguments: ['scripts/ci/browser/run-shard.mjs', '--profile', 'core', '--suite', 'passkey-bootstrap', '--prebuilt'],
    environmentKeys: ['CODEXIA_CI_REPORT_DIR', 'CODEXIA_E2E_ADMIN_DATABASE_URL', 'CODEXIA_E2E_DATABASE_URL',
      'CODEXIA_E2E_OUTPUT_DIR', 'CODEXIA_E2E_PORT', 'CODEXIA_E2E_PROJECT_TITLE', 'CODEXIA_E2E_STATE_DIR',
      'CODEXIA_PASSKEY_ACCEPTANCE'],
  });
});

test('database contract proof records its isolated PG17/pgTAP/tbls/age verification command', async t => {
  const root = await fixture(t);
  const sha = await git(root, 'rev-parse', 'HEAD');
  assert.deepEqual(taskInvocation('db-contract', runtime.execPath), {
    executable: 'pnpm',
    arguments: ['--filter', '@codexia/persistence-postgres', 'run', 'test:db-contract'],
    environmentKeys: ['CODEXIA_CI_REPORT_DIR'],
  });
  const closure = captureTaskInputClosure({ root, sha, task: 'db-contract', runtime });
  for (const field of ['source', 'tests', 'dependencies', 'environment', 'toolchain', 'recipe', 'producers']) {
    assert.match(closure[field], /^[0-9a-f]{64}$/u, field);
  }
  assert.notEqual(closure.producers, captureTaskInputClosure({ root, sha, task: 'unit-core', runtime }).producers);
});

test('architecture G5 proof binds its isolated tool lock, immutable image, invocation, and nested report location', async t => {
  const root = await fixture(t);
  const sha = await git(root, 'rev-parse', 'HEAD');
  const capture = captureTaskInputSource({ root, sha, runtime });
  const closure = capture('architecture-g5');
  assert.equal(taskWorkflowJob('architecture-g5'), 'unit');
  assert.deepEqual(taskInvocation('architecture-g5', runtime.execPath), [
    { executable: 'npm', arguments: ['ci', '--prefix', 'scripts/architecture', '--ignore-scripts', '--no-audit', '--no-fund'], environmentKeys: [] },
    { executable: 'docker', arguments: ['pull', 'docker.io/threagile/threagile@sha256:abb9eccb111a2059c4876759a24245db02ad295b1608d3a4634ec250f38d9640'], environmentKeys: [] },
    { executable: runtime.execPath, arguments: ['scripts/architecture/verify.mjs'], environmentKeys: ['CODEXIA_ARCHITECTURE_EVIDENCE_DIR'] },
  ]);
  assert.notEqual(closure.recipe, capture('unit-core').recipe);
  assert.notEqual(closure.producers, capture('unit-core').producers);
  const expectedEnvironment = {
    CI: 'true', NODE_ENV: 'workflow-default', TZ: 'workflow-default', LANG: 'runner-default', LC_ALL: 'runner-default',
    CODEXIA_TEST_DATABASE_URL: 'postgres://codexia:codexia@127.0.0.1:5432/codexia_test',
    CODEXIA_AUTH_TEST_DATABASE_URL: 'postgres://codexia:codexia@127.0.0.1:5432/codexia_auth_test',
    CODEXIA_AUTH_TEST_DISPOSABLE: '1',
    CODEXIA_ARCHITECTURE_EVIDENCE_DIR: '<CODEXIA_CI_REPORT_DIR>/architecture',
  };
  const expectedEnvironmentIdentity = {
    runtime: { platform: runtime.platform, arch: runtime.arch, imageOS: runtime.imageOS, imageVersion: runtime.imageVersion },
    env: expectedEnvironment,
  };
  assert.equal(closure.environment, createHash('sha256').update(JSON.stringify(expectedEnvironmentIdentity)).digest('hex'));

  await writeFile(path.join(root, 'scripts/architecture/package-lock.json'), 'updated lock identity\n');
  await git(root, 'add', 'scripts/architecture/package-lock.json');
  await git(root, 'commit', '-qm', 'change architecture tool lock');
  const changed = captureTaskInputSource({ root, sha: await git(root, 'rev-parse', 'HEAD'), runtime })('architecture-g5');
  assert.notEqual(changed.dependencies, closure.dependencies);
});

test('affected requirements trace receives the exact source and isolated task environment', async t => {
  const root = await fixture(t);
  const sourceRoot = path.resolve(import.meta.dirname, '../../..');
  const archive = execFileSync('git', ['archive', 'HEAD'], { cwd: sourceRoot, maxBuffer: 100 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', root], { input: archive });
  await rm(path.join(root, 'packages/core/index.test.mjs'));
  await symlink(path.join(sourceRoot, 'node_modules'), path.join(root, 'node_modules'));
  await symlink(path.join(sourceRoot, 'packages/core/node_modules'), path.join(root, 'packages/core/node_modules'));
  await symlink(path.join(sourceRoot, 'scripts/ci/evidence/node_modules'), path.join(root, 'scripts/ci/evidence/node_modules'));
  const trace = path.join(root, 'scripts/strictdoc/verify.mjs');
  await writeFile(trace, `import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const { CODEXIA_CI_REPORT_DIR: report, CODEXIA_CI_SOURCE_SHA: source,
  CODEXIA_CI_TASK: task, STRICTDOC_BIN: tool } = process.env;
await mkdir(report, { recursive: true });
await writeFile(path.join(report, 'observed.json'), JSON.stringify({ report, source, task, tool, cwd: process.cwd(), node: process.execPath }));
`);
  await git(root, 'add', '-A');
  await git(root, 'commit', '-qm', 'fixture baseline');
  const base = await git(root, 'rev-parse', 'HEAD');
  await writeFile(trace, (await readFile(trace, 'utf8')) + '// affected requirements trace\n');
  await git(root, 'add', 'scripts/strictdoc/verify.mjs');
  await git(root, 'commit', '-qm', 'affected trace');
  const sha = await git(root, 'rev-parse', 'HEAD');
  const plan = createVerificationPlan({ files: ['scripts/strictdoc/verify.mjs'], event: 'pull_request', sha, base });
  assert.deepEqual(plan.groups, ['types-tests', 'types-trace']);
  assert.ok(plan.tasks.includes('coverage') && plan.tasks.includes('requirements-trace'));
  const planPath = path.join(root, 'plan.json');
  const report = path.join(root, 'reports');
  const tool = path.join(root, 'isolated-strictdoc');
  await writeFile(planPath, JSON.stringify(plan));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('GITHUB_') && !key.startsWith('CODEXIA_CI_') && !key.startsWith('NODE_TEST_') && key !== 'STRICTDOC_BIN'));
  Object.assign(env, { CODEXIA_CI_PLAN_PATH: planPath, CODEXIA_CI_REPORT_DIR: report,
    CODEXIA_CI_SOURCE_SHA: 'f'.repeat(40), CODEXIA_CI_TASK: 'wrong-task', STRICTDOC_BIN: tool });
  execFileSync(process.execPath, ['scripts/ci/execution/group.mjs', 'types-trace'],
    { cwd: root, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const observed = JSON.parse(await readFile(path.join(report, 'requirements-trace/observed.json'), 'utf8'));
  assert.deepEqual(observed, { report: path.join(report, 'requirements-trace'), source: sha,
    task: 'requirements-trace', tool, cwd: root, node: process.execPath });
  const result = JSON.parse(await readFile(path.join(report, 'report.json'), 'utf8'));
  const traceResult = result.results.find(item => item.task === 'requirements-trace');
  assert.deepEqual(traceResult.invocations, [taskInvocation('requirements-trace', process.execPath)],
    'Observed execution must match the certified task recipe');
  assert.deepEqual(Object.fromEntries(result.results.map(({ task, status }) => [task, status])),
    { 'requirements-trace': 'passed' });
});

test('projection authority documents are task inputs only for the simulator root proof', () => {
  assert.equal(UX_PROJECTION_DOCUMENTS.length, 16);
  for (const file of UX_PROJECTION_DOCUMENTS) {
    assert.equal(isNonExecutableDocumentation(file), file !== 'app/DESIGN.md', `${file} keeps its existing CI scope`);
    assert.equal(isTaskInputDocument(file, 'unit-root'), true, `${file} binds simulator proof`);
    assert.equal(isTaskInputDocument(file, 'coverage'), file === 'app/DESIGN.md', `${file} keeps its existing product proof scope`);
  }
  assert.equal(isTaskInputDocument('docs/design/DEVELOPMENT-PAGES-UX.sdoc', 'unit-root'), false);
});

test('specification authority and native iOS and IaC sources select the existing trace proof', () => {
  for (const file of [
    'docs/architecture/DOCUMENTATION-AUTHORITY.sdoc',
    'docs/architecture/SPECIFICATION-IMPLEMENTATION-CONTRACT.sdoc',
    'docs/architecture/SPECIFICATION-TOOLCHAIN.sdoc',
    'docs/requirements/STRICTDOC-TRACEABILITY.sdoc',
    'docs/requirements/REQUIREMENT-REGISTER.sdoc',
    'docs/verification/TRACEABILITY-REGISTER.sdoc',
    'docs/verification/SPECIFICATION-TOOLING-ACCEPTANCE.sdoc',
  ]) {
    assert.ok(isRequirementsTraceInput(file), file);
    assert.equal(isTaskInputDocument(file, 'requirements-trace'), true, file);
    assert.equal(isRequirementsTraceInput(file), true, file);
  }
  for (const file of [
    'ios/CodexiaApp/Sources/CodexiaApp.swift',
    'ios/CodexiaTransport/Sources/CodexiaTransport/APITransport.swift',
    'deploy/cloudflare/terraform/main.tf',
    'deploy/ansible/site.yml',
    'packages/http-contract/src/routes-core.tsp',
    'packages/http-contract/src/fastify-schema.mjs',
    'packages/http-contract/scripts/generate-openapi.mjs',
    'packages/http-contract/scripts/generated-file.mjs',
    'packages/http-contract/tspconfig.yaml',
    'pnpm-lock.yaml',
    'packages/api/src/http-contributions.ts',
    'packages/api/package.json',
    'modules/mcp/package.json',
    'modules/publishing/package.json',
  ]) assert.equal(isRequirementsTraceInput(file), true, file);
});
