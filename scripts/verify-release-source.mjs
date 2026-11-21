#!/usr/bin/env node
// Read-only gates for tag and commit-addressed publication.
import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { assertReleaseIdentity, assertVerificationJobs, collectGitHubPages, verifiedSourceRun } from './release-policy.mjs';

const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME;
const commitRelease = process.env.CODEXIA_COMMIT_RELEASE === '1';
const expectedSha = process.env.CODEXIA_SOURCE_SHA || process.env.GITHUB_SHA;
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
// The caller starts only after verification completed. One bounded read; no
// 30-second polling loop and no idle runner while tests are still running.
const exactId = process.env.CODEXIA_VERIFY_RUN_ID;
let runs;
if (commitRelease && exactId) {
  const id = Number(exactId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid completed Verify run ID');
  const run = await request(`actions/runs/${id}`);
  if (run.id !== id || run.path !== '.github/workflows/verify.yml' ||
      run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) {
    throw new Error('Release completion event does not identify the canonical Verify run');
  }
  runs = [run];
} else {
  runs = await collectGitHubPages(
    (page, perPage) => request(`actions/workflows/verify.yml/runs?head_sha=${encodeURIComponent(expectedSha)}&branch=main&event=push&per_page=${perPage}&page=${page}`),
    'workflow_runs',
  );
}
const verified = verifiedSourceRun(runs, expectedSha);
const jobs = await collectGitHubPages(
  (page, perPage) => request(`actions/runs/${verified.id}/jobs?filter=latest&per_page=${perPage}&page=${page}`),
  'jobs',
);
assertVerificationJobs(jobs);
console.log(`Verified release ${tag} source ${expectedSha} with run ${verified.id}. No publication performed by this gate.`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run-id=${verified.id}\n`);
