import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertDisposableDatabase, assertIsolatedEnvironment, assertMixedVersionPair } from './verify-mixed-version.mjs';

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
    'postgres://localhost/codexia', 'https://localhost/codexia_e2e_compat_test',
    'postgres://127.0.0.1/codexia_e2e_compat_test?host=remote.example.com',
    'postgres://127.0.0.1/codexia_e2e_compat_test?%68ost=remote.example.com',
    'postgres://127.0.0.1/codexia_e2e_compat_test?port=6432',
    'postgres://localhost/codexia_e2e_compat_test#fragment']) {
    assert.throws(() => assertDisposableDatabase(url));
  }
});

test('mixed-version verification rejects external composition and release identity overrides', () => {
  assert.doesNotThrow(() => assertIsolatedEnvironment({}));
  for (const name of ['CODEXIA_BROWSER_MODULE_PROFILE_PATH', 'SCRIPTORIUM_BROWSER_MODULE_PROFILE_PATH',
    'CODEXIA_STANDALONE_IDENTITY', 'CODEXIA_E2E_BASE_URL',
    'CODEXIA_E2E_COMPAT_FRONTEND_DIR', 'CODEXIA_E2E_COMPAT_FRONTEND_SOURCE']) {
    assert.throws(() => assertIsolatedEnvironment({ [name]: 'override' }), new RegExp(name));
  }
});
