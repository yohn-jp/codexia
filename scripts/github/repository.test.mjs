import assert from 'node:assert/strict';
import test from 'node:test';
import { actionsRepository, assertBackendImageDigest, backendImageName, matchesRunRepository } from './repository.mjs';

test('an upstream or fork run must match its Actions repository and owner IDs', () => {
  for (const [name, id, ownerId] of [['yohn-jp/codexia', 10, 20], ['Fork-Owner/codexia', 30, 40]]) {
    const target = actionsRepository({
      GITHUB_REPOSITORY: name, GITHUB_REPOSITORY_ID: String(id), GITHUB_REPOSITORY_OWNER_ID: String(ownerId),
    });
    const repository = { full_name: name, id, owner: { id: ownerId } };
    const run = { repository, head_repository: repository };
    assert.ok(matchesRunRepository(run, target));
    assert.equal(matchesRunRepository({ ...run, head_repository: { ...repository, id: id + 1 } }, target), false);
    assert.equal(matchesRunRepository({ ...run, repository: { ...repository, owner: { id: ownerId + 1 } } }, target), false);
    assert.equal(matchesRunRepository({ ...run, repository: { ...repository, full_name: 'previous-owner/codexia' } }, target), false);
  }
});

test('only the validated target owner namespace can supply a Backend digest', () => {
  const image = 'ghcr.io/fork-owner/codexia-backend@sha256:' + 'a'.repeat(64);
  assert.equal(backendImageName('Fork-Owner/codexia'), 'ghcr.io/fork-owner/codexia-backend');
  assert.doesNotThrow(() => assertBackendImageDigest(image, 'Fork-Owner/codexia'));
  assert.throws(() => assertBackendImageDigest(image, 'yohn-jp/codexia'));
  assert.throws(() => backendImageName('fork-owner/not-codexia'));
});
