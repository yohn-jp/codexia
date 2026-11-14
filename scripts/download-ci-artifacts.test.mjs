import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { downloadArtifact, extractJsonEntry, extractProfileJson, selectedArtifacts } from './download-ci-artifacts.mjs';

const identity = { runId: '123', sourceSha: 'a'.repeat(40) };
const bytes = Buffer.from('archive');
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const artifact = { id: 10, name: 'ci-evidence-browser-full-webkit', workflow_run: { id: 123, head_sha: identity.sourceSha }, expired: false, digest, size_in_bytes: bytes.length };
const inventory = { identity, artifacts: [artifact, { ...artifact, id: 20 }] };

test('selected exact artifact ID is retained even when a same-name older artifact has a higher ID', () => {
  assert.deepEqual(selectedArtifacts(inventory, [10], identity, 'evidence'), [artifact]);
  for (const ids of [[10, 20], [10, 10], [99], [], [-1]]) assert.throws(() => selectedArtifacts(inventory, ids, identity, 'evidence'));
  for (const change of [{ expired: true }, { digest: 'bad' }, { name: '../report' }, { size_in_bytes: 20000000 }, { workflow_run: { id: 456, head_sha: identity.sourceSha } }]) {
    assert.throws(() => selectedArtifacts({ identity, artifacts: [{ ...artifact, ...change }] }, [10], identity, 'evidence'));
  }
});

test('exact REST artifact download validates bytes and isolates the GitHub read token', async () => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://storage.example/temporary?signature=secret' } }) : new Response(bytes);
  };
  assert.deepEqual(await downloadArtifact(artifact, 'owner/repo', 'test-token', request), bytes);
  assert.equal(requests[0].url, 'https://api.github.com/repos/owner/repo/actions/artifacts/10/zip');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(requests[0].options.redirect, 'manual');
  assert.equal(requests[1].options.headers, undefined);
  assert.equal(requests[1].options.redirect, 'error');
});

test('download rejects missing artifacts, invalid redirects, size and digest mismatches', async () => {
  await assert.rejects(downloadArtifact(artifact, 'owner/repo', 'token', async () => new Response(null, { status: 404 })), /redirect unavailable/);
  await assert.rejects(downloadArtifact(artifact, 'owner/repo', 'token', async () => new Response(null, { status: 302, headers: { location: 'http://storage.example/archive' } })), /Invalid artifact download redirect/);
  for (const bad of [Buffer.from('different'), Buffer.from('archivE'), Buffer.from('short')]) {
    let call = 0;
    await assert.rejects(downloadArtifact(artifact, 'owner/repo', 'token', async () => ++call === 1 ? new Response(null, { status: 302, headers: { location: 'https://storage.example/archive' } }) : new Response(bad)), /size|digest/);
  }
});

test('extracts only one requested JSON entry and rejects missing or malformed JSON', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codexia-ci-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'report.json'), '{"group":"browser-full-webkit"}');
  await writeFile(path.join(dir, 'extra.txt'), 'not evidence');
  execFileSync('zip', ['-q', 'artifact.zip', 'report.json', 'extra.txt'], { cwd: dir });
  const zip = await readFile(path.join(dir, 'artifact.zip'));
  assert.equal((await extractJsonEntry(zip, 'report.json')).toString(), '{"group":"browser-full-webkit"}');
  await assert.rejects(extractJsonEntry(zip, 'ci-plan.json'), /Missing or duplicate/);
  await writeFile(path.join(dir, 'report.json'), 'not JSON');
  execFileSync('zip', ['-q', 'invalid.zip', 'report.json'], { cwd: dir });
  await assert.rejects(extractJsonEntry(await readFile(path.join(dir, 'invalid.zip')), 'report.json'), SyntaxError);
});

test('profile ZIP extracts with Node alone, rejects corruption and ignores untrusted paths', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codexia-profile-zip-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const data = JSON.stringify({files:Array.from({length:100},(_,i)=>'profile output '+i)});
  await writeFile(path.join(dir,'profile-build.json'),data);
  await writeFile(path.join(dir,'extra.txt'),'not profile data');
  for(const method of ['-0','-9']){
    execFileSync('zip',['-q',method,'profile'+method+'.zip','profile-build.json','extra.txt'],{cwd:dir});
    const bytes=await readFile(path.join(dir,'profile'+method+'.zip'));
    assert.equal(extractProfileJson(bytes).toString(),data);
    assert.equal((await extractJsonEntry(bytes,'profile-build.json')).toString(),data);
    const broken=Buffer.from(bytes);
    broken.writeUInt32LE(0xffffffff,broken.length-22+16);
    assert.throws(()=>extractProfileJson(broken),/central directory/);
    assert.throws(()=>extractProfileJson(bytes.subarray(0,bytes.length-8)));
  }
});
