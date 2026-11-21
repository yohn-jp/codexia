#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_SHARDS, PROFILES, TYPECHECK_TARGETS, VERIFICATION_GROUPS, VERIFICATION_TASKS, WORKSPACES } from './ci-contract.mjs';

export const FULL_MODEL_OCI_PATHS = Object.freeze([
  '.dockerignore',
  '.github/workflows/full-model-oci-acceptance.yml',
  'Dockerfile',
  'Dockerfile.backend',
  'app/**',
  'modules/**',
  'package.json',
  'packages/**',
  'profiles/**',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/ci-workspace.mjs',
  'scripts/ci-parallel.mjs',
  'scripts/profile-build.mjs',
  'scripts/profile-package.mjs',
  'scripts/verify-oci.sh',
  'scripts/verify-oci-http.mjs',
  'tests/integration/model-oci-lifecycle.acceptance.mjs',
  'tests/integration/model-oci-lifecycle.container.mjs',
  'tests/integration/model-postgres-fixture.mjs',
  '.github/workflows/verify.yml',
]);

/** @param {string} file */
export function matchesFullModelOciPath(file) {
  return typeof file === 'string' && FULL_MODEL_OCI_PATHS.some(pattern =>
    pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern);
}

// Reviewed independent inputs: root unit owns script/route/Worker proof;
// dedicated Ansible, Terraform, audit and static-delivery workflows own
// their corresponding executable integration proofs. New paths fail closed.
export const OPERATIONAL_ROOT_PATHS = Object.freeze([
  'deploy/ansible/acceptance.yml',
  'deploy/ansible/base-runtime.yml',
  'deploy/ansible/base-secrets.yml',
  'deploy/ansible/bootstrap-preflight.yml',
  'deploy/ansible/check_postgres_volume.py',
  'deploy/ansible/deploy.yml',
  'deploy/ansible/enable.yml',
  'deploy/ansible/host-contract.py',
  'deploy/ansible/host-validate.yml',
  'deploy/ansible/host.yml',
  'deploy/ansible/initialize.yml',
  'deploy/ansible/initialize-schema.yml',
  'deploy/ansible/initialize-fresh.yml',
  'deploy/ansible/inspect.yml',
  'deploy/ansible/install-units.yml',
  'deploy/ansible/inventory.example.yml',
  'deploy/ansible/maintenance.yml',
  'deploy/ansible/rotate-probe-credentials.yml',
  'deploy/ansible/preflight.yml',
  'deploy/ansible/prepare.yml',
  'deploy/ansible/requirements.txt',
  'deploy/ansible/site.yml',
  'deploy/ansible/switch-tunnel-to-proxy.yml',
  'deploy/ansible/test-base-runtime-integration.sh',
  'deploy/ansible/test-base-secrets-integration.sh',
  'deploy/ansible/test-base-secrets.sh',
  'deploy/ansible/test-host-integration.sh',
  'deploy/ansible/test-host-validation.sh',
  'deploy/ansible/test-inspect.sh',
  'deploy/ansible/test-preflight.sh',
  'deploy/ansible/test-runtime-contract.sh',
  'deploy/ansible/test-tunnel-dependency.sh',
  'deploy/ansible/test-verify-timer.sh',
  'deploy/ansible/test_host_contract.py',
  'deploy/ansible/test_postgres_volume_layout.py',
  'deploy/ansible/validate-runtime.yml',
  'deploy/ansible/verify-base-db-container.yml',
  'deploy/ansible/verify-base-tunnel-container.yml',
  'deploy/ansible/verify-postgres-roles.sql',
  'deploy/ansible/verify-timer.yml',
  'deploy/ansible/verify-tunnel-legacy.yml',
  'deploy/ansible/verify.yml',
  'deploy/updater/codexia-api-proxy.container.example',
  'deploy/updater/codexia-updater',
  'deploy/updater/codexia-updater-boot.service.example',
  'deploy/updater/codexia-updater.service.example',
  'deploy/updater/codexia-updater.timer.example',
  'deploy/updater/config.example.json',
  'deploy/updater/provision-preflight-role.sql',
  'deploy/updater/proxy.mjs',
  'deploy/updater/standalone-host.mjs',
  'deploy/updater/standalone-maintenance.mjs',
  'deploy/updater/standalone-updater.mjs',
  'deploy/updater/test-runtime-contract-integration.sh',
  'deploy/updater/test-standalone-maintenance-integration.mjs',
  'deploy/updater/test-standalone-maintenance-preload.mjs',
  'deploy/quadlet/codexia-api.container',
  'deploy/quadlet/codexia-data.network',
  'deploy/quadlet/codexia-data.volume',
  'deploy/quadlet/codexia-db.container',
  'deploy/quadlet/codexia-history.volume',
  'deploy/quadlet/codexia-postgres.volume',
  'deploy/quadlet/codexia-tunnel.container',
  'deploy/quadlet/codexia.network',
  'deploy/postgres/010-create-app-role.sh',
  'deploy/cloudflare/identity-probes.json',
  'deploy/cloudflare/ui-routes.json',
  'deploy/cloudflare/terraform/.gitignore',
  'deploy/cloudflare/terraform/main.tf',
  'deploy/cloudflare/terraform/terraform.tfvars.example',
  'deploy/cloudflare/terraform/variables.tf',
  'deploy/cloudflare/terraform/versions.tf',
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
  'scripts/audit/repomix.config.json',
  '.github/workflows/ansible-host.yml',
  '.github/workflows/ansible-base-secrets.yml',
  '.github/workflows/ansible-runtime-contract.yml',
  '.github/workflows/deployment-config.yml',
  '.github/workflows/repository-audit.yml',
  'scripts/verify-deployment-config.mjs',
  'scripts/push-deployment-contract.test.mjs',
  'scripts/push-deployment-admission.mjs',
  'scripts/push-deployment-admission.test.mjs',
  'scripts/push-deployment-certificate.mjs',
  'scripts/create-backend-deployment-certificates.mjs',
  'scripts/verify-backend-push-handoff.mjs',
  'scripts/verify-backend-push-handoff.test.mjs',
  'scripts/backend-deployment-handoff-contract.test.mjs',
  '.github/workflows/backend-deployment-handoff.yml',
  'scripts/push-deployment-recovery.test.mjs',
  'deploy/ansible/push-deployment-recover.sh',
  'scripts/verify-frontend-compatibility.mjs',
  'scripts/verify-frontend-compatibility.test.mjs',
  'scripts/standalone-host.test.mjs',
  'scripts/standalone-maintenance.test.mjs',
  'scripts/standalone-update-controller.mjs',
  'scripts/standalone-update-controller.test.mjs',
  // Encrypted backup and lifecycle have their own exact-head integration workflow.
  'deploy/ansible/backup.yml',
  'deploy/ansible/lifecycle.yml',
  'deploy/ansible/restore-drill.yml',
  'deploy/ansible/test-lifecycle-contract.sh',
  'deploy/ansible/test-lifecycle-contract.yml',
  'deploy/updater/standalone-backup.sh',
  'deploy/updater/test-standalone-backup-lock.sh',
  'deploy/updater/test-standalone-backup-startup-fence.sh',
  'deploy/updater/test-standalone-backup.sh',
  'scripts/standalone-backup-controller.test.mjs',
  '.github/workflows/standalone-backup.yml',
  'docs/deployment/IAC.md',
  'docs/deployment/README.md',
  'docs/deployment/PUSH-DEPLOYMENT.md',
  'docs/deployment/PHASE-F-DISPOSABLE-CI.md',
]);
const operationalRootPaths = new Set(OPERATIONAL_ROOT_PATHS);

export function createVerificationPlan({ files, event, sha, base = null }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || (base !== null && !/^[a-f0-9]{40}$/.test(base))) throw new Error('Invalid verification source identity');
  const selected = new Set(['coverage']);
  let full = event !== 'pull_request' || !Array.isArray(files);
  const fullModelOci = event === 'pull_request' && Array.isArray(files) && files.some(matchesFullModelOciPath);
  const add = (...tasks) => tasks.forEach(task => selected.add(task));
  const browser = profiles => profiles.forEach(profile => BROWSER_SHARDS.forEach(({ id }) => add(`browser-${profile}-${id}`)));
  for (const file of files ?? []) {
    if (typeof file !== 'string' || !file || file.startsWith('/') || file.split('/').includes('..')) { full = true; break; }
    if (operationalRootPaths.has(file)) {
      add('unit-root');
      continue;
    }
    // API client source is read by the canonical deployment route assertion.
    if (file === 'app/src/api.ts') add('unit-root');
    if (file === 'AGENTS.md' || file === 'CONTRIBUTING.md' || file === 'LICENSE' || /^docs\/.*\.md$/u.test(file) || /^README(?:\.[a-z-]+)?\.md$/iu.test(file)) continue;
    // Workspace manifests/configuration, shared contracts and unknown files are global inputs.
    const owner = WORKSPACES.find(item => file.startsWith(`${item.path}/src/`));
    if (!owner || ['contracts', 'persistence-contracts', 'persistence-postgres', 'module-runtime', 'migration', 'core', 'api'].includes(owner.id)) {
      const spec = BROWSER_SHARDS.find(item => file === `tests/e2e/${item.file}`);
      if (spec) {
        add('test-types-app-e2e');
        for (const profile of PROFILES) {
          add(`build-${profile}`, `browser-${profile}-${spec.id}`);
          if (spec.id === 'ui-v1') add(`browser-${profile}-webkit`);
        }
        continue;
      }
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
  if ([...selected].some(task => task.startsWith('hosted-native-'))) add('hosted-native-catalog');
  if ([...selected].some(task => task.startsWith('hosted-native-') && task !== 'hosted-native-catalog')) add('build-full');
  const tasks = VERIFICATION_TASKS.filter(task => full || selected.has(task));
  return {
    version: 2, sha, base, event, mode: full ? 'full' : 'affected', files: files ?? null,
    full_model_oci: fullModelOci,
    tasks,
    groups: Object.keys(VERIFICATION_GROUPS).filter(group => VERIFICATION_GROUPS[group].some(task => tasks.includes(task))),
    excluded: VERIFICATION_TASKS.filter(task => !tasks.includes(task)).map(task => ({ task, reason: 'Outside the affected source/profile boundaries of this PR' })),
  };
}

export function validateVerificationPlan(plan) {
  if (!plan || JSON.stringify(plan) !== JSON.stringify(createVerificationPlan(plan))) throw new Error('Verification plan does not match canonical impact rules');
  return plan;
}

export function planDigest(plan) { return createHash('sha256').update(JSON.stringify(validateVerificationPlan(plan))).digest('hex'); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sha = process.env.CODEXIA_EXPECTED_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const event = process.env.GITHUB_EVENT_NAME ?? 'workflow_dispatch';
  const payload = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const pushBase = event === 'push' && payload.after === sha && /^[a-f0-9]{40}$/u.test(payload.before ?? '') &&
    !/^0{40}$/u.test(payload.before) ? payload.before : null;
  const base = payload.pull_request?.base?.sha ?? pushBase;
  let files = null;
  if (event === 'pull_request' && /^[a-f0-9]{40}$/.test(base ?? '')) {
    try {
      files = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...${sha}`, '--'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);
    } catch { /* Missing history must run full verification, never an empty selection. */ }
  }
  const plan = createVerificationPlan({ files, event, sha, base });
  const planPath = process.env.CODEXIA_CI_PLAN_PATH ?? 'ci-plan.json';
  mkdirSync(path.dirname(planPath), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    const outputs = {
      plan: JSON.stringify(plan),
      unit: JSON.stringify(['core', 'modules'].filter(id => plan.groups.includes(`unit-${id}`))),
      types: JSON.stringify(['sources', 'tests'].filter(id => plan.groups.includes(`types-${id}`))),
      build: JSON.stringify(PROFILES.filter(id => plan.groups.includes(`build-${id}`))),
      oci: JSON.stringify(PROFILES.filter(id => plan.groups.includes(`oci-${id}`))),
      browser: JSON.stringify(PROFILES.flatMap(profile => ['writing', 'reference', 'webkit'].filter(id => plan.groups.includes(`browser-${profile}-${id}`)).map(id => ({ group: `${profile}-${id}`, profile })))),
      hosted_catalog: String(plan.groups.includes('hosted-native-catalog')),
      hosted: JSON.stringify(['core', 'selected', 'full'].filter(id => plan.groups.includes(`hosted-native-${id}`))),
      full_model_oci: String(plan.full_model_oci),
    };
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Verification plan: **${plan.mode}**, ${plan.tasks.length}/${VERIFICATION_TASKS.length} validations in ${plan.groups.length} execution groups at ${sha}.\n\n` +
    `Full model OCI acceptance: **${plan.full_model_oci ? 'SELECTED' : 'NOT_SELECTED'}**.\n\n` +
    plan.excluded.map(item => `- NOT_SELECTED: ${item.task}: ${item.reason}\n`).join(''));
  console.log(JSON.stringify(plan));
}
