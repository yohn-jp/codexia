import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,rm,symlink,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createVerificationPlan,planDigest } from './ci-impact.mjs';
import { packProfile,profileRoots,restoreProfile,validateBundle,assertProfileArtifactEvidence } from './ci-profile-artifact.mjs';

async function fixture(t,profile='core'){
  const root=await mkdtemp(path.join(tmpdir(),'codexia-profile-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const output=path.join(root,'producer');const consumer=path.join(root,'consumer');
  const entries=profileRoots(profile).map(dir=>dir+'/index.js').concat(
    'app/dist/index.html','app/dist/desktop/index.html','app/dist/mobile/index.html',
    'packages/api/dist/server.js','profiles/'+profile+'/generated/server.mjs',
    'profiles/'+profile+'/generated/browser.mjs','profiles/'+profile+'/generated/module-manifests.json');
  for(const entry of new Set(entries)){
    await mkdir(path.dirname(path.join(output,entry)),{recursive:true});
    await writeFile(path.join(output,entry),'fixture '+entry);
  }
  await mkdir(consumer);
  const identity={profile,sourceSha:'a'.repeat(40),producerAttempt:1};
  return {output,consumer,identity,bundle:await packProfile(output,identity)};
}
test('exact profile output round trips, with no optional modules in core',async t=>{
  for(const profile of ['core','full']){
    const {consumer,identity,bundle}=await fixture(t,profile);
    assert.equal(bundle.files.some(file=>file.path.startsWith('modules/')),profile==='full');
    await restoreProfile(consumer,bundle,identity);
    assert.equal(await readFile(path.join(consumer,'app/dist/mobile/index.html'),'utf8'),'fixture app/dist/mobile/index.html');
    await assert.rejects(restoreProfile(consumer,bundle,identity),/already exists/);
  }
});
test('rejects stale or wrong profile, corruption, paths, duplicates and missing outputs before writing',async t=>{
  const {consumer,identity,bundle}=await fixture(t);
  for(const mutate of [
    b=>{b.identity.sourceSha='b'.repeat(40);},
    b=>{b.identity.profile='full';},
    b=>{b.files[0].sha256='0'.repeat(64);},
    b=>{b.files[0].data='!'+b.files[0].data.slice(1);},
    b=>{b.files[0].path='app/dist/../../outside';},
    b=>{b.files[0].path='modules/story/dist/index.js';},
    b=>{b.files.push(b.files[0]);},
    b=>{b.files=b.files.filter(file=>file.path!=='app/dist/mobile/index.html');},
  ]){
    const invalid=structuredClone(bundle);mutate(invalid);
    assert.throws(()=>validateBundle(invalid,identity));
    await assert.rejects(restoreProfile(consumer,invalid,identity));
  }
  await assert.rejects(readFile(path.join(consumer,'app/dist/index.html')), {code:'ENOENT'});
});
test('producer and consumer reject symlinked output paths',async t=>{
  const {output,consumer,identity,bundle}=await fixture(t);
  await symlink(path.join(output,'app/dist/index.html'),path.join(output,'app/dist/alias'));
  await assert.rejects(packProfile(output,identity),/Nonregular/);
  await symlink(path.join(output,'app'),path.join(consumer,'app'));
  await assert.rejects(restoreProfile(consumer,bundle,identity),/Unsafe directory/);
});
test('certification rejects missing, failed, stale or wrong producer evidence',()=>{
  const sourceSha='a'.repeat(40),runId='123';
  const plan=createVerificationPlan({files:['modules/search/src/browser.ts'],event:'pull_request',sha:sourceSha});
  const artifact={id:10,name:'ci-profile-build-full',created_at:'2026-01-01T00:01:00Z',expired:false,digest:'sha256:'+'a'.repeat(64),workflow_run:{id:123,head_sha:sourceSha}};
  const job={name:'build-full',head_sha:sourceSha,run_id:123,run_attempt:1,status:'completed',conclusion:'success',started_at:'2026-01-01T00:00:00Z',completed_at:'2026-01-01T00:02:00Z'};
  const receipt={profile:'full',sourceSha,planDigest:planDigest(plan),runId,producerJob:'build-full',producerAttempt:1,artifactId:10,artifactDigest:artifact.digest};
  const reports=plan.groups.filter(g=>g.startsWith('browser-')).map(group=>({group,profileArtifact:{...receipt}}));
  assert.ok(reports.length>0);
  assert.doesNotThrow(()=>assertProfileArtifactEvidence(plan,[job],reports,[artifact],runId));
  assert.throws(()=>assertProfileArtifactEvidence(plan,[job],reports.slice(1),[artifact],runId));
  assert.throws(()=>assertProfileArtifactEvidence(plan,[{...job,conclusion:'failure'}],reports,[artifact],runId));
  assert.throws(()=>assertProfileArtifactEvidence(plan,[job],reports,[{...artifact,id:11}],runId),/stale/);
  assert.throws(()=>assertProfileArtifactEvidence(plan,[{...job,run_attempt:2}],reports,[artifact],runId),/attempt/);
  assert.throws(()=>assertProfileArtifactEvidence(plan,[job],reports,[{...artifact,digest:'sha256:'+'b'.repeat(64)}],runId),/digest/);
});

test('full-profile evidence is mandatory for every native composition as well as browser groups',()=>{
  const sourceSha='a'.repeat(40),runId='123';
  const plan=createVerificationPlan({files:null,event:'push',sha:sourceSha});
  const jobs=['core','full'].map(profile=>({name:'build-'+profile,head_sha:sourceSha,run_id:123,run_attempt:1,status:'completed',conclusion:'success',started_at:'2026-01-01T00:00:00Z',completed_at:'2026-01-01T00:02:00Z'}));
  const artifacts=['core','full'].map((profile,i)=>({id:10+i,name:'ci-profile-build-'+profile,created_at:'2026-01-01T00:01:00Z',expired:false,digest:'sha256:'+(i?'b':'a').repeat(64),workflow_run:{id:123,head_sha:sourceSha}}));
  const reports=plan.groups.filter(g=>g.startsWith('browser-')||(g.startsWith('hosted-native-')&&!g.endsWith('-catalog'))).map(group=>{
    const profile=group.startsWith('browser-')?group.split('-')[1]:'full';
    const artifact=artifacts[profile==='core'?0:1];
    return {group,profileArtifact:{profile,sourceSha,planDigest:planDigest(plan),runId,producerJob:'build-'+profile,producerAttempt:1,artifactId:artifact.id,artifactDigest:artifact.digest}};
  });
  assert.equal(reports.length,9);
  assert.doesNotThrow(()=>assertProfileArtifactEvidence(plan,jobs,reports,artifacts,runId));
  for(const group of ['hosted-native-core','hosted-native-selected','hosted-native-full']){
    assert.throws(()=>assertProfileArtifactEvidence(plan,jobs,reports.filter(r=>r.group!==group),artifacts,runId));
    const bad=structuredClone(reports);
    bad.find(r=>r.group===group).profileArtifact={...bad.find(r=>r.group==='browser-core-writing').profileArtifact};
    assert.throws(()=>assertProfileArtifactEvidence(plan,jobs,bad,artifacts,runId));
  }
});
