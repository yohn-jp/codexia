import assert from 'node:assert/strict';
import { test } from 'node:test';
import { componentReleaseAffected } from './release-impact.mjs';

test('verified main release respects prior frontend and backend push path scopes', () => {
  assert.equal(componentReleaseAffected('frontend', ['app/src/App.tsx']), true);
  assert.equal(componentReleaseAffected('frontend', ['edge/frontend/wrangler.jsonc']), true);
  assert.equal(componentReleaseAffected('frontend', ['README.md']), false);
  assert.equal(componentReleaseAffected('backend', ['packages/api/src/server.ts']), true);
  assert.equal(componentReleaseAffected('backend', ['Dockerfile.backend']), true);
  assert.equal(componentReleaseAffected('backend', ['modules/story/src/browser.tsx']), false);
  assert.equal(componentReleaseAffected('backend', ['modules/story/src/browser.tsx', 'Dockerfile.backend']), true);
  assert.equal(componentReleaseAffected('backend', ['.github/workflows/frontend-release.yml']), false);
  assert.equal(componentReleaseAffected('frontend', ['.github/workflows/frontend-release.yml']), true);
});
test('test-only changes do not request runtime component release builds', () => {
  for (const file of [
    'packages/persistence-postgres/tests/db-contract/runner.test.mjs',
    'packages/http-contract/test/fastify-persistence-registration.test.ts',
    'packages/core/src/snapshot-reuse.test.ts',
    'modules/mcp/src/tool-catalog.test.ts',
    'app/src/api-generated.test.ts',
  ]) {
    assert.equal(componentReleaseAffected('backend', [file]), false, `backend: ${file}`);
    assert.equal(componentReleaseAffected('frontend', [file]), false, `frontend: ${file}`);
  }
  for (const [component, file] of [
    ['backend', 'packages/api/src/server.ts'],
    ['backend', 'modules/mcp/src/tools.ts'],
    ['backend', 'Dockerfile.backend'],
    ['frontend', 'app/src/api.ts'],
    ['frontend', 'modules/story/src/browser.tsx'],
    ['frontend', 'packages/core/src/index.ts'],
  ]) assert.equal(componentReleaseAffected(component, [file]), true, `${component}: ${file}`);
  assert.equal(componentReleaseAffected('backend', [
    'packages/http-contract/test/fastify-persistence-registration.test.ts',
    'packages/api/src/server.ts',
  ]), true, 'runtime source must dominate test-only exclusions across files');
});
test('lifecycle-only changes do not request a backend production release', () => {
  for (const path of [
    '.github/workflows/push-app-lifecycle.yml',
    'deploy/ansible/deploy-transaction.yml',
    'deploy/backup/backup.sh',
    'deploy/postgres/010-create-app-role.sh',
    'deploy/quadlet/codexia-api.container',
    'docs/deployment/PUSH-DEPLOYMENT.md',
    'docs/deployment/IAC.md',
    'scripts/push-app-lifecycle.mjs',
    'scripts/oci-better-auth-fixture.sh',
  ]) {
    assert.equal(componentReleaseAffected('backend', [path]), false, path);
  }
});
test('malformed release impact input cannot suppress release verification', () => {
  for (const files of [[], ['../secret'], ['bad\\\\name'], [123], null]) {
    assert.throws(() => componentReleaseAffected('frontend', files));
  }
  assert.throws(() => componentReleaseAffected('unknown', ['app/src/a.ts']));
});
