import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readFrontendPromotionProofArtifact } from '../../verification/artifacts/frontend.mjs';

test('frontend promotion proof reader downloads and extracts a digest-verified JSON ZIP entry', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-frontend-promotion-reader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const expected = { sourceSha: 'a'.repeat(40), mode: 'full', planDigest: 'b'.repeat(64) };
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(expected));
  execFileSync('zip', ['-q', 'proof.zip', 'report.json'], { cwd: directory });
  const archive = await readFile(path.join(directory, 'proof.zip'));
  const artifact = {
    id: 731,
    size_in_bytes: archive.length,
    digest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://storage.example/proof.zip?signature=temporary' } })
      : new Response(archive);
  };

  assert.deepEqual(await readFrontendPromotionProofArtifact(artifact, 'report.json', 'yohn-jp/codexia', 'test-read-token', fetchImpl), expected);
  assert.equal(requests[0].url, 'https://api.github.com/repos/yohn-jp/codexia/actions/artifacts/731/zip');
  assert.equal(new Headers(requests[0].options.headers).get('authorization'), 'token test-read-token');
  assert.equal(requests[0].options.redirect, 'manual');
  assert.equal(requests[1].url, 'https://storage.example/proof.zip?signature=temporary');
  assert.equal(requests[1].options.headers, undefined);
  assert.equal(requests[1].options.redirect, 'error');
});
