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
test('malformed release impact input cannot suppress release verification', () => {
  for (const files of [[], ['../secret'], ['bad\\\\name'], [123], null]) {
    assert.throws(() => componentReleaseAffected('frontend', files));
  }
  assert.throws(() => componentReleaseAffected('unknown', ['app/src/a.ts']));
});
