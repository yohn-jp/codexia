import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertDisposableDatabase, assertMixedVersionPair } from './verify-mixed-version.mjs';

const priorSha = 'a'.repeat(40), currentSha = 'b'.repeat(40);
const identity = { format: 'codexia-frontend-identity/v1', version: '0.1.1',
  sourceSha: priorSha, profile: 'full', apiEpoch: 1 };
const pair = { priorSha, currentSha, profile: 'full', apiEpoch: 1 };

test('mixed-version acceptance binds the distinct prior source and same profile/API epoch', () => {
  assert.doesNotThrow(() => assertMixedVersionPair(identity, pair));
  assert.throws(() => assertMixedVersionPair(identity, { ...pair, currentSha: priorSha }), /distinct sources/);
  assert.throws(() => assertMixedVersionPair({ ...identity, sourceSha: currentSha }, pair), /source mismatch/);
  assert.throws(() => assertMixedVersionPair({ ...identity, profile: 'core' }, pair), /profile mismatch/);
  assert.throws(() => assertMixedVersionPair({ ...identity, apiEpoch: 2 }, pair), /epoch mismatch/);
  assert.throws(() => assertMixedVersionPair({ ...identity, format: 'unknown' }, pair));
});

test('mixed-version acceptance only admits explicitly named disposable loopback databases', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.doesNotThrow(() => assertDisposableDatabase('postgres://user:pass@' + host + ':5432/codexia_e2e_compat_test'));
  }
  for (const url of [undefined, 'postgres://example.com/codexia_e2e_compat_test',
    'postgres://localhost/codexia', 'https://localhost/codexia_e2e_compat_test']) {
    assert.throws(() => assertDisposableDatabase(url));
  }
});
