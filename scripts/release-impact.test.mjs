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
