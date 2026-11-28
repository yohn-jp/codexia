import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSingleDeployment, frontendPublicationContext, reconcileFrontendDeployment, selectRollback } from './deployment-rollback.mjs';

const previous = { deploymentId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  versionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };
const candidate = { deploymentId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  versionId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' };
const expectedTag = 'frontend-' + 'e'.repeat(64);
const cloudflareTarget = {
  accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), tunnelId: previous.deploymentId,
  authorPolicyId: previous.versionId, ciPolicyId: candidate.versionId, sshPolicyId: previous.deploymentId,
  tunnelTeamName: 'example', publicProtocolEnabled: false,
};

function publicationEnvironment(owner, ownerId, repositoryId, hostname) {
  const sshHostname = `ssh-${hostname}`;
  return {
    GITHUB_REPOSITORY: owner + '/codexia',
    GITHUB_REPOSITORY_OWNER_ID: ownerId,
    GITHUB_REPOSITORY_ID: repositoryId,
    GITHUB_RUN_ID: '1234',
    GITHUB_RUN_ATTEMPT: '1',
    CODEXIA_SOURCE_SHA: 'a'.repeat(40),
    CODEXIA_PUBLIC_ORIGIN: 'https://' + hostname,
    CODEXIA_MANAGEMENT_HOSTNAME: sshHostname,
    CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET: JSON.stringify({
      ...cloudflareTarget, repository: owner + '/codexia', repositoryId: Number(repositoryId),
      ownerId: Number(ownerId), origin: 'https://' + hostname, sshHostname,
    }),
    CLOUDFLARE_ACCOUNT_ID: cloudflareTarget.accountId,
    CLOUDFLARE_API_TOKEN: 'fixture',
    CODEXIA_FRONTEND_ARTIFACT_DIGEST: expectedTag.slice('frontend-'.length),
  };
}

test('frontend publication refuses a Worker credential for a different protected account', () => {
  for (const [owner, ownerId, repositoryId, hostname] of [
    ['yohn-jp', '100', '1000', 'codexia.yohn.jp'],
    ['example-org', '101', '1001', 'codexia.example.org'],
  ]) {
    const environment = publicationEnvironment(owner, ownerId, repositoryId, hostname);
    assert.equal(frontendPublicationContext(environment).accountId, cloudflareTarget.accountId);
    assert.throws(() => frontendPublicationContext({
      ...environment, CLOUDFLARE_ACCOUNT_ID: 'e'.repeat(32),
    }), /protected Cloudflare account/u);
    assert.throws(() => frontendPublicationContext({
      ...environment, GITHUB_REPOSITORY_ID: '12345',
    }), /different repository or owner/u);
    assert.throws(() => frontendPublicationContext({
      ...environment, CODEXIA_PUBLIC_ORIGIN: 'https://foreign.example.org',
    }), /origin differs/u);
  }
});

test('frontend recovery refuses a rollback record from another repository or attempt before contacting Cloudflare', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codexia-frontend-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = publicationEnvironment('example-org', '101', '1001', 'codexia.example.org');
  const state = join(directory, 'rollback.json');
  env.CODEXIA_FRONTEND_ROLLBACK_STATE = state;
  await writeFile(state, JSON.stringify({
    format: 'codexia-frontend-rollback/v2', before: previous, expectedTag,
    context: frontendPublicationContext(env),
  }));
  for (const change of [
    publicationEnvironment('another-org', '102', '2000', 'codexia.example.org'),
    { GITHUB_RUN_ATTEMPT: '2' },
  ]) {
    await assert.rejects(reconcileFrontendDeployment('restore', { ...env, ...change },
      () => assert.fail('a mismatched rollback record must cause zero Cloudflare requests')),
    /different deployment target/u);
  }
});

test('frontend rollback accepts only a version proven to belong to this exact archive', () => {
  assert.equal(selectRollback(previous, candidate, expectedTag, expectedTag), 'rollback');
  assert.throws(() => selectRollback(previous, candidate, 'frontend-' + 'f'.repeat(64), expectedTag),
    /different Worker version/u);
  assert.equal(selectRollback(previous, previous, null, expectedTag), 'unchanged');
});

test('frontend rollback refuses ambiguous traffic, missing identities, and external changes', () => {
  assert.deepEqual(assertSingleDeployment({
    id: candidate.deploymentId, strategy: 'percentage',
    versions: [{ version_id: candidate.versionId, percentage: 100 }],
  }), candidate);
  assert.throws(() => assertSingleDeployment({
    id: candidate.deploymentId, strategy: 'percentage',
    versions: [{ version_id: candidate.versionId, percentage: 50 },
      { version_id: previous.versionId, percentage: 50 }],
  }), /one pinned version/u);
  assert.throws(() => selectRollback(previous,
    { ...candidate, versionId: previous.versionId }, expectedTag, expectedTag), /without a new version/u);
});
