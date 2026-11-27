import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCurrentCertifiedVerify } from './recheck-verify.mjs';

const sha = 'a'.repeat(40);
const certificate = { verifiedMainSha: sha, verifyRun: { id: 23, attempt: 1 } };
const valid = { id: 23, run_number: 12, run_attempt: 1, status: 'completed', conclusion: 'success',
  path: '.github/workflows/verify.yml', head_sha: sha, head_branch: 'main', event: 'push',
  repository: { full_name: 'yohn-jp/codexia' }, head_repository: { full_name: 'yohn-jp/codexia' } };

test('backend queue gate accepts only the exact certified latest successful Verify attempt', () => {
  assert.equal(assertCurrentCertifiedVerify([valid], certificate).id, 23);
  for (const bad of [
    { ...valid, id: 24, run_number: 13, conclusion: 'failure' },
    { ...valid, id: 24, run_number: 13, status: 'in_progress', conclusion: null },
    { ...valid, id: 23, run_attempt: 2 },
    { ...valid, id: 24, run_number: 13 },
  ]) {
    assert.throws(() => assertCurrentCertifiedVerify([valid, bad], certificate));
  }
  assert.throws(() => assertCurrentCertifiedVerify([
    { ...valid, head_repository: { full_name: 'untrusted/codexia' } },
  ], certificate), /No exact-main/u);
});
