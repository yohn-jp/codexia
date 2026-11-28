import assert from 'node:assert/strict';

/**
 * @typedef {{ repository: string, repositoryId: number, ownerId: number }} RepositoryBinding
 * @typedef {{ full_name?: string, id?: number, owner?: { id?: number } }} GitHubRepository
 * @typedef {{ repository?: GitHubRepository, head_repository?: GitHubRepository }} GitHubRun
 */

/** @param {string | undefined} repository */
export function deploymentRepository(repository) {
  assert.ok(typeof repository === 'string', 'Missing Codexia repository identity');
  assert.match(repository, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/codexia$/u, 'Invalid Codexia repository identity');
  const [owner, repo] = repository.split('/');
  assert.ok(owner && repo);
  return { repository, owner, repo };
}

export function actionsRepository(env = process.env) {
  const target = deploymentRepository(env.GITHUB_REPOSITORY);
  const repositoryId = Number(env.GITHUB_REPOSITORY_ID);
  const ownerId = Number(env.GITHUB_REPOSITORY_OWNER_ID);
  for (const [raw, value] of [[env.GITHUB_REPOSITORY_ID, repositoryId], [env.GITHUB_REPOSITORY_OWNER_ID, ownerId]]) {
    assert.match(String(raw ?? ''), /^[1-9]\d*$/u, 'Missing Actions repository or owner ID');
    assert.ok(Number.isSafeInteger(value), 'Invalid Actions repository or owner ID');
  }
  return { ...target, repositoryId, ownerId };
}

/** @param {GitHubRepository | undefined} value @param {RepositoryBinding} context */
export function matchesRepository(value, { repository, repositoryId, ownerId }) {
  return value?.full_name === repository && value?.id === repositoryId && value?.owner?.id === ownerId;
}

/** @param {GitHubRun | undefined} run @param {RepositoryBinding} context */
export function matchesRunRepository(run, context, { sameHead = true } = {}) {
  return matchesRepository(run?.repository, context) && (!sameHead || matchesRepository(run?.head_repository, context));
}

/** @param {{ workflow_run?: { repository_id?: number, head_repository_id?: number } }} artifact @param {GitHubRun | undefined} run */
export function assertArtifactRunRepository(artifact, run) {
  assert.ok(Number.isSafeInteger(run?.repository?.id) && Number.isSafeInteger(run?.head_repository?.id),
    'Artifact producer repository identity is missing');
  assert.equal(artifact.workflow_run?.repository_id, run?.repository?.id, 'Artifact repository ID mismatch');
  assert.equal(artifact.workflow_run?.head_repository_id, run?.head_repository?.id, 'Artifact source repository ID mismatch');
}

/** @param {RepositoryBinding} context */
export function releaseRepositoryBinding({ repository, repositoryId, ownerId }) {
  deploymentRepository(repository);
  assert.ok(Number.isSafeInteger(repositoryId) && repositoryId > 0 && Number.isSafeInteger(ownerId) && ownerId > 0,
    'Release repository identity is incomplete');
  return { repository, repositoryId, ownerId };
}

/** @param {Partial<RepositoryBinding> | undefined} value @param {RepositoryBinding} context */
export function assertReleaseRepositoryBinding(value, context) {
  const { repository, repositoryId, ownerId } = releaseRepositoryBinding(context);
  assert.ok(value?.repository === repository && value?.repositoryId === repositoryId && value?.ownerId === ownerId,
    'Release proof belongs to a different repository or owner');
}

/** @param {string} repository */
export function backendImageName(repository) {
  const { owner } = deploymentRepository(repository);
  return 'ghcr.io/' + owner.toLowerCase() + '/codexia-backend';
}

/** @param {string | undefined} image @param {string} repository */
export function assertBackendImageDigest(image, repository) {
  const prefix = backendImageName(repository) + '@sha256:';
  assert.ok(typeof image === 'string' && image.startsWith(prefix) && /^[a-f0-9]{64}$/u.test(image.slice(prefix.length)),
    'Backend digest must belong to the deployment repository owner');
}
