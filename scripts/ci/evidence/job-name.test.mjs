import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSkippedProfileBrowserPlaceholder, normalizeVerificationJobName, normalizeVerificationJobs } from './job-name.mjs';

test('normalizes strict profile-prefixed job names and preserves historical canonical names', () => {
  for (const name of ['build-core', 'build-full', 'browser-core-writing', 'browser-full-ui-v1']) {
    assert.equal(normalizeVerificationJobName(name), name);
  }
  assert.equal(normalizeVerificationJobName('profile-core / build-core'), 'build-core');
  assert.equal(normalizeVerificationJobName('profile-full / browser-full-reference'), 'browser-full-reference');
});

test('rejects malformed and cross-profile wrappers instead of guessing a logical job', () => {
  for (const name of [
    'profile-core / build-full',
    'profile-full / browser-core-writing',
    'profile-other / build-core',
    'profile-core/build-core',
  ]) assert.equal(normalizeVerificationJobName(name), null);
});

test('normalizes copied API jobs while retaining their GitHub display names', () => {
  const source = [{ name: 'profile-core / build-core', id: 42 }];
  const normalized = normalizeVerificationJobs(source);
  assert.deepEqual(normalized, [{ name: 'build-core', originalName: 'profile-core / build-core', id: 42 }]);
  assert.equal(source[0].name, 'profile-core / build-core');
});

test('recognizes only literal empty reusable browser-matrix placeholders', () => {
  for (const name of ['profile-core / browser', 'profile-full / browser-', 'profile-core / browser-${{ matrix.group }}']) {
    assert.equal(isSkippedProfileBrowserPlaceholder(name), true);
  }
  assert.equal(isSkippedProfileBrowserPlaceholder('profile-core / browser-full-writing'), false);
});
