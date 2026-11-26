import { VERIFICATION_GROUPS } from '../impact/contract.mjs';

const canonicalJobs = new Set(Object.keys(VERIFICATION_GROUPS));

/** Convert the reusable-workflow display name for a profile-owned task to the
 * stable logical job name used by evidence artifacts and historical runs.
 * Unknown or cross-profile wrappers deliberately do not normalize. */
export function normalizeVerificationJobName(name) {
  if (canonicalJobs.has(name)) return name;
  const match = /^profile-(core|full) \/ (.+)$/u.exec(name ?? '');
  if (!match) return null;
  const [, profile, child] = match;
  if (child === `build-${profile}` ||
      (child.startsWith(`browser-${profile}-`) && canonicalJobs.has(child))) return child;
  return null;
}

export function isSkippedProfileBrowserPlaceholder(name) {
  return /^profile-(core|full) \/ browser(?:-|(?:-)?\$\{\{ matrix\.group \}\})?$/u.test(name ?? '');
}

/** Normalize job API records without mutating the API response. Keep the
 * original display name for diagnostics and dashboard rendering. */
export function normalizeVerificationJobs(jobs) {
  if (!Array.isArray(jobs)) throw new Error('Invalid verification job inventory');
  return jobs.map(job => {
    const name = normalizeVerificationJobName(job?.name);
    if (name !== null && name !== job.name) return { ...job, name, originalName: job.name };
    if (isSkippedProfileBrowserPlaceholder(job?.name) && job.conclusion === 'skipped') return job;
    if (/^profile-(?:core|full) \/ /u.test(job?.name ?? '')) {
      throw new Error('Unrecognized or cross-profile verification job name: ' + job.name);
    }
    return job;
  });
}
