import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFORMANCE_TASKS, VERIFICATION_GROUPS, WORKSPACES, requiredBuildProfile, isFastifyGenerationInput, isOpenApiGenerationInput } from '../impact/contract.mjs';
import { createWorkspaceGraph } from '../impact/workspace-graph.mjs';
import { browserRuntimeRequirements } from '../browser/image-digests.mjs';
import { THREAGILE_IMAGE } from '../../architecture/constants.mjs';
import { isTraceTestSource } from '../../strictdoc/test-source-path.mjs';

const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const testFilePattern = /\.(?:test|spec)\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx)$/u;
const dependencyPath = file => /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.node-version|\.nvmrc)$/u.test(file) ||
  file === 'tests/conformance/http/requirements.lock.txt' || file === 'scripts/strictdoc/requirements.lock.txt';
export const ROOT_VERIFICATION_DOCUMENTS = Object.freeze([
  'docs/deployment/ANSIBLE-PUSH-DEPLOYMENT.sdoc',
  'docs/deployment/BACKUP.sdoc',
  'docs/deployment/IAC.sdoc',
  'docs/deployment/IOS-CLIENT.sdoc',
  'docs/deployment/PUSH-DEPLOYMENT.sdoc',
  'docs/deployment/PUSH-HOST-CI.sdoc',
  'docs/deployment/DEPLOYMENT-REFERENCE.sdoc',
]);
export const CODEXIACTL_SPECIFICATIONS = Object.freeze([
  'docs/deployment/CODEXIACTL.sdoc',
  'docs/deployment/ANSIBLE-AUTH-RUNTIME.sdoc',
  'docs/deployment/ANSIBLE-BASE-RUNTIME.sdoc',
  'docs/deployment/ANSIBLE-BASE-SECRETS.sdoc',
  'docs/deployment/ANSIBLE-PUSH-DEPLOYMENT.sdoc',
  'docs/deployment/BACKUP-CONSOLE-OPERATIONS.sdoc',
  'docs/deployment/ACCESS-POLICY-MIGRATION.sdoc',
]);
const codexiactlSpecifications = new Set(CODEXIACTL_SPECIFICATIONS);
export function isNativeSpecification(file) {
  return /^docs\/.*\.(?:sdoc|sgra)$/u.test(file) || /^docs\/.*\/_assets\//u.test(file);
}
export function isDesignProjectionModel(file) {
  return /^docs\/(?:architecture\/diagrams\/[^/]+\.(?:mmd|json)|design\/screen-(?:catalog|journeys)\.json)$/u.test(file);
}
export const UX_PROJECTION_DOCUMENTS = Object.freeze([
  'docs/design/UX-SIMULATOR-CONTRACT.sdoc',
  'docs/design/SCREEN-CONTROL-CATALOG.sdoc',
  'docs/design/SCREEN-STATE-ATLAS.sdoc',
  'docs/design/USER-SCREEN-FLOW.sdoc',
  'docs/design/ADMIN-SCREEN-FLOW.sdoc',
  'docs/design/UX-CONTRACT.sdoc',
  'docs/design/INTERACTION-CONTRACT.sdoc',
  'docs/design/XSTATE-STATE-MACHINE-CONTRACT.sdoc',
  'docs/design/MOBILE-AUTHORING.sdoc',
  'app/DESIGN.md',
  'docs/architecture/IOS-SWIFTUI-ARCHITECTURE.sdoc',
  'docs/architecture/ROUTE-AUTHORIZATION-CONTRACT.sdoc',
  'docs/architecture/API-CONTRACT.sdoc',
  'docs/architecture/BACKUP-CONSOLE-CONTRACT.sdoc',
  'docs/requirements/REQUIREMENT-REGISTER.sdoc',
  'docs/requirements/STRICTDOC-TRACEABILITY.sdoc',
]);
const rootVerificationDocuments = new Set(ROOT_VERIFICATION_DOCUMENTS);
const uxProjectionDocuments = new Set(UX_PROJECTION_DOCUMENTS);
export const REQUIREMENTS_TRACE_SURFACE_FILES = Object.freeze([
  '.github/workflows/backend-deployment-handoff.yml',
  '.github/workflows/backend-release.yml',
  '.github/workflows/push-backup.yml',
  'deploy/ansible/deploy-transaction.yml',
  'deploy/ansible/deploy.yml',
  'deploy/ansible/restore-drill.yml',
  'deploy/backup/backup.sh',
  'deploy/backup/s3_transfer.py',
  'packages/http-contract/openapi/codexia.openapi.yaml',
  'packages/http-contract/scripts/generate-fastify.mjs',
  'packages/api/src/generated/http-contract.json',
  'packages/api/src/http-contributions.ts',
  'packages/api/package.json',
  'modules/mcp/package.json',
  'modules/publishing/package.json',
  'packages/http-contract/test/fixtures/admitted-routes.json',
  'packages/persistence-postgres/tests/db-contract/catalog-contract.json',
]);
const requirementsTraceSurfaces = new Set(REQUIREMENTS_TRACE_SURFACE_FILES);

export function isRequirementsTraceInput(file) {
  return isNativeSpecification(file) || isDesignProjectionModel(file) || uxProjectionDocuments.has(file) || requirementsTraceSurfaces.has(file) || isFastifyGenerationInput(file) ||
    isTraceTestSource(file) ||
    (file.startsWith('ios/') && /\.swift$/u.test(file)) ||
    (file.startsWith('deploy/ansible/') && /\.ya?ml$/u.test(file)) ||
    (file.startsWith('deploy/cloudflare/terraform/') && file.endsWith('.tf')) ||
    (/^app\/src\/.*\.[jt]sx?$/u.test(file) && !/\.test\./u.test(file));
}

export function isNonExecutableDocumentation(file) {
  if (rootVerificationDocuments.has(file)) return false;
  return file === 'AGENTS.md' || file === 'CONTRIBUTING.md' || file === 'LICENSE' ||
    isNativeSpecification(file) || isDesignProjectionModel(file) || /^docs\/.*\.md$/u.test(file) || /^README(?:\.[a-z-]+)?\.md$/iu.test(file);
}
export function isTaskInputDocument(file, task) {
  if (!isNonExecutableDocumentation(file)) return true;
  if (Object.hasOwn(CONFORMANCE_TASKS, task) && (file === 'AGENTS.md' ||
      file === 'docs/verification/SPECIFICATION-TOOLING-ACCEPTANCE.sdoc' ||
      file === (task === 'http-conformance' ? 'docs/architecture/HTTP-PLATFORM-MIGRATION.sdoc' : 'docs/architecture/MCP-V2-MIGRATION.sdoc'))) return true;
  if (task === 'requirements-trace' && isRequirementsTraceInput(file)) return true;
  if (task === 'codexiactl-linux' && codexiactlSpecifications.has(file)) return true;
  if (task === 'architecture-g5' && (file.startsWith('docs/architecture/') || isDesignProjectionModel(file))) return true;
  return task === 'unit-root' && (uxProjectionDocuments.has(file) || isDesignProjectionModel(file));
}
const DB_CONTRACT_TOOLCHAIN = JSON.parse(readFileSync(new URL('../../../packages/persistence-postgres/tests/db-contract/toolchain.json', import.meta.url), 'utf8'));
const POSTGRES_CI_IMAGE = DB_CONTRACT_TOOLCHAIN.postgresImage;
const SWIFT_LINUX_TOOLCHAIN_PATH = 'scripts/ios/swift-linux-toolchain.json';
const CODEXIACTL_GO_MODULE = 'cmd/codexiactl/go.mod';
const swiftTestPath = /^ios\/(?:CodexiaEditor|CodexiaTransport)\/Tests\//u;
const swiftDependencyPath = /^ios\/(?:CodexiaEditor|CodexiaTransport)\/Package\.(?:swift|resolved)$/u;

export function taskGroup(task) {
  const groups = Object.keys(VERIFICATION_GROUPS).filter(group => VERIFICATION_GROUPS[group].includes(task));
  assert.equal(groups.length, 1, `Task must belong to exactly one verification group: ${task}`);
  return groups[0];
}

export function taskWorkflowJob(task) {
  const group = taskGroup(task);
  if (group === 'biome') return 'biome';
  if (group.startsWith('unit-')) return 'unit';
  if (group.startsWith('types-')) return 'types';
  if (group.startsWith('browser-')) return 'browser';
  if (group.startsWith('build-')) return 'build';
  if (group.startsWith('oci-')) return 'oci';
  throw new Error(`No workflow job identity for ${task}`);
}

function taskOverrides(task) {
  if (task.startsWith('build-')) return { CODEXIA_PROFILE: task.slice('build-'.length) };
  if (task === 'audit-core') return {};
  if (task.startsWith('oci-')) return { OCI_ENGINE: 'docker', CODEXIA_PROFILE: task.slice('oci-'.length),
    CODEXIA_OCI_IMAGE: `codexia-verification:${task.slice('oci-'.length)}` };
  if (task.startsWith('browser-')) {
    return { ...(task.endsWith('-passkey-bootstrap') ? { CODEXIA_PASSKEY_ACCEPTANCE: '1' } : {}),
      CODEXIA_E2E_ADMIN_DATABASE_URL: '<disposable-postgres-admin-url>',
      CODEXIA_E2E_DATABASE_URL: '<disposable-postgres-database-url>', CODEXIA_E2E_PORT: '<isolated-port>',
      CODEXIA_E2E_STATE_DIR: '<isolated-state-dir>', CODEXIA_E2E_OUTPUT_DIR: path.resolve('tests/e2e/test-results', task),
      CODEXIA_E2E_PROJECT_TITLE: '<disposable-fixture-title>', CODEXIA_CI_REPORT_DIR: '<task-report-dir>' };
  }
  if (task === 'architecture-g5') return { CODEXIA_ARCHITECTURE_EVIDENCE_DIR: '<CODEXIA_CI_REPORT_DIR>/architecture' };
  return {};
}

export function taskInvocation(task, executable = process.execPath) {
  assert.ok(typeof task === 'string' && task.length > 0, 'Task name is required');
  const overrides = taskOverrides(task);
  const environmentKeys = Object.keys(overrides).sort();
  if (task === 'biome-ci') return { executable, arguments: ['scripts/ci/biome/check.mjs'], environmentKeys: ['CODEXIA_CI_REPORT_DIR'] };
  if (task === 'swift-linux') return { executable: 'bash', arguments: ['scripts/ios/verify-linux-swift.sh'], environmentKeys };
  if (task === 'codexiactl-linux') return { executable: 'bash', arguments: ['scripts/ci/execution/verify-codexiactl.sh'], environmentKeys };
  if (task === 'db-contract') return { executable: 'pnpm', arguments: ['--filter', '@codexia/persistence-postgres', 'run', 'test:db-contract'], environmentKeys: ['CODEXIA_CI_REPORT_DIR'] };
  if (Object.hasOwn(CONFORMANCE_TASKS, task)) return {
    executable, arguments: ['--import', 'tsx', CONFORMANCE_TASKS[task]], environmentKeys: ['CODEXIA_CI_REPORT_DIR'],
  };
  if (task === 'requirements-trace') return {
    executable,
    arguments: ['scripts/strictdoc/verify.mjs'],
    environmentKeys: ['CODEXIA_CI_REPORT_DIR', 'CODEXIA_CI_SOURCE_SHA', 'CODEXIA_CI_TASK', 'CODEXIA_STRICTDOC_PUBLIC', 'STRICTDOC_BIN'],
  };
  if (task.startsWith('unit-')) return { executable, arguments: ['scripts/ci/execution/workspace.mjs', 'unit', task.slice(5)], environmentKeys };
  if (task.startsWith('typecheck-')) return { executable, arguments: ['scripts/ci/execution/workspace.mjs', 'typecheck', task.slice(10)], environmentKeys };
  if (task.startsWith('test-types-')) return { executable, arguments: ['scripts/ci/execution/workspace.mjs', 'test-types', task.slice(11)], environmentKeys };
  if (task === 'safety') return { executable: 'pnpm', arguments: ['typecheck:safety'], environmentKeys };
  if (task === 'coverage') return { executable, arguments: ['scripts/ci/execution/workspace.mjs', 'coverage'], environmentKeys };
  if (task.startsWith('build-')) return { executable: 'pnpm', arguments: ['build'], environmentKeys };
  if (task === 'audit-core') return { executable: 'pnpm', arguments: ['audit:core'], environmentKeys };
  if (task.startsWith('oci-')) return { executable: 'bash', arguments: ['scripts/verification/runtime/oci.sh'], environmentKeys };
  if (task.startsWith('browser-')) {
    const [, profile, ...suite] = task.split('-');
    return { executable, arguments: ['scripts/ci/browser/run-shard.mjs', '--profile', profile, '--suite', suite.join('-'), '--prebuilt'], environmentKeys };
  }
  if (task === 'architecture-g5') return [
    { executable: 'npm', arguments: ['ci', '--prefix', 'scripts/architecture', '--ignore-scripts', '--no-audit', '--no-fund'], environmentKeys: [] },
    { executable: 'docker', arguments: ['pull', THREAGILE_IMAGE], environmentKeys: [] },
    { executable, arguments: ['scripts/architecture/verify.mjs'], environmentKeys },
  ];
  throw new Error(`No canonical invocation for ${task}`);
}

function taskEnvironment(task, group, runtime) {
  const env = { CI: 'true', NODE_ENV: 'workflow-default', TZ: 'workflow-default',
    LANG: 'runner-default', LC_ALL: 'runner-default' };
  if (task === 'requirements-trace') Object.assign(env, {
    CODEXIA_CI_TASK: task,
    CODEXIA_STRICTDOC_PUBLIC: '1',
    STRICTDOC_VERSION: '0.32.1',
    PYTHON_VERSION: '3.12',
    PLAYWRIGHT_BROWSER: 'chromium',
  });
  if (group.startsWith('unit-')) Object.assign(env, {
    CODEXIA_TEST_DATABASE_URL: 'postgres://codexia:codexia@127.0.0.1:5432/codexia_test',
    CODEXIA_AUTH_TEST_DATABASE_URL: 'postgres://codexia:codexia@127.0.0.1:5432/codexia_auth_test',
    CODEXIA_AUTH_TEST_DISPOSABLE: '1',
  });
  if (task === 'biome-ci') env.CODEXIA_CI_REPORT_DIR = '<task-report-dir>';
  if (task === 'db-contract') Object.assign(env, {
    CODEXIA_CI_REPORT_DIR: '<task-report-dir>', CODEXIA_CI_DB_CONTRACT_IMAGE: 'success',
  });
  if (Object.hasOwn(CONFORMANCE_TASKS, task)) {
    env.CODEXIA_CI_REPORT_DIR = '<task-report-dir>';
    if (task === 'http-conformance') {
      env.CODEXIA_CI_HTTP_CONFORMANCE_SETUP = 'success';
      env.CODEXIA_HTTP_CONFORMANCE_DATABASE_URL = '<disposable-loopback-postgres-database-url>';
      env.PYTHON_VERSION = '3.12';
      env.SCHEMATHESIS_BIN = '<locked-python-environment>/bin/schemathesis';
    } else {
      env.CODEXIA_CI_MCP_CONFORMANCE_SETUP = 'success';
      env.CODEXIA_MCP_CONFORMANCE_DATABASE_URL = '<disposable-loopback-postgres-database-url>';
    }
  }
  if (task.startsWith('browser-')) {
    Object.assign(env, { CODEXIA_E2E_DATABASE_URL: 'postgres://codexia:codexia@postgres:5432/codexia_test',
      CODEXIA_PLAYWRIGHT_IMAGE_DIGEST: browserRuntimeRequirements(group).imageDigest });
    if (task.endsWith('-passkey-bootstrap')) env.CODEXIA_PASSKEY_ACCEPTANCE = '1';
  }
  for (const [key, value] of Object.entries(taskOverrides(task))) {
    env[key] = key === 'CODEXIA_E2E_OUTPUT_DIR' ? `tests/e2e/test-results/${task}` : value;
  }
  return { runtime: { platform: runtime.platform, arch: runtime.arch,
    imageOS: runtime.imageOS ?? null, imageVersion: runtime.imageVersion ?? null }, env };
}

function taskProducerRecipe(task, swiftToolchain, goVersion) {
  const group = taskGroup(task);
  const prerequisites = [];
  const profile = requiredBuildProfile(group);
  if (profile) prerequisites.push(`build-${profile}`);
  if (task === 'audit-core') prerequisites.push('build-core');
  if (task.startsWith('unit-') || task.startsWith('typecheck-') || task.startsWith('test-types-') || task === 'safety' ||
      task === 'db-contract' || Object.hasOwn(CONFORMANCE_TASKS, task)) {
    prerequisites.push('workspace-build-prerequisites');
  }
  const external = [];
  if (task.startsWith('unit-') || task.startsWith('browser-') || Object.hasOwn(CONFORMANCE_TASKS, task)) external.push(POSTGRES_CI_IMAGE);
  if (task === 'http-conformance') external.push('python:3.12', 'tests/conformance/http/requirements.lock.txt');
  if (task === 'mcp-conformance') external.push('tests/conformance/mcp/package-lock.json');
  if (task === 'biome-ci') external.push('@biomejs/biome@2.6.8');
  if (task === 'db-contract') {
    const toolchain = DB_CONTRACT_TOOLCHAIN;
    const archive = entry => `${entry.url}#sha256=${entry.sha256}`;
    external.push(toolchain.postgresImage, 'podman:ubuntu-24.04-host',
      `${toolchain.pgtap.archiveUrl}#sha256=${toolchain.pgtap.archiveSha256}`,
      ...Object.values(toolchain.tbls.archives).map(archive),
      ...Object.values(toolchain.restoreDrill.age.archives).map(archive));
  }
  if (task.startsWith('oci-')) external.push('docker:ubuntu-24.04-host');
  if (task === 'architecture-g5') external.push(THREAGILE_IMAGE);
  if (swiftToolchain) external.push(`${swiftToolchain.url}#sha256=${swiftToolchain.sha256}`);
  if (goVersion) external.push(`go:${goVersion}`);
  return { group, task, prerequisites: [...new Set(prerequisites)].sort(), external,
    runnerClass: group.startsWith('browser-') ? 'pinned-playwright-container' : 'ubuntu-24.04' };
}

function readGit(root, ...args) {
  return execFileSync('git', ['-c', `safe.directory=${root}`, ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

function treeEntries(root, sha) {
  const raw = readGit(root, 'ls-tree', '-r', '-z', '--full-tree', sha);
  return raw.split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t');
    assert.ok(tab > 0, 'Malformed Git tree record');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    assert.equal(type, 'blob', `Unsupported task input object type for ${file}`);
    return { mode, oid, file };
  });
}

/** Capture the immutable inputs shared by all task proofs for one source and runner. */
export function captureTaskInputSource({ root, sha, runtime }) {
  assert.match(sha ?? '', /^[a-f0-9]{40}$/u, 'Invalid task proof source SHA');
  assert.ok(runtime && typeof runtime === 'object', 'Task proof runtime is required');
  const tree = treeEntries(root, sha);
  const manifest = tree.find(({ file }) => file === 'package.json');
  assert.ok(manifest?.mode === '100644' || manifest?.mode === '100755', 'Task proof requires a regular root package.json');
  const { packageManager } = JSON.parse(readGit(root, 'cat-file', 'blob', manifest.oid));
  const entries = rows => rows.map(({ mode, file, oid }) => [mode, file, oid]);
  // Resolve manifests from the requested immutable tree, not the worktree.
  // Unknown graphs retain the conservative whole-source closure.
  let graph;
  try {
    const manifestByPath = new Map(tree.map(entry => [entry.file, entry]));
    graph = createWorkspaceGraph(new Map(WORKSPACES.map(workspace => {
      const entry = manifestByPath.get(workspace.path + '/package.json');
      assert.ok(entry?.mode === '100644' || entry?.mode === '100755');
      return [workspace.id, JSON.parse(readGit(root, 'cat-file', 'blob', entry.oid))];
    })));
  } catch { graph = undefined; }
  const toolchain = sha256({ nodeVersion: runtime.nodeVersion, platform: runtime.platform, arch: runtime.arch,
    imageOS: runtime.imageOS ?? null, imageVersion: runtime.imageVersion ?? null, packageManager: packageManager ?? null });

  return (task, invocations = taskInvocation(task, runtime.execPath)) => {
    const group = taskGroup(task);
    const executable = tree.filter(({ file }) => isTaskInputDocument(file, task));
    // Record the resolved workspace input closure using the exact same graph
    // as execution and impact. Keep the conservative source fingerprint for
    // now: scripts and raw cross-package imports may have undeclared inputs.
    let workspaceInputs = null;
    try {
      const ids = graph?.typecheckClosure(task);
      if (ids) {
        const owners = new Set(ids);
        workspaceInputs = { ids, inputs: entries(executable.filter(({ file }) => owners.has(graph.owner(file)))) };
      }
    } catch { workspaceInputs = null; }
    const source = sha256(entries(executable));
    const swift = task === 'swift-linux';
    const swiftToolchain = swift ? JSON.parse(readGit(root, 'show', sha + ':' + SWIFT_LINUX_TOOLCHAIN_PATH)) : null;
    const go = task === 'codexiactl-linux';
    const goVersion = go ? /^go (\d+\.\d+\.\d+)$/mu.exec(readGit(root, 'show', sha + ':' + CODEXIACTL_GO_MODULE))?.[1] : null;
    if (go) assert.ok(goVersion, 'codexiactl requires a pinned Go toolchain');
    const tests = sha256(entries(executable.filter(({ file }) => {
      if (go) return /^cmd\/codexiactl\/.*_test\.go$/u.test(file);
      return swift ? swiftTestPath.test(file) : testFilePattern.test(file);
    })));
    const dependencies = sha256(entries(executable.filter(({ file }) => {
      if (go) return /^cmd\/codexiactl\/go\.(?:mod|sum)$/u.test(file);
      return swift ? swiftDependencyPath.test(file) || (isOpenApiGenerationInput(file) && dependencyPath(file)) : dependencyPath(file);
    })));
    const normalizedInvocations = Array.isArray(invocations) ? invocations : [invocations];
    const canonicalInvocations = normalizedInvocations.map(invocation => ({ ...invocation,
      executable: invocation.executable === runtime.execPath ? 'node' : invocation.executable }));
    return {
      source, tests, dependencies, environment: sha256(taskEnvironment(task, group, runtime)),
      toolchain: swiftToolchain ? sha256({ toolchain, swift: swiftToolchain }) : goVersion ? sha256({ toolchain, go: goVersion }) : toolchain,
      recipe: sha256({ task, group, workflowJob: taskWorkflowJob(task), invocation: canonicalInvocations,
        groupPreparation: 'scripts/ci/execution/workspace.mjs prepare selected-group', concurrencyLimit: 2 }),
      producers: sha256({ ...taskProducerRecipe(task, swiftToolchain, goVersion), ...(workspaceInputs ? { workspaceInputs } : {}) }),
    };
  };
}

export function taskInputProof({ task, closure, sourceSha, planDigest, workflowRunId, workflowAttempt, workflowJob, runtime, reusedFrom }) {
  const proof = { format: 'codexia-ci-task-input-proof/v2', task, mode: 'task-execution', status: 'passed',
    sourceSha, planDigest, workflowRunId, workflowAttempt, workflowJob, runtime, inputClosure: closure };
  return reusedFrom ? { ...proof, reusedFrom } : proof;
}
