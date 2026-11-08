#!/usr/bin/env node
// Read-only gates for tag and commit-addressed publication.
import { execFileSync } from 'node:child_process';
import { assertReleaseIdentity, assertVerificationJobs, collectGitHubPages, verifiedSourceRun } from './release-policy.mjs';

const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME;
const commitRelease = process.env.CODEXIA_COMMIT_RELEASE === '1';
const expectedSha = process.env.GITHUB_SHA;
const token = process.env.GH_TOKEN;
if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !tag || !expectedSha || !token) throw new Error('Release verification requires repository, tag, source and read token');
const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (commitRelease) {
  if (!/^[a-f0-9]{40}$/.test(expectedSha) || checkoutSha !== expectedSha || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Commit publication requires exact main source');
} else assertReleaseIdentity(tag, expectedSha, checkoutSha);
const request = async path => {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Release verification read failed (HTTP ${response.status})`);
  return response.json();
};
if (!commitRelease) {
  let reference = (await request(`git/ref/tags/${encodeURIComponent(tag)}`)).object;
  for (let depth = 0; reference?.type === 'tag' && depth < 8; depth++) {
    if (!/^[a-f0-9]{40}$/.test(reference.sha ?? '')) throw new Error('Invalid annotated tag object');
    reference = (await request(`git/tags/${reference.sha}`)).object;
  }
  if (reference?.type !== 'commit') throw new Error('Release tag does not resolve to a commit');
  assertReleaseIdentity(tag, expectedSha, reference.sha);
}
const deadline = Date.now() + (commitRelease ? 60 * 60 * 1000 : 0);
let runs;
for (;;) {
  runs = await collectGitHubPages(
    (page, perPage) => request(`actions/workflows/verify.yml/runs?head_sha=${encodeURIComponent(expectedSha)}&branch=main&event=push&status=success&per_page=${perPage}&page=${page}`),
    'workflow_runs',
  );
  if (!commitRelease || runs.some(run => run.head_sha === expectedSha && run.status === 'completed' && run.conclusion === 'success')) break;
  if (Date.now() >= deadline) throw new Error('Timed out waiting for successful exact-source main verification');
  await new Promise(resolve => setTimeout(resolve, 30_000));
}
const verified = verifiedSourceRun(runs, expectedSha);
const jobs = await collectGitHubPages(
  (page, perPage) => request(`actions/runs/${verified.id}/jobs?filter=latest&per_page=${perPage}&page=${page}`),
  'jobs',
);
assertVerificationJobs(jobs);
console.log(`Verified release ${tag} source ${expectedSha} with run ${verified.id}. No publication performed by this gate.`);
