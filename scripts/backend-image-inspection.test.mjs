import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assertBackendImageIdentity } from './backend-image-inspection.mjs';
import { verifyBuiltBackendImageIdentity } from './verify-backend-image-identity.mjs';

test('static backend image identity binds producer, profile, platform and compatibility',()=>{
  const sourceSha='a'.repeat(40),version='0.1.90',fingerprint='sha256:'+'b'.repeat(64),image='ghcr.io/yohn-jp/codexia-backend@sha256:'+'c'.repeat(64);
  const identity={format:'codexia-backend-identity/v1',version,sourceSha,profile:'core',platform:'linux/amd64',migrationFingerprint:fingerprint,apiEpoch:1,persistenceFormat:1};
  const observed={Os:'linux',Architecture:'amd64',Config:{Labels:{'org.opencontainers.image.revision':sourceSha}},RepoDigests:[image]};
  assert.deepEqual(assertBackendImageIdentity(identity,observed,{image,sourceSha,version,profile:'core',migrationFingerprint:fingerprint,
    compatibility:{apiEpoch:1,persistenceFormat:1}}),identity);
  for(const patch of [{sourceSha:'d'.repeat(40)},{version:'0.1.91'},{profile:'full'},{migrationFingerprint:'sha256:'+'e'.repeat(64)}])
    assert.throws(()=>assertBackendImageIdentity(identity,observed,{sourceSha,version,profile:'core',migrationFingerprint:fingerprint,compatibility:{apiEpoch:1,persistenceFormat:1},...patch}));
  assert.throws(()=>assertBackendImageIdentity(identity,{...observed,Config:{Labels:{'org.opencontainers.image.revision':'d'.repeat(40)}}},{sourceSha,version,profile:'core'}));
});

test('container identity inspection never starts an image process',async()=>{
  const source=await readFile(new URL('./backend-image-inspection.mjs',import.meta.url),'utf8');
  assert.match(source,/\['create','--entrypoint','\/bin\/false',imageRef\]/u);
  assert.ok(source.includes("['cp',container+':/app/update-identity.json',identityPath]"));
  assert.doesNotMatch(source,/docker.*run|\['run'/u);
});

test('built-image identity CLI rejects malformed producer data before Docker inspection',async()=>{
  await assert.rejects(()=>verifyBuiltBackendImageIdentity({args:['image','a'.repeat(40),'bad','core']}),/version is invalid/);
  await assert.rejects(()=>verifyBuiltBackendImageIdentity({args:['image','bad','0.1.1','core']}),/source SHA is invalid/);
});
