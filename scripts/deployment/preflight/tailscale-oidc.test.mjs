import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertTailscaleOIDCClaims } from './tailscale-oidc.mjs';

for (const [owner, ownerId, repositoryId] of [['yohn-jp', '100', '200'], ['isolated-org', '101', '201']]) {
  test(`Tailscale OIDC requires immutable deployment identity for ${owner}`, () => {
    const repo = owner + '/codexia';
    const workflowRef = repo + '/.github/workflows/production-bootstrap.yml@refs/heads/main';
    const env = { GITHUB_REPOSITORY: repo, GITHUB_REPOSITORY_OWNER_ID: ownerId,
      GITHUB_REPOSITORY_ID: repositoryId, GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: workflowRef,
      CODEXIA_TAILSCALE_CLIENT_ID: 'fixture-client', CODEXIA_TAILSCALE_ENVIRONMENT: 'codexia-bootstrap' };
    const claims = { iss: 'https://token.actions.githubusercontent.com', aud: 'api.tailscale.com/fixture-client',
      sub: `repo:${owner}@${ownerId}/codexia@${repositoryId}:environment:codexia-bootstrap`,
      repository: repo, repository_owner_id: ownerId, repository_id: repositoryId,
      ref: 'refs/heads/main', workflow_ref: workflowRef, environment: 'codexia-bootstrap' };
    assert.doesNotThrow(() => assertTailscaleOIDCClaims(claims, env));
    for (const change of [
      { sub: `repo:${repo}:environment:codexia-bootstrap` }, { repository_id: '999' },
      { repository_owner_id: '999' }, { aud: 'api.tailscale.com/foreign-client' },
      { ref: 'refs/heads/other' }, { workflow_ref: workflowRef.replace('/production-bootstrap', '/unknown') },
      { environment: 'codexia-production' },
    ]) assert.throws(() => assertTailscaleOIDCClaims({ ...claims, ...change }, env), /OIDC claims/u);
  });
}
