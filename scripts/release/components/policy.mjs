import { REQUIRED_VERIFICATION_JOBS, VERIFICATION_LEAF_JOBS } from '../../ci/impact/contract.mjs';
import { normalizeVerificationJobs } from '../../ci/evidence/job-name.mjs';

// Historical publication certificates may contain the retired supplemental lane.
// Validate its original conclusion; this reader cannot select or execute it.
const DEPLOYMENT_FIXTURE_CALLER = 'deployment-cutover';
const DEPLOYMENT_FIXTURE_JOB = DEPLOYMENT_FIXTURE_CALLER + ' / Verify selected deployment fixtures';

/** @typedef {{id: number, head_sha: string, head_branch: string, event: string, status: string, conclusion: string | null}} VerificationRun */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @returns {value is VerificationRun} */
function runRecord(value) {
  return record(value) && typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id > 0 &&
    typeof value.head_sha === 'string' && typeof value.head_branch === 'string' && typeof value.event === 'string' &&
    typeof value.status === 'string' && (typeof value.conclusion === 'string' || value.conclusion === null);
}
/** @param {unknown} runs @param {string} sha @returns {VerificationRun} */
export function verifiedSourceRun(runs, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !Array.isArray(runs)) throw new Error('Invalid release source or verification response');
  for (const run of runs) {
    if (runRecord(run) && run.head_sha === sha && run.head_branch === 'main' && run.event === 'push' &&
        run.status === 'completed' && run.conclusion === 'success') return run;
  }
  throw new Error('Release source has no successful main verification');
}
/**
 * Wait only for an absent or genuinely unfinished exact-source main run.
 * A terminal failure/cancellation requires a new verification/release attempt.
 * @param {unknown} runs
 * @param {string} sha
 * @returns {'ready'|'waiting'|'failed'}
 */
export function releaseVerificationState(runs, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !Array.isArray(runs)) throw new Error('Invalid release source or verification response');
  const exact = runs.filter(runRecord).filter(run => run.head_sha === sha && run.head_branch === 'main' && run.event === 'push');
  if (exact.some(run => run.status === 'completed' && run.conclusion === 'success')) return 'ready';
  if (exact.length > 0 && exact.every(run => run.status === 'completed')) return 'failed';
  return 'waiting';
}
/** @param {unknown} jobs @param {readonly string[]} expectedNames @param {readonly string[]} optionalSkippedNames */
function assertNamedJobs(jobs, expectedNames, optionalSkippedNames = []) {
  if (!Array.isArray(jobs)) throw new Error('Invalid release verification jobs response');
  const normalizedJobs = normalizeVerificationJobs(jobs);
  const required = new Set(expectedNames);
  if (required.size !== expectedNames.length) throw new Error('Canonical release verification job set contains duplicates');
  const optionalSkipped = new Set(optionalSkippedNames);
  if (optionalSkipped.size !== optionalSkippedNames.length || [...optionalSkipped].some(name => required.has(name))) {
    throw new Error('Canonical optional release verification job set is invalid');
  }
  const seen = new Set();
  for (const job of normalizedJobs) {
    if (!record(job) || typeof job.name !== 'string' || job.name.length === 0) {
      throw new Error('Invalid release verification job');
    }
    if (seen.has(job.name)) throw new Error(`Duplicate release verification job: ${job.name}`);
    seen.add(job.name);
    if (optionalSkipped.has(job.name)) {
      if (job.status !== 'completed' || job.conclusion !== 'skipped') {
        throw new Error(`Optional release verification job must be skipped: ${job.name}`);
      }
      continue;
    }
    if (!required.has(job.name)) throw new Error(`Unexpected release verification job: ${job.name}`);
    if (job.status !== 'completed' || job.conclusion !== 'success') {
      throw new Error(`Release verification job did not succeed: ${job.name}`);
    }
  }
  if ([...required].some(name => !seen.has(name))) {
    throw new Error('Release verification does not contain the exact required job set');
  }
}

/** @param {unknown} jobs */
export function assertVerificationLeafJobs(jobs) {
  assertNamedJobs(jobs, VERIFICATION_LEAF_JOBS);
}

// GitHub emits these literal matrix-name placeholders when entire families are skipped.
// The compact path requires positive certification-step evidence, never skipped status alone.
export const REUSED_MAIN_SKIPPED_JOBS = Object.freeze([
  'full-model-oci', 'biome', 'unit-${{ matrix.group }}', 'types-${{ matrix.group }}',
  'profile-core', 'profile-full', 'oci-${{ matrix.profile }}',
]);
export const LEGACY_REUSED_MAIN_SKIPPED_JOBS = Object.freeze([
  'full-model-oci', 'biome', 'unit-${{ matrix.group }}', 'types-${{ matrix.group }}',
  'build-${{ matrix.profile }}', 'oci-${{ matrix.profile }}', 'browser-${{ matrix.group }}',
]);
export const ALLOWED_SKIPPED_VERIFICATION_JOBS = Object.freeze([
  ...REUSED_MAIN_SKIPPED_JOBS, ...LEGACY_REUSED_MAIN_SKIPPED_JOBS,
]);
export const REUSED_MAIN_CERT_STEP = 'Certify reused merged PR proof';

/** @param {unknown} jobs */
export function assertVerificationJobs(jobs) {
  if (!Array.isArray(jobs)) throw new Error('Invalid release verification jobs response');
  const cert = jobs.find(job => record(job) && job.name === 'certification');
  /** @type {Record<string, unknown>[]} */
  const steps = record(cert) && Array.isArray(cert.steps) ? cert.steps.filter(record) : [];
  const reuseSteps = steps.filter(step => step.name === REUSED_MAIN_CERT_STEP);
  if (reuseSteps.length > 0 && reuseSteps.some(step => step.conclusion === 'success')) {
    if (reuseSteps.length !== 1 || reuseSteps[0]?.status !== 'completed') throw new Error('Ambiguous reused main certification');
    const normal = steps.filter(step => step.name === 'Certify every required exact-source matrix element');
    if (normal.length !== 1 || normal[0]?.status !== 'completed' || normal[0]?.conclusion !== 'skipped') throw new Error('Conflicting main certification modes');
    const hasProfileCallers = jobs.some(job => record(job) &&
      (job.name === 'profile-core' || job.name === 'profile-full'));
    const placeholders = hasProfileCallers ? REUSED_MAIN_SKIPPED_JOBS : LEGACY_REUSED_MAIN_SKIPPED_JOBS;
    assertNamedJobs(jobs, ['plan', 'certification'], [...placeholders, DEPLOYMENT_FIXTURE_CALLER]);
    if (jobs.filter(job => !record(job) || job.name !== DEPLOYMENT_FIXTURE_CALLER).length !== 2 + placeholders.length) {
      throw new Error('Incomplete compact main verification inventory');
    }
    return;
  }
  // Main Verify skips the PR-only call; the standalone workflow owns matching main pushes.
  const fixtureRan = jobs.some(job => record(job) && job.name === DEPLOYMENT_FIXTURE_JOB);
  const required = fixtureRan ? [...REQUIRED_VERIFICATION_JOBS, DEPLOYMENT_FIXTURE_JOB] : REQUIRED_VERIFICATION_JOBS;
  const skipped = fixtureRan ? ['full-model-oci'] : ['full-model-oci', DEPLOYMENT_FIXTURE_CALLER];
  assertNamedJobs(jobs, required, skipped);
}

/** @param {string} tag @param {string} expectedSha @param {string} actualSha */
export function assertReleaseIdentity(tag, expectedSha, actualSha) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag) || !/^[a-f0-9]{40}$/.test(expectedSha) || actualSha !== expectedSha) {
    throw new Error('Release tag does not bind the verified immutable source');
  }
}

/**
 * Resolve lightweight and annotated release tags through the existing GitHub source authority.
 * @param {{rest: {git: {
 *   getRef(input: {owner: string, repo: string, ref: string}): Promise<{data: {object: {type: string, sha: string}}}>,
 *   getTag(input: {owner: string, repo: string, tag_sha: string}): Promise<{data: {object: {type: string, sha: string}}}>
 * }}}} github
 * @param {{owner: string, repo: string, tag: string, sha: string}} release
 */
export async function assertRemoteReleaseTag(github, { owner, repo, tag, sha }) {
  let reference = (await github.rest.git.getRef({ owner, repo, ref: `tags/${tag}` })).data.object;
  for (let depth = 0; reference?.type === 'tag' && depth < 8; depth++) {
    if (!/^[a-f0-9]{40}$/.test(reference.sha ?? '')) throw new Error('Invalid annotated tag object');
    reference = (await github.rest.git.getTag({ owner, repo, tag_sha: reference.sha })).data.object;
  }
  if (reference?.type !== 'commit') throw new Error('Release tag does not resolve to a commit');
  assertReleaseIdentity(tag, sha, reference.sha);
}

/** @param {Response} response */
export async function assertImageTagAbsent(response) {
  if (response.status === 200) throw new Error('Existing OCI version tag is immutable; use a new version');
  if (response.status !== 404) throw new Error(`Cannot establish OCI tag absence (HTTP ${response.status})`);
  /** @type {unknown} */
  const body = await response.json();
  if (!record(body) || !Array.isArray(body.errors) || body.errors.length === 0 ||
      !body.errors.every(error => record(error) && (error.code === 'MANIFEST_UNKNOWN' || error.code === 'NAME_UNKNOWN'))) {
    throw new Error('Registry did not confirm an absent OCI version tag');
  }
}
