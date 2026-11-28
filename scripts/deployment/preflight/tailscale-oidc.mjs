import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { actionsRepository } from '../../github/repository.mjs';

const main = 'refs/heads/main';
const issuer = 'https://token.actions.githubusercontent.com';
const clientId = /^[A-Za-z0-9._-]{1,128}$/u;

export function assertTailscaleOIDCClaims(claims, env = process.env) {
  const { repository, owner, repo, repositoryId, ownerId } = actionsRepository(env);
  const environment = env.CODEXIA_TAILSCALE_ENVIRONMENT;
  const workflowRef = env.GITHUB_WORKFLOW_REF;
  assert.ok(['codexia-bootstrap', 'codexia-production'].includes(environment) &&
    env.GITHUB_REF === main && workflowRef?.startsWith(repository + '/.github/workflows/') &&
    workflowRef.endsWith('@' + main) && clientId.test(env.CODEXIA_TAILSCALE_CLIENT_ID ?? ''),
  'Invalid Tailscale management job identity');
  const expected = {
    iss: issuer,
    aud: 'api.tailscale.com/' + env.CODEXIA_TAILSCALE_CLIENT_ID,
    sub: `repo:${owner}@${ownerId}/${repo}@${repositoryId}:environment:${environment}`,
    repository,
    repository_id: String(repositoryId),
    repository_owner_id: String(ownerId),
    ref: main,
    workflow_ref: workflowRef,
    environment,
  };
  assert.ok(Object.entries(expected).every(([name, value]) => claims?.[name] === value),
    'Tailscale OIDC claims do not match the immutable repository, main, workflow and Environment');
}

async function checkIssuerClaims(env) {
  const endpoint = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  assert.ok(endpoint.protocol === 'https:' && endpoint.port === '' &&
    endpoint.hostname.endsWith('.actions.githubusercontent.com') &&
    !endpoint.username && !endpoint.password && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN &&
    clientId.test(env.CODEXIA_TAILSCALE_CLIENT_ID ?? ''), 'Missing trusted GitHub Actions OIDC endpoint or audience');
  endpoint.searchParams.set('audience', 'api.tailscale.com/' + env.CODEXIA_TAILSCALE_CLIENT_ID);
  // Read claims directly from GitHub's authenticated token endpoint. Tailscale
  // independently verifies the signature and its configured federation policy.
  const response = await fetch(endpoint, {
    headers: { Authorization: 'Bearer ' + env.ACTIONS_ID_TOKEN_REQUEST_TOKEN },
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  assert.ok(response.ok, 'GitHub Actions could not issue a Tailscale identity token');
  const { value } = await response.json();
  const token = typeof value === 'string' ? value.split('.') : [];
  assert.ok(token.length === 3 && token[1], 'Invalid GitHub Actions OIDC token response');
  assertTailscaleOIDCClaims(JSON.parse(Buffer.from(token[1], 'base64url')), env);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await checkIssuerClaims(process.env);
  } catch {
    console.error('Tailscale authentication stopped. Check the selected repository’s immutable GitHub OIDC subject, protected Environment, workflow, main and WIF Client ID.');
    process.exitCode = 1;
  }
}
