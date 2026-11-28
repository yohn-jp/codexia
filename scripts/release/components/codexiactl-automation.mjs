import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const repository = 'yohn-jp/codexia';
const tagPattern = /^v0\.1\.(\d+)$/u;
const shaPattern = /^[a-f0-9]{40}$/u;
const assetNames = ['codexiactl-linux-amd64', 'codexiactl-linux-amd64.sha256'];

// Shared with the embedded contract used by the official CLI. A change to any
// exact-match input must make a matching official release available.
const exactContractPaths = JSON.parse(readFileSync(new URL('../../../cmd/codexiactl/release-contract.json', import.meta.url), 'utf8'));

export function isCodexiactlReleaseInput(file) {
  return file.startsWith('cmd/codexiactl/') ||
    exactContractPaths.some(path => file === path || (path.endsWith('/') && file.startsWith(path))) ||
    file === '.github/workflows/publish-codexiactl.yml' ||
    file === '.github/workflows/codexiactl-auto-release.yml';
}

export function latestCodexiactlTag(tags) {
  assert.ok(Array.isArray(tags));
  const versions = tags.flatMap(item => {
    const match = tagPattern.exec(item?.name ?? '');
    if (!match) return [];
    const number = Number(match[1]);
    assert.ok(Number.isSafeInteger(number) && number >= 0, 'Invalid CLI patch number');
    assert.match(item?.commit?.sha ?? '', shaPattern, 'Invalid CLI tag source');
    return [{ name: item.name, patch: number, sha: item.commit.sha }];
  });
  versions.sort((a, b) => b.patch - a.patch);
  return versions[0] ?? null;
}

export function assertPublishedCodexiactlRelease(release, tag) {
  assert.ok(release?.tag_name === tag && release.immutable === true && release.draft === false,
    'Existing CLI Release is not immutable or has an unexpected identity');
  for (const name of assetNames) {
    const assets = release.assets?.filter(asset => asset.name === name) ?? [];
    assert.ok(assets.length === 1 && assets[0].state === 'uploaded' &&
      /^sha256:[a-f0-9]{64}$/u.test(assets[0].digest ?? '') &&
      Number.isSafeInteger(assets[0].size) && assets[0].size > 0,
    'Published CLI Release is incomplete or unverifiable: ' + name);
  }
}

const runGit = (...args) => execFileSync('git', args, {
  cwd: process.env.GITHUB_WORKSPACE, encoding: 'utf8', timeout: 30_000,
});

async function existingRelease(github, owner, repo, tag) {
  try {
    return (await github.rest.repos.getReleaseByTag({ owner, repo, tag })).data;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function releaseVerifiedCodexiactl({ github, context, core, sha, git = runGit }) {
  assert.equal(context.repo.owner + '/' + context.repo.repo, repository);
  const event = context.payload?.workflow_run;
  assert.equal(event?.path, '.github/workflows/verify.yml');
  assert.equal(event?.event, 'push');
  assert.equal(event?.head_branch, 'main');
  assert.equal(event?.conclusion, 'success');
  assert.equal(event?.status, 'completed');
  assert.equal(event?.repository?.full_name, repository);
  assert.equal(event?.head_repository?.full_name, repository);
  assert.equal(event?.head_sha, sha);
  assert.match(sha ?? '', shaPattern);
  const { owner, repo } = context.repo;
  assert.equal(git('rev-parse', 'HEAD').trim(), sha, 'CLI release checkout differs from verified main');

  const current = (await github.rest.repos.getBranch({ owner, repo, branch: 'main' })).data.commit.sha;
  if (current !== sha) {
    core.info('Superseded main Verify: wait for the current source certificate');
    return 'superseded';
  }

  const tags = await github.paginate(github.rest.repos.listTags, {owner, repo, per_page: 100});
  const last = latestCodexiactlTag(tags);
  let resumedPrior = false;
  if (last) {
    // A tag can exist without its Release after a lost dispatch. Reconcile it
    // even when unrelated later main commits have already been certified.
    const published = await existingRelease(github, owner, repo, last.name);
    if (published) {
      assertPublishedCodexiactlRelease(published, last.name);
    } else {
      await github.rest.actions.createWorkflowDispatch({
        owner, repo, workflow_id: 'publish-codexiactl.yml', ref: last.name,
      });
      core.notice('Resumed CLI publication for existing verified tag ' + last.name);
      resumedPrior = true;
    }
    if (last.sha === sha) return resumedPrior ? 'resumed' : 'published';
    assert.equal(git('merge-base', '--is-ancestor', last.sha, sha), '',
      'CLI release tag is not an ancestor of verified main');
    // Compare the entire interval since the last CLI tag, not just the last
    // merge commit. A later unrelated merge must not suppress an earlier change.
    const diff = git('diff', '--name-only', '--no-renames', '-z', last.sha, sha, '--');
    if (!diff.split('\0').filter(Boolean).some(isCodexiactlReleaseInput)) {
      core.info('No net CodexiaCTL change since ' + last.name);
      return resumedPrior ? 'resumed' : 'unaffected';
    }
  }
  // No prior CLI tag: publish the initial verified binary regardless of the
  // last merge's file scope.
  const patch = (last?.patch ?? 0) + 1;
  assert.ok(Number.isSafeInteger(patch));
  const tag = 'v0.1.' + patch;
  const recheck = (await github.rest.repos.getBranch({owner, repo, branch: 'main'})).data.commit.sha;
  if (recheck !== sha) return 'superseded';

  try {
    await github.rest.git.createRef({owner, repo, ref: 'refs/tags/' + tag, sha});
  } catch (error) {
    // An API timeout can occur after GitHub committed the reference. Do not
    // mint a second version until the first side effect has been reconciled.
    const remote = (await github.rest.git.getRef({owner, repo, ref: 'tags/' + tag})).data;
    assert.ok(remote?.object?.type === 'commit' && remote.object.sha === sha,
      'Tag write failed or conflicts with a different source');
    core.info('Reconciled tag ' + tag + ' after uncertain API response');
  }
  await github.rest.actions.createWorkflowDispatch({
    owner, repo, workflow_id: 'publish-codexiactl.yml', ref: tag,
  });
  core.notice('Dispatched verified CLI Release ' + tag + ' at ' + sha);
  return 'dispatched';
}
