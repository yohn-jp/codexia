import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { BROWSER_SHARDS, VERIFICATION_GROUPS, requiredBuildProfile } from './ci-contract.mjs';
import { PLAYWRIGHT_IMAGE_DIGESTS } from './ci-browser-image-digests.mjs';

const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const testFilePattern = /\.(?:test|spec)\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx)$/u;
const dependencyPath = file => /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.node-version|\.nvmrc)$/u.test(file);
export const ROOT_VERIFICATION_DOCUMENTS = Object.freeze([
  'docs/deployment/BACKUP.md',
  'docs/deployment/IAC.md',
  'docs/deployment/IOS-CLIENT.md',
  'docs/deployment/PUSH-DEPLOYMENT.md',
  'docs/deployment/PUSH-HOST-CI.md',
  'docs/deployment/README.md',
]);
const rootVerificationDocuments = new Set(ROOT_VERIFICATION_DOCUMENTS);

export function isNonExecutableDocumentation(file) {
  if (rootVerificationDocuments.has(file)) return false;
  return file === 'AGENTS.md' || file === 'CONTRIBUTING.md' || file === 'LICENSE' ||
    /^docs\/.*\.md$/u.test(file) || /^README(?:\.[a-z-]+)?\.md$/iu.test(file);
}
const POSTGRES_CI_IMAGE = 'docker.io/library/postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536';

export function taskGroup(task) {
  const groups = Object.keys(VERIFICATION_GROUPS).filter(group => VERIFICATION_GROUPS[group].includes(task));
  assert.equal(groups.length, 1, `Task must belong to exactly one verification group: ${task}`);
  return groups[0];
}

export function taskWorkflowJob(task) {
  const group = taskGroup(task);
  if (group.startsWith('unit-')) return 'unit';
  if (group.startsWith('types-')) return 'types';
  if (group.startsWith('browser-')) return 'browser';
  if (group === 'hosted-native-catalog') return 'hosted_catalog';
  if (group.startsWith('hosted-native-')) return 'hosted';
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
    return { CODEXIA_E2E_ADMIN_DATABASE_URL: '<disposable-postgres-admin-url>',
      CODEXIA_E2E_DATABASE_URL: '<disposable-postgres-database-url>', CODEXIA_E2E_PORT: '<isolated-port>',
      CODEXIA_E2E_STATE_DIR: '<isolated-state-dir>', CODEXIA_E2E_OUTPUT_DIR: path.resolve('tests/e2e/test-results', task),
      CODEXIA_E2E_PROJECT_TITLE: '<disposable-fixture-title>', CODEXIA_CI_REPORT_DIR: '<task-report-dir>' };
  }
  if (task.startsWith('hosted-native-')) {
    const selection = task.slice('hosted-native-'.length);
    if (selection === 'catalog') return { CODEXIA_NATIVE_REPORT_PATH: '<native-report-path>' };
    return { CODEXIA_NATIVE_REPORT_PATH: '<native-report-path>', CODEXIA_NATIVE_PRODUCER_REPORT: '<native-producer-report-path>' };
  }
  return {};
}

export function taskInvocation(task, executable = process.execPath) {
  assert.ok(typeof task === 'string' && task.length > 0, 'Task name is required');
  const overrides = taskOverrides(task);
  const environmentKeys = Object.keys(overrides).sort();
  if (task.startsWith('unit-')) return { executable, arguments: ['scripts/ci-workspace.mjs', 'unit', task.slice(5)], environmentKeys };
  if (task.startsWith('typecheck-')) return { executable, arguments: ['scripts/ci-workspace.mjs', 'typecheck', task.slice(10)], environmentKeys };
  if (task.startsWith('test-types-')) return { executable, arguments: ['scripts/ci-workspace.mjs', 'test-types', task.slice(11)], environmentKeys };
  if (task === 'safety') return { executable: 'pnpm', arguments: ['typecheck:safety'], environmentKeys };
  if (task === 'coverage') return { executable, arguments: ['scripts/ci-workspace.mjs', 'coverage'], environmentKeys };
  if (task.startsWith('build-')) return { executable: 'pnpm', arguments: ['build'], environmentKeys };
  if (task === 'audit-core') return { executable: 'pnpm', arguments: ['audit:core'], environmentKeys };
  if (task.startsWith('oci-')) return { executable: 'bash', arguments: ['scripts/verify-oci.sh'], environmentKeys };
  if (task.startsWith('browser-')) {
    const [, profile, ...suite] = task.split('-');
    return { executable, arguments: ['scripts/run-browser-shard.mjs', '--profile', profile, '--suite', suite.join('-'), '--prebuilt'], environmentKeys };
  }
  if (task.startsWith('hosted-native-')) {
    const selection = task.slice('hosted-native-'.length);
    const invocations = [];
    if (selection === 'catalog') invocations.push({ executable: 'pnpm', arguments: ['--filter', '@codexia/module-*...', 'build'], environmentKeys: [] });
    invocations.push({ executable, arguments: ['scripts/verify-hosted-native.mjs', '--selection', selection], environmentKeys });
    return invocations;
  }
  throw new Error(`No canonical invocation for ${task}`);
}

function taskEnvironment(task, runtime) {
  const env = { CI: 'true', NODE_ENV: 'workflow-default', TZ: 'workflow-default',
    LANG: 'runner-default', LC_ALL: 'runner-default' };
  if (task.startsWith('unit-')) Object.assign(env, {
    CODEXIA_TEST_DATABASE_URL: 'postgres://codexia:codexia@127.0.0.1:5432/codexia_test',
    CODEXIA_AUTH_TEST_DATABASE_URL: 'postgres://codexia:codexia@127.0.0.1:5432/codexia_auth_test',
    CODEXIA_AUTH_TEST_DISPOSABLE: '1',
  });
  if (task.startsWith('browser-')) {
    const shard = BROWSER_SHARDS.find(({ id }) => task.endsWith(`-${id}`));
    assert.ok(shard, `Unknown browser task ${task}`);
    Object.assign(env, { CODEXIA_E2E_DATABASE_URL: 'postgres://codexia:codexia@postgres:5432/codexia_test',
      CODEXIA_PLAYWRIGHT_IMAGE_DIGEST: PLAYWRIGHT_IMAGE_DIGESTS[shard.project] });
  }
  for (const [key, value] of Object.entries(taskOverrides(task))) {
    env[key] = key === 'CODEXIA_E2E_OUTPUT_DIR' ? `tests/e2e/test-results/${task}` : value;
  }
  return { runtime: { platform: runtime.platform, arch: runtime.arch,
    imageOS: runtime.imageOS ?? null, imageVersion: runtime.imageVersion ?? null }, env };
}

function taskProducerRecipe(task) {
  const group = taskGroup(task);
  const prerequisites = [];
  const profile = requiredBuildProfile(group);
  if (profile) prerequisites.push(`build-${profile}`);
  if (task === 'audit-core') prerequisites.push('build-core');
  if (group.startsWith('hosted-native-') && group !== 'hosted-native-catalog') prerequisites.push('hosted-native-catalog');
  if (task.startsWith('unit-') || task.startsWith('typecheck-') || task.startsWith('test-types-') || task === 'safety') {
    prerequisites.push('workspace-build-prerequisites');
  }
  const external = [];
  if (task.startsWith('unit-') || task.startsWith('browser-')) external.push(POSTGRES_CI_IMAGE);
  if (task.startsWith('oci-')) external.push('docker:ubuntu-24.04-host');
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
  const executable = treeEntries(root, sha).filter(({ file }) => !isNonExecutableDocumentation(file));
  const manifest = executable.find(({ file }) => file === 'package.json');
  assert.ok(manifest?.mode === '100644' || manifest?.mode === '100755', 'Task proof requires a regular root package.json');
  const { packageManager } = JSON.parse(readGit(root, 'cat-file', 'blob', manifest.oid));
  const entries = rows => rows.map(({ mode, file, oid }) => [mode, file, oid]);
  const source = sha256(entries(executable));
  const tests = sha256(entries(executable.filter(({ file }) => testFilePattern.test(file))));
  const dependencies = sha256(entries(executable.filter(({ file }) => dependencyPath(file))));
  const toolchain = sha256({ nodeVersion: runtime.nodeVersion, platform: runtime.platform, arch: runtime.arch,
    imageOS: runtime.imageOS ?? null, imageVersion: runtime.imageVersion ?? null, packageManager: packageManager ?? null });

  return (task, invocations = taskInvocation(task, runtime.execPath)) => {
    const group = taskGroup(task);
    const normalizedInvocations = Array.isArray(invocations) ? invocations : [invocations];
    const canonicalInvocations = normalizedInvocations.map(invocation => ({ ...invocation,
      executable: invocation.executable === runtime.execPath ? 'node' : invocation.executable }));
    return {
      source, tests, dependencies, environment: sha256(taskEnvironment(task, runtime)), toolchain,
      recipe: sha256({ task, group, workflowJob: taskWorkflowJob(task), invocation: canonicalInvocations,
        groupPreparation: 'scripts/ci-workspace.mjs prepare selected-group', concurrencyLimit: 2 }),
      producers: sha256(taskProducerRecipe(task)),
    };
  };
}

export function taskInputProof({ task, closure, sourceSha, planDigest, workflowRunId, workflowAttempt, workflowJob, runtime, reusedFrom }) {
  const proof = { format: 'codexia-ci-task-input-proof/v2', task, mode: 'task-execution', status: 'passed',
    sourceSha, planDigest, workflowRunId, workflowAttempt, workflowJob, runtime, inputClosure: closure };
  return reusedFrom ? { ...proof, reusedFrom } : proof;
}
