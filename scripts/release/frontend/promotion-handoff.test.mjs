import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { downloadArtifact, extractArtifactFiles } from '../../ci/evidence/download-artifacts.mjs';
import { buildComponentReleaseRecord } from '../components/record-model.mjs';
import { assertFrontendPromotionArtifactEvidence, verifyLifecycleFrontendArtifact } from '../../verification/artifacts/frontend.mjs';

test('verified PR artifact digest and identity flow through extraction into a main-bound release record', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'codexia-frontend-promotion-handoff-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const sourceSha='a'.repeat(40),mainSha='b'.repeat(40),tree='c'.repeat(40),baseSha='d'.repeat(40),planDigest='e'.repeat(64);
  const identity={format:'codexia-frontend-identity/v1',version:'0.1.77',sourceSha,profile:'full',apiEpoch:1};
  await mkdir(path.join(dir,'build','desktop'),{recursive:true});
  await writeFile(path.join(dir,'build','index.html'),'<html></html>');
  await writeFile(path.join(dir,'build','desktop','index.html'),'<html></html>');
  await writeFile(path.join(dir,'build','desktop','update-identity.json'),JSON.stringify(identity));
  execFileSync('zip',['-q','-r','frontend.zip','.'],{cwd:path.join(dir,'build')});
  const archive=await readFile(path.join(dir,'build','frontend.zip'));
  const archiveDigest='sha256:'+createHash('sha256').update(archive).digest('hex');
  const proof={sourceSha:mainSha,tree,baseSha,headSha:sourceSha,headRef:'feature/frontend',prNumber:17,mode:'full',runId:789,attempt:1,planDigest,mergedAt:'2026-11-01T00:00:00Z'};
  const run={id:123,run_number:77,run_attempt:2,workflow_id:72,path:'.github/workflows/frontend-release.yml',event:'pull_request',status:'completed',conclusion:'success',head_sha:sourceSha,head_branch:proof.headRef,updated_at:'2026-10-31T23:00:00Z',repository:{id:9},head_repository:{id:9},pull_requests:[]};
  const job={name:'Build and verify UI assets',head_sha:sourceSha,run_id:123,run_attempt:2,status:'completed',conclusion:'success',started_at:'2026-10-31T22:00:00Z',completed_at:'2026-10-31T22:30:00Z'};
  const artifact={id:456,name:'codexia-frontend-pr-17-123-'+sourceSha+'-attempt-2',digest:archiveDigest,size_in_bytes:archive.length,created_at:'2026-10-31T22:20:00Z',expired:false,workflow_run:{id:123,head_sha:sourceSha,head_branch:proof.headRef}};
  const selected=assertFrontendPromotionArtifactEvidence(run,[job],[artifact],proof,{repositoryId:9,workflowId:72,sourceSha,mainSha,mainTree:tree,baseSha,headBranch:proof.headRef,prNumber:17,mergedAt:proof.mergedAt,artifactName:artifact.name});
  let calls=0;
  const bytes=await downloadArtifact(selected,'yohn-jp/codexia','read-token',async(url,options)=>{
    calls++;
    if(calls===1){assert.equal(url,'https://api.github.com/repos/yohn-jp/codexia/actions/artifacts/456/zip');assert.equal(new Headers(options.headers).get('authorization'),'token read-token');return new Response(null,{status:302,headers:{location:'https://storage.example/archive'}});}
    return new Response(archive);
  },{maxArchive:1024*1024});
  const output=path.join(dir,'promoted');
  await extractArtifactFiles(bytes,output);
  const actualIdentity=JSON.parse(await readFile(path.join(output,'desktop','update-identity.json'),'utf8'));
  const release=buildComponentReleaseRecord('frontend',mainSha,actualIdentity,{event:'pull_request',sourceSha,version:identity.version,workflowRunId:123,
    workflowAttempt:2,workflowId:72,artifactId:selected.id,artifactDigest:selected.digest.slice(7),profile:identity.profile,apiEpoch:identity.apiEpoch,
    prNumber:17,verifyRunId:900,proofRunId:proof.runId,verifyAttempt:proof.attempt,planDigest,sourceTree:tree,mergeBaseSha:baseSha},tree);
  assert.equal(release.targetSha,mainSha);
  assert.equal(release.metadata.sourceSha,mainSha);
  assert.equal(release.metadata.producer.sourceSha,sourceSha);
  assert.equal(release.metadata.producer.artifactDigest,archiveDigest);
  assert.equal(await readFile(path.join(output,'desktop','update-identity.json'),'utf8'),JSON.stringify(identity));
});


test('epoch lifecycle rejects a frontend without approved public OAuth settings before artifact access', async () => {
  await assert.rejects(verifyLifecycleFrontendArtifact({}, {
    expectedEpoch: 46,
    env: { GITHUB_REPOSITORY: 'yohn-jp/codexia', GITHUB_REF: 'refs/heads/main' },
    fetchImpl: () => { assert.fail('An unconfigured lifecycle must not access an artifact'); },
  }), /approved public frontend OAuth configuration/u);
});
