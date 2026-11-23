#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedBackendMigrationFingerprint, inspectBackendImageWithoutExecution } from './image-inspection.mjs';

export async function verifyBuiltBackendImageIdentity({args=process.argv.slice(2),env=process.env}={}){
  const [image,sourceSha,version,profile]=args;
  assert.ok(image,'Backend image reference is required');
  assert.match(sourceSha??'',/^[a-f0-9]{40}$/u,'Backend producer source SHA is invalid');
  assert.match(version??'',/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,'Backend producer version is invalid');
  assert.ok(['core','full'].includes(profile),'Backend image profile is invalid');
  const compatibility=JSON.parse(await readFile(new URL('../../../deploy/update-compatibility.json',import.meta.url),'utf8'));
  const migrationFingerprint=await expectedBackendMigrationFingerprint();
  return inspectBackendImageWithoutExecution(image,{sourceSha,version,profile,migrationFingerprint,compatibility},
    {tempRoot:env.RUNNER_TEMP||undefined});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  verifyBuiltBackendImageIdentity().then(identity=>console.log('Verified image identity without starting image code ('+identity.profile+', '+identity.sourceSha+').'))
    .catch(error=>{console.error(error instanceof Error?error.message:'Backend image identity verification failed');process.exitCode=1;});
}
