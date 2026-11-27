import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evidenceCheckoutInputs } from './evidence-checkout.mjs';

test('evidence checkout retains the complete test and workspace manifest inventory', () => {
  const files = [
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'packages/api/package.json', 'packages/api/src/server.ts', 'packages/api/test/server.test.mjs',
    'packages/persistence-postgres/package.json', 'packages/persistence-postgres/src/migration-set.ts',
    'packages/persistence-postgres/migrations/001.sql',
    'modules/story/package.json', 'modules/story/src/deep/example.spec.tsx',
    'app/package.json', 'app/src/index.tsx', 'app/src/application/navigation.test.ts',
    'profiles/core/package.json', 'profiles/core.json',
    'scripts/ci/impact/plan.mjs', 'scripts/ci/evidence/package.json',
    'deploy/quadlet/codexia-api.container', '.github/workflows/verify.yml',
    '.github/workflows/verify-profile.yml',
    'ios/Sources/App.swift', 'docs/overview.md', '.agents/example.md',
  ];
  const selected = evidenceCheckoutInputs(files);
  assert.ok(selected);
  assert.deepEqual(selected.required, files.filter(file =>
    !['packages/api/src/server.ts', 'app/src/index.tsx', 'ios/Sources/App.swift', 'docs/overview.md', '.agents/example.md'].includes(file)).sort());
});
test('unknown workspace directories and unsafe sparse literals require full checkout', () => {
  assert.equal(evidenceCheckoutInputs(['packages/new/src/index.ts']), null);
  assert.equal(evidenceCheckoutInputs(['modules/story/package.json', 'modules/story/src/file [1].test.ts']), null);
});
