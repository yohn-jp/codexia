import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateBackendIdentity } from './backend-update-identity.mjs';

export async function expectedBackendMigrationFingerprint(){
  const source=`import { readMigrationSet, migrationSetFingerprint } from './packages/persistence-postgres/src/migration-set.ts';
console.log(migrationSetFingerprint(await readMigrationSet('./packages/persistence-postgres/migrations')));`;
  return execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',source],{encoding:'utf8'}).trim();
}

export function assertBackendImageIdentity(identityValue,observed,expected){
  const identity=validateBackendIdentity(identityValue);
  assert.equal(observed.Os+'/'+observed.Architecture,identity.platform,'Backend image platform differs from embedded identity');
  assert.equal(observed.Config?.Labels?.['org.opencontainers.image.revision'],identity.sourceSha,'Backend OCI revision differs from embedded producer SHA');
  if(expected.image)assert.ok(observed.RepoDigests?.includes(expected.image),'Pulled backend image does not bind its exact immutable digest');
  if(expected.sourceSha!==undefined)assert.equal(identity.sourceSha,expected.sourceSha,'Backend producer SHA mismatch');
  if(expected.version!==undefined)assert.equal(identity.version,expected.version,'Backend producer version mismatch');
  if(expected.profile!==undefined)assert.equal(identity.profile,expected.profile,'Backend profile mismatch');
  if(expected.migrationFingerprint!==undefined)assert.equal(identity.migrationFingerprint,expected.migrationFingerprint,'Backend migration fingerprint mismatch');
  if(expected.compatibility){
    assert.equal(identity.apiEpoch,expected.compatibility.apiEpoch,'Backend API epoch mismatch');
    assert.equal(identity.persistenceFormat,expected.compatibility.persistenceFormat,'Backend persistence format mismatch');
  }
  return identity;
}

/** Read container files without starting the image entrypoint or any image process. */
export async function inspectBackendImageWithoutExecution(imageRef,expected,{tempRoot=tmpdir()}={}){
  const directory=await mkdtemp(path.join(tempRoot,'codexia-backend-image-identity-'));
  try{
    const observed=JSON.parse(execFileSync('docker',['image','inspect',imageRef],{encoding:'utf8'}))[0];
    const container=execFileSync('docker',['create','--entrypoint','/bin/false',imageRef],{encoding:'utf8'}).trim();
    const identityPath=path.join(directory,'update-identity.json');
    try{execFileSync('docker',['cp',container+':/app/update-identity.json',identityPath],{stdio:'ignore'});}
    finally{execFileSync('docker',['rm','--force',container],{stdio:'ignore'});}
    const identity=JSON.parse(await readFile(identityPath,'utf8'));
    return assertBackendImageIdentity(identity,observed,expected);
  }finally{await rm(directory,{recursive:true,force:true});}
}
