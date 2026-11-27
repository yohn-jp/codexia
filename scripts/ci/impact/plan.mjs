#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_SHARDS, CONFORMANCE_TASKS, PROFILES, TYPECHECK_TARGETS, VERIFICATION_GROUPS, VERIFICATION_TASKS, WORKSPACES, isOpenApiGenerationInput, isFastifyGenerationInput } from './contract.mjs';
import { ROOT_VERIFICATION_DOCUMENTS, UX_PROJECTION_DOCUMENTS, isNonExecutableDocumentation, isRequirementsTraceInput, taskGroup, taskWorkflowJob } from '../evidence/task-inputs.mjs';

export const FULL_MODEL_OCI_PATHS = Object.freeze([
  'scripts/shared/python-env.sh',
  '.dockerignore',
  '.github/workflows/full-model-oci-acceptance.yml',
  'Dockerfile',
  'Dockerfile.backend',
  'app/**',
  'modules/**',
  'package.json',
  'packages/**',
  // Model OCI uses packaged runtime sources, not local unit/contract test fixtures.
  // Ordered negations must match the standalone main-push workflow exactly.
  '!app/**/test/**',
  '!app/**/tests/**',
  '!app/**/*.test.*',
  '!modules/**/test/**',
  '!modules/**/tests/**',
  '!modules/**/*.test.*',
  '!packages/**/test/**',
  '!packages/**/tests/**',
  '!packages/**/*.test.*',
  'app/src/**/test/**',
  'app/src/**/tests/**',
  'modules/**/src/**/test/**',
  'modules/**/src/**/tests/**',
  'packages/**/src/**/test/**',
  'packages/**/src/**/tests/**',
  // api and persistence-contracts package their entire compiled source trees, including tests/specs.
  'packages/api/src/**',
  'packages/persistence-contracts/src/**',
  'profiles/**',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/ci/impact/plan.mjs',
  'scripts/ci/execution/workspace.mjs',
  'scripts/ci/execution/parallel.mjs',
  'scripts/build/packaging/profile-build.mjs',
  'scripts/shared/read-regular-file.mjs',
  'scripts/build/packaging/profile-package.mjs',
  'scripts/verification/runtime/oci.sh',
  'scripts/verification/runtime/oci-http.mjs',
  'scripts/verification/runtime/better-auth-fixture.sh',
  'scripts/deployment/lifecycle/auth-oidc.mjs',
  'tests/integration/model-oci-lifecycle.acceptance.mjs',
  'tests/integration/model-oci-lifecycle-arguments.mjs',
  'tests/integration/model-oci-lifecycle-arguments.test.mjs',
  'tests/integration/model-oci-lifecycle.container.mjs',
  'tests/integration/model-postgres-fixture.mjs',
  '.github/workflows/verify.yml',
]);

const HTTP_CONTRACT_ROUTE_SOURCE_PATHS = new Set([
  'packages/api/src/server.ts',
  'packages/api/src/generated/http-contract.json',
  'packages/api/src/http-contributions.ts',
  'packages/api/package.json',
  'packages/api/src/persistence-routes.ts',
  'packages/api/src/owner-setup.ts',
  'packages/api/src/better-auth.ts',
  'modules/mcp/src/http.ts',
  'modules/mcp/package.json',
  'modules/publishing/src/http.ts',
  'modules/publishing/package.json',
]);

/** @param {string} file */
export function matchesFullModelOciPath(file) {
  if (typeof file !== 'string') return false;
  let included = false;
  for (const expression of FULL_MODEL_OCI_PATHS) {
    const exclude = expression.startsWith('!');
    const pattern = exclude ? expression.slice(1) : expression;
    if (path.matchesGlob(file, pattern)) included = !exclude;
  }
  return included;
}

// Reviewed independent inputs: root unit owns script/route/Worker proof;
// dedicated Ansible, Terraform, audit and static-delivery workflows own
// their corresponding executable integration proofs. New paths fail closed.
export const OPERATIONAL_ROOT_PATHS = Object.freeze([
  '.github/workflows/ansible-base-secrets.yml',
  '.github/workflows/ansible-host.yml',
  '.github/workflows/backend-deployment-handoff.yml',
  '.github/workflows/deployment-config.yml',
  '.github/workflows/push-backup.yml',
  '.github/workflows/push-host.yml',
  '.github/workflows/repository-audit.yml',
  '.github/workflows/tailscale-connectivity.yml',
  'deploy/ansible/base-runtime.yml',
  'deploy/ansible/base-secrets.yml',
  'deploy/ansible/check_postgres_volume.py',
  'deploy/ansible/ci-mitogen-playbook.sh',
  'deploy/ansible/deploy.yml',
  'deploy/ansible/preflight-writer-observe.sh',
  'deploy/ansible/test-preflight-writer-observe.sh',
  'deploy/ansible/deploy-prepare.yml',
  'deploy/ansible/deploy-transaction.yml',
  'deploy/ansible/host-contract.py',
  'deploy/ansible/host-validate.yml',
  'deploy/ansible/host.yml',
  'deploy/ansible/inspect.yml',
  'deploy/ansible/inventory.example.yml',
  'deploy/ansible/push-deployment-recover.sh',
  'deploy/ansible/requirements.txt',
  'deploy/ansible/restore-drill.yml',
  'deploy/ansible/site.yml',
  'deploy/ansible/test-base-runtime-integration.sh',
  'deploy/ansible/test-base-secrets-integration.sh',
  'deploy/ansible/test-base-secrets.sh',
  'deploy/ansible/test-host-integration.sh',
  'deploy/ansible/test-host-validation.sh',
  'deploy/ansible/test-inspect.sh',
  'deploy/ansible/test-push-host.sh',
  'deploy/ansible/test_host_contract.py',
  'deploy/ansible/test_postgres_volume_layout.py',
  'deploy/ansible/verify-base-db-container.yml',
  'deploy/ansible/verify-base-tunnel-container.yml',
  'deploy/backup/backup.sh',
  'deploy/cloudflare/identity-probes.json',
  'deploy/cloudflare/public-protocol-paths.json',
  'deploy/cloudflare/terraform/.terraform.lock.hcl',
  'deploy/cloudflare/terraform/.gitignore',
  'deploy/cloudflare/terraform/ACCESS-POLICY-MIGRATION.md',
  'deploy/cloudflare/terraform/initial-frontend-version/main.tf',
  'deploy/cloudflare/terraform/main.tf',
  'deploy/cloudflare/terraform/terraform.tfvars.example',
  'deploy/cloudflare/terraform/variables.tf',
  'deploy/cloudflare/terraform/versions.tf',
  'deploy/cloudflare/ui-routes.json',
  'deploy/postgres/010-create-app-role.sh',
  'deploy/quadlet/codexia-api.container',
  'deploy/quadlet/codexia-data.network',
  'deploy/quadlet/codexia-data.volume',
  'deploy/quadlet/codexia-db.container',
  'deploy/quadlet/codexia-history.volume',
  'deploy/quadlet/codexia-postgres.volume',
  'deploy/quadlet/codexia-tunnel.container',
  'deploy/quadlet/codexia.network',
  ...ROOT_VERIFICATION_DOCUMENTS,
  'edge/frontend/package-lock.json',
  'edge/frontend/package.json',
  'edge/frontend/static/_headers',
  'edge/frontend/static/_redirects',
  'edge/frontend/test/static-smoke.mjs',
  'edge/frontend/test/worker.test.ts',
  'edge/frontend/tsconfig.json',
  'edge/frontend/wrangler.jsonc',
  'scripts/audit/export.mjs',
  'scripts/audit/export.test.mjs',
  'scripts/audit/portal.mjs',
  'scripts/audit/ux-artifact.mjs',
  'scripts/audit/ux-artifact.test.mjs',
  // Reviewed root-only CI contract tests; orchestration implementations still fail closed.
  'scripts/ci/browser/coverage-reporter.test.mjs',
  'scripts/ci/browser/shards.test.mjs',
  'scripts/ci/certification/reuse-merged-pr.test.mjs',
  'scripts/ci/evidence/artifact-selection.test.mjs',
  'scripts/ci/evidence/coverage-inputs.test.mjs',
  'scripts/ci/evidence/download-artifacts.test.mjs',
  'scripts/ci/evidence/input-proof.test.mjs',
  'scripts/ci/evidence/profile-artifact.test.mjs',
  'scripts/ci/evidence/proof-reuse.test.mjs',
  'scripts/ci/evidence/task-inputs.test.mjs',
  'scripts/ci/evidence/validation.test.mjs',
  'scripts/ci/execution/parallel.test.mjs',
  'scripts/ci/execution/typecheck-tests.test.mjs',
  'scripts/ci/execution/workspace.test.mjs',
  'scripts/ci/impact/contract.test.mjs',
  'scripts/ci/impact/design-admission.test.mjs',
  'scripts/ci/impact/evidence-checkout.test.mjs',
  'scripts/ci/impact/plan.test.mjs',
  'scripts/ci/impact/security-scan-scope.test.mjs',
  'scripts/ci/impact/security-admission.test.mjs',
  'scripts/pages-api/pack.mjs',
  'scripts/pages-api/pack.test.mjs',
  'scripts/pages-api/package-lock.json',
  'scripts/pages-api/package.json',
  'scripts/pages-api/reference-entry.js',
  'scripts/verification/artifacts/pages-smoke.mjs',
  'scripts/verification/artifacts/pages-live-ux.mjs',
  'scripts/verification/artifacts/pages-live-ux.test.mjs',
  'scripts/pages-ui/navigation.mjs',
  'scripts/audit/repomix.config.json',
  '.github/workflows/production-preflight.yml',
  'deploy/ansible/preflight-observe.py',
  'deploy/ansible/reset-absent-app-database.py',
  'deploy/ansible/preflight-observe.yml',
  'deploy/ansible/test_preflight_observe.py',
  'deploy/ansible/prepare-deploy-ssh.sh',
  'scripts/deployment/preflight/observe.mjs',
  'scripts/deployment/preflight/run.mjs',
  'scripts/deployment/preflight/observe.test.mjs',
  'scripts/release/frontend/initial-publication.mjs',
  'scripts/release/frontend/initial-publication.test.mjs',
  'scripts/verification/infrastructure/identity-probe-client.mjs',
  'scripts/verification/artifacts/frontend.mjs',
  'scripts/deployment/preflight/evidence-digest.mjs',
  'scripts/deployment/preflight/preservation.mjs',
  'scripts/deployment/preflight/plan.mjs',
  'scripts/deployment/preflight/plan.test.mjs',
  'scripts/deployment/bootstrap/activate-backend.mjs',
  'scripts/deployment/bootstrap/activate-backend.test.mjs',
  'scripts/deployment/handoff/backend-contract.test.mjs',
  'scripts/deployment/admission/create-certificates.mjs',
  'scripts/deployment/admission/validate.mjs',
  'scripts/deployment/admission/validate.test.mjs',
  'scripts/deployment/recovery/backup.test.mjs',
  'scripts/deployment/admission/certificate.mjs',
  'scripts/deployment/admission/contract.test.mjs',
  'scripts/deployment/recovery/recovery.test.mjs',
  'scripts/deployment/lifecycle/host.test.mjs',
  'scripts/deployment/handoff/verify-push.mjs',
  'scripts/deployment/handoff/verify-push.test.mjs',
  'scripts/verification/infrastructure/deployment-config.mjs',
  'scripts/verification/infrastructure/public-oauth-edge.mjs',
  'scripts/verification/infrastructure/public-oauth-edge.test.mjs',
  'scripts/release/frontend/verify-compatibility.mjs',
  'scripts/release/frontend/verify-compatibility.test.mjs',
  'scripts/ios/verify-linux-swift.sh',
  'scripts/ios/swift-linux-toolchain.json',
]);
// Reviewed Native inputs keep Apple acceptance in the dedicated workflows.
// SwiftPM inputs also select the Linux task below. Unknown inputs fail closed.
export const NATIVE_IOS_WORKFLOW_INPUTS = Object.freeze([
  '.github/workflows/ios-api.yml',
  '.github/workflows/ios-editor.yml',
]);
const NATIVE_IOS_ROOTS = Object.freeze([
  'ios/CodexiaTransport/',
  'ios/CodexiaApp/',
  'ios/CodexiaEditor/',
]);
const NATIVE_IOS_GENERATOR_INPUTS = new Set([
  'ios/CodexiaTransport/check-operation-manifest.py',
  'ios/CodexiaTransport/generate.sh',
  'ios/CodexiaTransport/normalize-openapi.py',
  'ios/CodexiaTransport/openapi-generator-config.yaml',
]);
export function isNativeIosOwnedInput(file) {
  if (NATIVE_IOS_WORKFLOW_INPUTS.includes(file) || file === '.github/actions/generate-swift-api/action.yml') return true;
  if (!NATIVE_IOS_ROOTS.some(root => file.startsWith(root))) return false;
  return /\.(?:swift|entitlements|pbxproj|xcscheme|plist|xcconfig)$/u.test(file) ||
    /\/(?:Package\.swift|Package\.resolved|\.gitignore)$/u.test(file) ||
    NATIVE_IOS_GENERATOR_INPUTS.has(file);
}

const SWIFT_LINUX_INPUTS = new Set([
  '.github/workflows/verify.yml',
  'scripts/ci/certification/certify.mjs',
  'scripts/ci/evidence/task-inputs.mjs',
  'scripts/ci/execution/group.mjs',
  'scripts/ci/impact/contract.mjs',
  'scripts/ci/impact/plan.mjs',
  'scripts/ios/verify-linux-swift.sh',
  'scripts/ios/swift-linux-toolchain.json',
  'scripts/shared/python-env.sh',
  'packages/http-contract/tspconfig.yaml',
  ...NATIVE_IOS_GENERATOR_INPUTS,
]);

function isSwiftLinuxInput(file) {
  return SWIFT_LINUX_INPUTS.has(file) || isOpenApiGenerationInput(file) ||
    /^ios\/(?:CodexiaEditor|CodexiaTransport)\/(?:Sources\/|Tests\/|Package\.(?:swift|resolved)$)/u.test(file) ||
    /^packages\/http-contract\/(?:src|scripts|openapi)\//u.test(file);
}

function isChangedPath(file) {
  return typeof file === 'string' && Boolean(file) &&
    !file.startsWith('/') && !file.split('/').includes('..') && !file.includes('\\');
}

const operationalRootPaths = new Set(OPERATIONAL_ROOT_PATHS);
export const OPERATIONAL_ROOT_PREFIXES = Object.freeze(['scripts/ci/dashboard/', 'scripts/pages-ui/', 'scripts/ux-simulator/']);
const uxProjectionDocuments = new Set(UX_PROJECTION_DOCUMENTS);
const DB_CONTRACT_SOURCE_PATHS = new Set([
  'docs/architecture/POSTGRES-CONTRACT-VERIFICATION.md',
  'docs/architecture/DATABASE-DETAIL-CONTRACT.md',
  'docs/architecture/DATA-MODEL.md',
  'docs/requirements/REQUIREMENT-REGISTER.md',
  'docs/verification/SPECIFICATION-TOOLING-ACCEPTANCE.md',
  'deploy/ansible/verify-postgres-roles.sql',
  'packages/api/src/auth-schema.ts',
  'packages/api/src/migrate-auth.ts',
  'packages/persistence-postgres/src/migrate.ts',
  'packages/persistence-postgres/src/migration-set.ts',
]);

export function createVerificationPlan({ files, event, sha, base = null }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || (base !== null && !/^[a-f0-9]{40}$/.test(base))) throw new Error('Invalid verification source identity');
  const selected = new Set(['coverage']);
  let full = event !== 'pull_request' || !Array.isArray(files);
  // An unavailable/invalid PR diff cannot prove that the real-model acceptance is irrelevant.
  let fullModelOci = event === 'pull_request' && (!Array.isArray(files) ||
    files.some(file => !isChangedPath(file) || matchesFullModelOciPath(file)));
  const swiftLinux = !Array.isArray(files) || files.some(file => !isChangedPath(file) || isSwiftLinuxInput(file));
  const add = (...tasks) => tasks.forEach(task => selected.add(task));
  const browser = profiles => profiles.forEach(profile => BROWSER_SHARDS.forEach(({ id }) => add(`browser-${profile}-${id}`)));
  for (const file of files ?? []) {
    // Fail closed on changed JS/TS sources.
    if (file === 'biome.json' ||
        (/^(?:app|packages|modules|edge\/frontend)\//u.test(file) && /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/u.test(file))) add('biome-ci');
    if (!isChangedPath(file)) { full = true; break; }
    if (isRequirementsTraceInput(file) || HTTP_CONTRACT_ROUTE_SOURCE_PATHS.has(file)) add('requirements-trace');
    const conformanceTask = Object.entries(CONFORMANCE_TASKS).find(([, entry]) => file.startsWith(`${path.dirname(entry)}/`));
    if (conformanceTask) {
      add(conformanceTask[0]);
      continue;
    }
    if (file === 'docs/verification/SPECIFICATION-TOOLING-ACCEPTANCE.md') add(...Object.keys(CONFORMANCE_TASKS));
    if (file === 'docs/architecture/HTTP-PLATFORM-MIGRATION.md' || HTTP_CONTRACT_ROUTE_SOURCE_PATHS.has(file) ||
        file.startsWith('packages/http-contract/')) add('http-conformance');
    if (file === 'docs/architecture/MCP-V2-MIGRATION.md' || file.startsWith('modules/mcp/')) add('mcp-conformance');
    if (file.startsWith('scripts/ux-simulator/')) {
      add('unit-root');
      continue;
    }
    if (uxProjectionDocuments.has(file)) add('unit-root');
    if (/^packages\/persistence-postgres\/tests\/db-contract\//u.test(file) || file.startsWith('scripts/postgres-contract/')) {
      add('db-contract', 'unit-persistence-postgres', 'typecheck-foundations');
      continue;
    }
    if (DB_CONTRACT_SOURCE_PATHS.has(file)) add('db-contract');
    if (file === 'deploy/backup/backup.sh') add('db-contract');
    if ((file.startsWith('docs/requirements/') && file.endsWith('.md')) ||
        file === 'scripts/strictdoc/strictdoc_config.py' ||
        file.startsWith('scripts/strictdoc/')) {
      add('requirements-trace');
      continue;
    }
    if (file.startsWith('docs/architecture/') || file.startsWith('docs/deployment/') || file.startsWith('docs/security/') ||
        file === 'docs/verification/ARCHITECTURE-ATLAS.md' ||
        file.startsWith('scripts/architecture/') || file === 'scripts/architecture-diagrams/pack.mjs' ||
        file === 'scripts/architecture-diagrams/pack.test.mjs') add('architecture-g5');
    if (operationalRootPaths.has(file) || OPERATIONAL_ROOT_PREFIXES.some(prefix => file.startsWith(prefix) && file.length > prefix.length)) {
      add('unit-root');
      continue;
    }
    if (
      file.startsWith('packages/http-contract/src/') ||
      file.startsWith('packages/http-contract/test/') ||
      file.startsWith('packages/http-contract/scripts/') ||
      file.startsWith('packages/http-contract/openapi/') ||
      file.startsWith('packages/http-contract/baselines/') ||
      file === 'packages/http-contract/tspconfig.yaml' ||
      file === 'packages/http-contract/redocly.yaml'
    ) {
      add('unit-http-contract', 'typecheck-http-contract', 'test-types-packages');
      // The emitted Fastify routes are packaged in both images. Web builds consume
      // Orval's operations through the app and root deployment route assertions.
      if (isFastifyGenerationInput(file)) {
        add('unit-api', 'typecheck-core-api', 'http-conformance', 'build-core', 'build-full', 'audit-core', 'oci-core', 'oci-full');
      }
      if (isOpenApiGenerationInput(file) || file.startsWith('packages/http-contract/openapi/')) {
        add('unit-app', 'unit-root', 'typecheck-app', 'test-types-app-e2e', 'safety');
        browser(PROFILES);
      }
      continue;
    }
    if (HTTP_CONTRACT_ROUTE_SOURCE_PATHS.has(file)) add('unit-http-contract');
    // The canonical deployment route assertion reads the API transport and Orval manifest.
    if (file === 'app/src/api-transport.ts' || file === 'app/src/generated/http/client.operations.ts') add('unit-root');
    if (file === 'packages/api/test/passkey-bootstrap.acceptance.test.ts' ||
        file === 'packages/api/scripts/run-passkey-acceptance.mjs') {
      add('unit-api', 'typecheck-core-api', 'test-types-packages', 'build-core', 'browser-core-passkey-bootstrap');
      continue;
    }
    if (event === 'pull_request' && isNativeIosOwnedInput(file)) {
      // Apple SDK and simulator proof is owned by the manual iOS workflows.
      // Root contract tests and canonical coverage still certify PR admission.
      add('unit-root');
      continue;
    }
    if (isNonExecutableDocumentation(file)) continue;
    // Workspace manifests/configuration, shared contracts and unknown files are global inputs.
    const owner = WORKSPACES.find(item => file.startsWith(`${item.path}/src/`));
    if (!owner || ['contracts', 'persistence-contracts', 'persistence-postgres', 'module-runtime', 'core', 'api'].includes(owner.id)) {
      const spec = BROWSER_SHARDS.find(item => file === `tests/e2e/${item.file}`);
      if (spec) {
        add('test-types-app-e2e');
        for (const profile of PROFILES) {
          add(`build-${profile}`, `browser-${profile}-${spec.id}`);
        }
        continue;
      }
      // The declared workspace root test/ and tests/ directories are outside
      // the runtime package source tree. Unknown owners remain fail-closed.
      const knownWorkspaceFixture = WORKSPACES.some(item =>
        file.startsWith(`${item.path}/test/`) || file.startsWith(`${item.path}/tests/`));
      // The Swift native client is built by its independent iOS lifecycle, not model OCI.
      if (!owner && !knownWorkspaceFixture && event === 'pull_request') fullModelOci = true;
      full = true;
      continue;
    }
    const testOnly = /\.(?:test|spec)\.tsx?$/u.test(file);
    add(`unit-${owner.id}`, `typecheck-${TYPECHECK_TARGETS.find(item => item.workspaces.includes(owner.id)).id}`,
      owner.id === 'app' ? 'test-types-app-e2e' : 'test-types-modules');
    if (testOnly) continue;
    if (owner.id === 'app') {
      add('build-core', 'audit-core', 'build-full', 'safety');
      browser(PROFILES);
    } else if (/\/browser(?:\/|\.|$)/u.test(file)) {
      add('build-full');
      browser(['full']);
    } else {
      // Server modules can participate in runtime composition and other module capabilities.
      full = true;
    }
  }
  // A selected browser suite always consumes the same-profile build result.
  for (const profile of PROFILES) if ([...selected].some(task => task.startsWith(`browser-${profile}-`))) add(`build-${profile}`);
  const tasks = VERIFICATION_TASKS.filter(task => task === 'swift-linux' ? swiftLinux : full || selected.has(task));
  return {
    version: 3, sha, base, event, mode: full ? 'full' : 'affected', files: files ?? null,
    full_model_oci: fullModelOci,
    tasks,
    groups: Object.keys(VERIFICATION_GROUPS).filter(group => VERIFICATION_GROUPS[group].some(task => tasks.includes(task))),
    excluded: VERIFICATION_TASKS.filter(task => !tasks.includes(task)).map(task => ({ task, reason: 'Outside the affected source/profile boundaries' })),
  };
}

export function validateVerificationPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Verification plan is invalid');
  const { coverageReuse, ...canonical } = plan;
  if (JSON.stringify(canonical) !== JSON.stringify(createVerificationPlan(canonical))) throw new Error('Verification plan does not match canonical impact rules');
  if (coverageReuse !== undefined) assertCoverageReuse(plan, coverageReuse);
  return plan;
}

const INPUT_PROOF_DIMENSIONS = ['source', 'tests', 'dependencies', 'environment', 'toolchain', 'recipe', 'producers'];
function assertCoverageReuse(plan, receipt) {
  const fields = ['task', 'sourceSha', 'proofSourceSha', 'planDigest', 'workflowRunId',
    'workflowAttempt', 'workflowId', 'repositoryId', 'jobId', 'workflowJob', 'artifactId',
    'artifactName', 'artifactDigest', 'inputClosure', 'runtime', 'certification'];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
      JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(fields.sort())) {
    throw new Error('Invalid coverage reuse receipt schema');
  }
  if (plan.event !== 'pull_request' || !plan.tasks.includes('coverage')) throw new Error('Coverage proof reuse is only valid for a selected PR coverage task');
  const assertReceipt = (proof, task, { taskExecution = false } = {}) => {
    if (!proof || typeof proof !== 'object' || Array.isArray(proof) || proof.task !== task || proof.sourceSha !== plan.base) {
      throw new Error(`Invalid exact-base ${task} proof identity`);
    }
    if (!/^[a-f0-9]{40}$/u.test(proof.sourceSha ?? '') || !/^[a-f0-9]{40}$/u.test(proof.proofSourceSha ?? '')) throw new Error('Invalid task proof source');
    if (!/^[a-f0-9]{64}$/u.test(proof.planDigest ?? '')) throw new Error('Invalid task proof plan digest');
    for (const key of ['workflowRunId', 'workflowAttempt', 'workflowId', 'repositoryId', 'jobId', 'artifactId']) {
      if (!Number.isSafeInteger(proof[key]) || proof[key] < 1) throw new Error(`Invalid task proof ${key}`);
    }
    const group = taskExecution ? taskGroup(task) : 'types-tests';
    const workflowJob = taskExecution ? taskWorkflowJob(task) : 'types';
    if (proof.workflowJob !== workflowJob || proof.artifactName !== `ci-evidence-${group}`) throw new Error('Invalid task proof producer identity');
    if (!/^sha256:[a-f0-9]{64}$/u.test(proof.artifactDigest ?? '')) throw new Error('Invalid task proof artifact digest');
    if (!proof.inputClosure || typeof proof.inputClosure !== 'object' || Array.isArray(proof.inputClosure) ||
        JSON.stringify(Object.keys(proof.inputClosure).sort()) !== JSON.stringify([...INPUT_PROOF_DIMENSIONS].sort()) ||
        Object.values(proof.inputClosure).some(value => !/^[a-f0-9]{64}$/u.test(value))) throw new Error('Incomplete task proof input closure');
    const runtime = proof.runtime;
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) throw new Error('Missing task proof runtime');
    for (const key of ['platform', 'arch', 'nodeVersion', 'execPath', 'cwd']) if (typeof runtime[key] !== 'string' || !runtime[key]) throw new Error(`Invalid task proof runtime ${key}`);
    if (!/^(?:\/|[A-Za-z]:\\)/u.test(runtime.execPath) || !/^(?:\/|[A-Za-z]:\\)/u.test(runtime.cwd)) throw new Error('Task proof runtime paths must be absolute');
    for (const key of ['imageOS', 'imageVersion']) if (runtime[key] !== null && typeof runtime[key] !== 'string') throw new Error(`Invalid task proof runtime ${key}`);
    const certification = proof.certification;
    if (!certification || typeof certification !== 'object' || certification.sourceSha !== plan.base ||
        !['Certify every required exact-source matrix element', 'Certify reused merged PR proof'].includes(certification.step)) {
      throw new Error('Invalid main task proof certification');
    }
    for (const key of ['workflowRunId', 'workflowAttempt', 'workflowId', 'repositoryId', 'jobId']) {
      if (!Number.isSafeInteger(certification[key]) || certification[key] < 1) throw new Error(`Invalid main task proof certification ${key}`);
    }
  };
  assertReceipt(receipt, 'coverage');
}


/** Read the immutable change boundary used by impact selection and certification. */
export function readVerificationFiles({ event, base, sha }) {
  if (!['pull_request', 'push'].includes(event) || !/^[a-f0-9]{40}$/u.test(base ?? '')) return null;
  const range = event === 'pull_request' ? `${base}...${sha}` : `${base}..${sha}`;
  try {
    return execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', range, '--'], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    }).split('\0').filter(Boolean);
  } catch {
    // Missing history must run full verification, never an empty selection.
    return null;
  }
}

export function assertExactPrImpact(plan, expectedBase, changedFiles) {
  validateVerificationPlan(plan);
  if (plan.event !== 'pull_request') throw new Error('Exact PR impact verification requires a PR plan');
  if (!/^[a-f0-9]{40}$/u.test(expectedBase ?? '') || plan.base !== expectedBase) {
    throw new Error('Impact plan PR base does not match the event');
  }
  if (JSON.stringify(plan.files) !== JSON.stringify(changedFiles)) {
    throw new Error('Impact plan does not match the exact PR diff');
  }
}

export function planDigest(plan) {
  const { coverageReuse: _coverageReuse, ...canonical } = validateVerificationPlan(plan);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function verificationPlanOutputs(plan) {
  validateVerificationPlan(plan);
  const browserMatrix = profile => JSON.stringify(['writing', 'reference', 'ui-v1']
    .filter(id => plan.groups.includes(`browser-${profile}-${id}`)).map(id => {
      const group = `${profile}-${id}`;
      const visualTask = `browser-${profile}-redesign-visual`;
      const captureUiReview = VERIFICATION_GROUPS[`browser-${group}`].includes(visualTask) && plan.tasks.includes(visualTask);
      return { group, profile, captureUiReview };
    }));
  return {
    plan: JSON.stringify(plan),
    biome: String(plan.groups.includes('biome')),
    unit: JSON.stringify(plan.groups.filter(group => group.startsWith('unit-')).map(group => group.slice(5))),
    types: JSON.stringify(plan.groups.filter(group => group.startsWith('types-')).map(group => group.slice(6))),
    build: JSON.stringify(PROFILES.filter(id => plan.groups.includes(`build-${id}`))),
    oci: JSON.stringify(PROFILES.filter(id => plan.groups.includes(`oci-${id}`))),
    browser_core: browserMatrix('core'),
    browser_full: browserMatrix('full'),
    full_model_oci: String(plan.full_model_oci),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sha = process.env.CODEXIA_EXPECTED_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const event = process.env.GITHUB_EVENT_NAME ?? 'workflow_dispatch';
  const payload = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const pushBase = event === 'push' && payload.after === sha && /^[a-f0-9]{40}$/u.test(payload.before ?? '') &&
    !/^0{40}$/u.test(payload.before) ? payload.before : null;
  const base = payload.pull_request?.base?.sha ?? pushBase;
  const files = readVerificationFiles({ event, base, sha });
  const plan = createVerificationPlan({ files, event, sha, base });
  const planPath = process.env.CODEXIA_CI_PLAN_PATH ?? 'ci-plan.json';
  mkdirSync(path.dirname(planPath), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(verificationPlanOutputs(plan)).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Verification plan: **${plan.mode}**, ${plan.tasks.length}/${VERIFICATION_TASKS.length} validations in ${plan.groups.length} execution groups at ${sha}.\n\n` +
    `Full model OCI acceptance: **${plan.full_model_oci ? 'SELECTED' : 'NOT_SELECTED'}**.\n\n` +
    plan.excluded.map(item => `- NOT_SELECTED: ${item.task}: ${item.reason}\n`).join(''));
  console.log(JSON.stringify(plan));
}
