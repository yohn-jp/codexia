import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REQUIRED_VERIFICATION_JOBS } from '../../ci/impact/contract.mjs';
import { assertReleaseIdentity, assertVerificationJobs, assertVerificationLeafJobs, releaseVerificationState, verifiedSourceRun } from './policy.mjs';

const sha = 'a'.repeat(40);
const run = { id: 1, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' };
test('release eligibility requires the exact successful main push source', () => {
  assert.equal(verifiedSourceRun([run], sha), run);
  for (const change of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'other' }, { event: 'pull_request' }, { conclusion: 'failure' }, { status: 'in_progress' }, { conclusion: 'cancelled' }]) {
    assert.throws(() => verifiedSourceRun([{ ...run, ...change }], sha));
  }
  assert.throws(() => verifiedSourceRun([], sha));
  assert.throws(() => verifiedSourceRun({}, sha));
});
test('release eligibility rejects moved tags and malformed version names', () => {
  assert.doesNotThrow(() => assertReleaseIdentity('v0.3.3', sha, sha));
  assert.throws(() => assertReleaseIdentity('v0.3.3', sha, 'b'.repeat(40)));
  assert.throws(() => assertReleaseIdentity('main', sha, sha));
});

test('release gate requires the exact successful job set including every matrix element and certification', () => {
  const jobs = REQUIRED_VERIFICATION_JOBS.map(name => ({ name, status: 'completed', conclusion: 'success' }));
  assert.doesNotThrow(() => assertVerificationJobs(jobs));
  assert.doesNotThrow(() => assertVerificationLeafJobs(jobs.filter(job => job.name !== 'certification')));
  assert.throws(() => assertVerificationLeafJobs(jobs), /Unexpected release verification job/);
  for (const required of ['plan', 'browser-core-ui-v1', 'browser-full-ui-v1', 'certification']) {
    assert.ok(jobs.some(job => job.name === required), required + ' is a release obligation');
    assert.throws(() => assertVerificationJobs(jobs.filter(job => job.name !== required)), /exact required job set/);
  }
  for (const conclusion of ['failure', 'cancelled', 'skipped']) {
    const rejected = jobs.map((job, index) => index === 1 ? { ...job, conclusion } : job);
    assert.throws(() => assertVerificationJobs(rejected), /did not succeed/);
  }
  assert.throws(() => assertVerificationJobs(jobs.map((job, index) => index === 1 ? { ...job, status: 'in_progress', conclusion: null } : job)), /did not succeed/);
  assert.throws(() => assertVerificationJobs(jobs.map((job, index) => index === 1 ? { ...job, conclusion: null } : job)), /did not succeed/);
  assert.throws(() => assertVerificationJobs([...jobs, { name: 'unit-future', status: 'completed', conclusion: 'success' }]), /Unexpected release verification job/);
  assert.throws(() => assertVerificationJobs([...jobs, { ...jobs[0] }]), /Duplicate release verification job/);
  assert.throws(() => assertVerificationJobs([...jobs, { name: 'unexpected', status: 'completed', conclusion: 'cancelled' }]), /Unexpected release verification job/);
});

test('release gate normalizes reusable profile jobs but rejects cross-profile aliases', () => {
  const jobs = REQUIRED_VERIFICATION_JOBS.map(name => {
    if (name === 'build-core' || name.startsWith('browser-core-')) return { name: 'profile-core / ' + name, status: 'completed', conclusion: 'success' };
    if (name === 'build-full' || name.startsWith('browser-full-')) return { name: 'profile-full / ' + name, status: 'completed', conclusion: 'success' };
    return { name, status: 'completed', conclusion: 'success' };
  });
  assert.doesNotThrow(() => assertVerificationJobs(jobs));
  assert.throws(() => assertVerificationJobs([...jobs,
    { name: 'profile-core / build-full', status: 'completed', conclusion: 'success' },
  ]), /cross-profile/u);
  assert.throws(() => assertVerificationJobs([...jobs,
    { name: 'profile-core / browser', status: 'completed', conclusion: 'success' },
  ]), /cross-profile/u);
});

test('main release verification permits only a skipped supplemental Full-model OCI caller job', () => {
  const jobs = REQUIRED_VERIFICATION_JOBS.map(name => ({ name, status: 'completed', conclusion: 'success' }));
  assert.doesNotThrow(() => assertVerificationJobs([...jobs, { name: 'full-model-oci', status: 'completed', conclusion: 'skipped' }]));
  for (const supplemental of [
    { name: 'full-model-oci', status: 'completed', conclusion: 'success' },
    { name: 'full-model-oci', status: 'completed', conclusion: 'failure' },
    { name: 'full-model-oci', status: 'in_progress', conclusion: null },
    { name: 'full-model-oci', status: 'completed', conclusion: 'cancelled' },
  ]) assert.throws(() => assertVerificationJobs([...jobs, supplemental]), /must be skipped/);
  assert.throws(() => assertVerificationJobs([...jobs,
    { name: 'full-model-oci', status: 'completed', conclusion: 'skipped' },
    { name: 'full-model-oci', status: 'completed', conclusion: 'skipped' },
  ]), /Duplicate release verification job/);
  assert.throws(() => assertVerificationLeafJobs([...jobs.filter(job => job.name !== 'certification'), { name: 'full-model-oci', status: 'completed', conclusion: 'skipped' }]), /Unexpected release verification job/);
});

test('OCI publication refuses existing image tags and fails closed on registry uncertainty', async () => {
  const { assertImageTagAbsent } = await import('./policy.mjs');
  for (const code of ['MANIFEST_UNKNOWN', 'NAME_UNKNOWN']) {
    await assert.doesNotReject(assertImageTagAbsent(Response.json({ errors: [{ code, message: 'absent' }] }, { status: 404 })));
  }
  for (const response of [
    Response.json({ schemaVersion: 2 }),
    Response.json({ errors: [{ code: 'UNAUTHORIZED' }] }, { status: 401 }),
    Response.json({ errors: [{ code: 'DENIED' }] }, { status: 403 }),
    Response.json({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }, { status: 503 }),
    Response.json({ errors: [{ code: 'OTHER' }] }, { status: 404 }),
    Response.json({ errors: [] }, { status: 404 }),
    new Response('not registry JSON', { status: 404 }),
  ]) await assert.rejects(assertImageTagAbsent(response));
});

test('main release polling stops on terminal exact-source failure without accepting it', () => {
  const failed = {...run, conclusion:'failure'};
  const cancelled = {...run, conclusion:'cancelled'};
  const active = {...run, id:2, status:'in_progress', conclusion:null};
  assert.equal(releaseVerificationState([], sha), 'waiting');
  assert.equal(releaseVerificationState([failed], sha), 'failed');
  assert.equal(releaseVerificationState([cancelled], sha), 'failed');
  assert.equal(releaseVerificationState([failed, active], sha), 'waiting');
  assert.equal(releaseVerificationState([failed, run], sha), 'ready');
  assert.equal(releaseVerificationState([{...failed, head_sha:'b'.repeat(40)}, {...failed,event:'pull_request'}], sha), 'waiting');
  assert.throws(() => verifiedSourceRun([failed,cancelled],sha));
});



test('compact main release requires positive reuse certification and the exact skipped family inventory', async () => {
  const { REUSED_MAIN_SKIPPED_JOBS, REUSED_MAIN_CERT_STEP } = await import('./policy.mjs');
  const jobs = [
    { name: 'plan', status: 'completed', conclusion: 'success' },
    ...REUSED_MAIN_SKIPPED_JOBS.map(name => ({ name, status: 'completed', conclusion: 'skipped' })),
    { name: 'certification', status: 'completed', conclusion: 'success', steps: [
      { name: REUSED_MAIN_CERT_STEP, status: 'completed', conclusion: 'success' },
      { name: 'Certify every required exact-source matrix element', status: 'completed', conclusion: 'skipped' },
    ] },
  ];
  assert.doesNotThrow(() => assertVerificationJobs(jobs));
  assert.throws(() => assertVerificationJobs(jobs.slice(1)));
  assert.throws(() => assertVerificationJobs(jobs.filter(job => job.name !== 'full-model-oci')));
  assert.throws(() => assertVerificationJobs(jobs.map(job => job.name === 'plan' ? { ...job, conclusion: 'skipped' } : job)));
  assert.throws(() => assertVerificationJobs(jobs.map(job => job.name === 'certification' ? { ...job, steps: [] } : job)));
  assert.throws(() => assertVerificationJobs(jobs.map(job => job.name === 'certification' ? { ...job, steps: job.steps.map(step => ({ ...step, conclusion: 'success' })) } : job)));
  assert.throws(() => assertVerificationJobs([...jobs, { name: 'unknown', status: 'completed', conclusion: 'skipped' }]));
  assert.throws(() => assertVerificationJobs(jobs.map(job => job.name === 'certification' ? { ...job, conclusion: 'failure' } : job)));
});

test('compact release reader retains the historical matrix-placeholder inventory', async () => {
  const { LEGACY_REUSED_MAIN_SKIPPED_JOBS, REUSED_MAIN_CERT_STEP } = await import('./policy.mjs');
  const jobs = [
    { name: 'plan', status: 'completed', conclusion: 'success' },
    ...LEGACY_REUSED_MAIN_SKIPPED_JOBS.map(name => ({ name, status: 'completed', conclusion: 'skipped' })),
    { name: 'certification', status: 'completed', conclusion: 'success', steps: [
      { name: REUSED_MAIN_CERT_STEP, status: 'completed', conclusion: 'success' },
      { name: 'Certify every required exact-source matrix element', status: 'completed', conclusion: 'skipped' },
    ] },
  ];
  assert.doesNotThrow(() => assertVerificationJobs(jobs));
  const mixed = jobs.map(job => job.name === 'build-${{ matrix.profile }}'
    ? { ...job, name: 'profile-core' } : job);
  assert.throws(() => assertVerificationJobs(mixed));
});
