import { actionsRepository, backendImageName, deploymentRepository } from '../../github/repository.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertImageTagAbsent } from '../components/policy.mjs';

export function assertBackendRegistryTag({tag, sourceSha, repository, ref}) {
  assert.match(sourceSha ?? '', /^[a-f0-9]{40}$/u, 'Verified source SHA is invalid');
  assert.ok(tag === 'sha-' + sourceSha || tag === 'sha-' + sourceSha + '-full',
    'Registry lookup requires exact verified source SHA tag');
  deploymentRepository(repository);
  assert.equal(ref, 'refs/heads/main', 'GitHub ref mismatch');
}

async function main() {
  const tag = process.argv[2];
  assertBackendRegistryTag({
    tag,
    sourceSha: process.env.CODEXIA_SOURCE_SHA,
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
  });
  const actor = process.env.GITHUB_ACTOR, token = process.env.GH_TOKEN;
  assert.ok(actor && token);
  const repository = backendImageName(actionsRepository().repository).slice('ghcr.io/'.length);
  const auth = await fetch('https://ghcr.io/token?service=ghcr.io&scope=' + encodeURIComponent('repository:' + repository + ':pull'), {
    headers: { Authorization: 'Basic ' + Buffer.from(actor + ':' + token).toString('base64') },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!auth.ok) throw Error('Registry authentication failed: HTTP ' + auth.status);
  const credentials = await auth.json(); assert.ok(typeof credentials?.token === 'string' && credentials.token);
  const response = await fetch('https://ghcr.io/v2/' + repository + '/manifests/' + encodeURIComponent(tag), {
    headers: { Authorization: 'Bearer ' + credentials.token, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (response.status === 200) {
    const digest = response.headers.get('docker-content-digest');
    assert.match(digest, /^sha256:[a-f0-9]{64}$/u, 'Registry response has no immutable digest');
    console.log(digest);
  } else {
    await assertImageTagAbsent(response);
    console.log('absent');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
