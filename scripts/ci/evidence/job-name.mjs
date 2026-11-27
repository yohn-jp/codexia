import { VERIFICATION_GROUPS } from '../impact/contract.mjs';

const canonicalJobs = new Set(Object.keys(VERIFICATION_GROUPS));

/** Convert the reusable-workflow display name for a profile-owned task to the
 * stable logical job name used by evidence artifacts and historical runs.
 * Unknown or cross-profile wrappers deliberately do not normalize.
 * @param {unknown} name */
export function normalizeVerificationJobName(name) {
  if (typeof name !== 'string') return null;
  if (canonicalJobs.has(name)) return name;
  const match = /^profile-(core|full) \/ (.+)$/u.exec(name);
  if (!match) return null;
  const [, profile, child] = match;
  if (child && (child === `build-${profile}` ||
      (child.startsWith(`browser-${profile}-`) && canonicalJobs.has(child)))) return child;
  return null;
}

/** @param {unknown} name */
export function isSkippedProfileBrowserPlaceholder(name) {
  return typeof name === 'string' &&
    /^profile-(core|full) \/ browser-?(?:\$\{\{ matrix\.group \}\})?$/u.test(name);
}

/** Normalize job API records without mutating the API response. Keep the
 * original display name for diagnostics and dashboard rendering.
 * @template T
 * @param {T[]} jobs
 * @returns {T[]} */
export function normalizeVerificationJobs(jobs) {
  if (!Array.isArray(jobs)) throw new Error('Invalid verification job inventory');
  return jobs.map(job => {
    const record = /** @type {{ name?: unknown, conclusion?: unknown } | null} */ (job);
    const originalName = record?.name;
    if (typeof originalName !== 'string') return job;
    const name = normalizeVerificationJobName(originalName);
    if (name !== null && name !== originalName) return { ...job, name, originalName };
    if (isSkippedProfileBrowserPlaceholder(originalName) && record?.conclusion === 'skipped') return job;
    if (/^profile-(?:core|full) \/ /u.test(originalName)) {
      throw new Error('Unrecognized or cross-profile verification job name: ' + originalName);
    }
    return job;
  });
}
