import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertMatchingCutoverBackup, StandaloneController, initialControllerState, atomicWrite, loadControllerState } from './standalone-update-controller.mjs';
import { signUpdateChannel, verifyUpdateChannel } from './update-channel.mjs';
const key=generateKeyPairSync('ed25519');
const pub=key.publicKey.export({type:'spki',format:'pem'});
const priv=key.privateKey.export({type:'pkcs8',format:'pem'});
const now=Date.parse('2026-11-12T12:00:00Z');
const old={format:'codexia-update-release/v1',channel:'stable',state:'published',version:'0.1.0',sourceSha:'a'.repeat(40),image:'ghcr.io/yohn-jp/codexia-backend@sha256:'+'a'.repeat(64),platform:'linux/amd64',profile:'core',migrationFingerprint:'sha256:'+'c'.repeat(64),persistenceFormat:1,apiEpoch:1};
const next={...old,version:'0.1.1',sourceSha:'b'.repeat(40),image:'ghcr.io/yohn-jp/codexia-backend@sha256:'+'b'.repeat(64)};
function fixture(){
 const h={writers:[{slot:'blue',image:old.image}],target:'blue',preflight:new Set(),trace:[],fail:null,epoch:1,sequence:1,releases:[old,next],
 async observe(){return {route:this.target,writers:structuredClone(this.writers)}},
 async fetchChannel(){return signUpdateChannel({format:'codexia-update-channel/v1',sequence:this.sequence,issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString(),releases:this.releases},priv,now)},
 async frontendIdentity(){return {profile:'core',apiEpoch:this.epoch}},
 async pullAndVerify(r){this.trace.push('pull:'+r.version)},
 async prepare(slot){this.trace.push('prepare:'+slot);if(this.fail==='prepare'&&slot==='green')throw Error('preflight failed');this.preflight.add(slot)},
 async stopPreflight(slot){this.preflight.delete(slot)},
 async stopWriter(slot){this.trace.push('stop:'+slot);this.writers=this.writers.filter(w=>w.slot!==slot)},
 async startWriter(slot,r){assert.equal(this.writers.length,0);assert.ok(!this.preflight.has(slot));this.trace.push('start:'+slot);this.writers=[{slot,image:r.image}]},
 async route(slot){this.trace.push('route:'+slot);this.target=slot},
 async probe(slot){if(this.fail==='probe'&&slot==='green')throw Error('new writer unhealthy')}
 };
 let persisted;
 const controller=new StandaloneController({host:h,store:{async save(s){persisted=structuredClone(s)}},publicKey:pub,now:()=>now,observeMilliseconds:0});
 return {h,controller,state:{...initialControllerState(old,'blue',null),paused:false},persisted:()=>persisted};
}
test('signed candidate switches only after the old writer is stopped',async()=>{
 const {h,controller,state,persisted}=fixture();const result=await controller.tick(state);
 assert.equal(result.journal.phase,'committed');assert.equal(result.installed.image,next.image);assert.equal(result.previous.image,old.image);
 assert.deepEqual(h.writers,[{slot:'green',image:next.image}]);assert.equal(h.target,'green');
 assert.ok(h.trace.indexOf('prepare:green')<h.trace.indexOf('stop:blue'));assert.ok(h.trace.indexOf('stop:blue')<h.trace.indexOf('start:green'));
 assert.deepEqual(persisted(),result);
});
test('failed preflight preserves the old service and suppresses that digest',async()=>{
 const {h,controller,state}=fixture();h.fail='prepare';let result=await controller.tick(state);
 assert.equal(result.installed.image,old.image);assert.equal(result.journal.phase,'idle');assert.ok(result.failedImages.includes(next.image));assert.equal(h.target,'blue');
 assert.ok(!h.trace.includes('stop:blue'));h.fail=null;result=await controller.tick(result);assert.equal(result.installed.image,old.image);
});
test('post-switch failure fences the candidate and restores the previous writer',async()=>{
 const {h,controller,state}=fixture();h.fail='probe';const result=await controller.tick(state);
 assert.equal(result.journal.phase,'idle');assert.deepEqual(h.writers,[{slot:'blue',image:old.image}]);assert.equal(h.target,'blue');
 assert.ok(h.trace.indexOf('stop:green')<h.trace.lastIndexOf('start:blue'));assert.ok(result.failedImages.includes(next.image));
});
test('unobservable multiple writers block admission and pause',async()=>{
 const {h,controller,state}=fixture();h.writers.push({slot:'green',image:next.image});const result=await controller.tick(state);
 assert.equal(h.target,'blocked');assert.equal(result.paused,true);assert.ok(!h.trace.includes('start:green'));
});
test('incompatible frontend leaves the installed writer untouched',async()=>{
 const {h,controller,state}=fixture();h.epoch=2;const result=await controller.tick(state);
 assert.equal(result.installed.image,old.image);assert.equal(h.target,'blue');assert.match(result.lastError,/epoch mismatch/);
});
test('pause and explicit rollback preserve exclusive admission',async()=>{
 const {h,controller,state}=fixture();let result=await controller.tick({...state,paused:true});assert.equal(result.installed.image,old.image);
 result=await controller.tick({...result,paused:false});assert.equal(result.installed.image,next.image);
 result=await controller.tick(result,{manualRollback:true});assert.equal(result.installed.image,old.image);assert.ok(result.failedImages.includes(next.image));
 assert.deepEqual(h.writers,[{slot:'blue',image:old.image}]);
});
test('durable state round trips with its authenticated checkpoint',async()=>{
 const {controller,state}=fixture();const result=await controller.tick(state);const dir=await mkdtemp(path.join(tmpdir(),'codexia-updater-'));
 try{const file=path.join(dir,'controller.json');await atomicWrite(file,JSON.stringify(result));assert.deepEqual(await loadControllerState(file),result)}finally{await rm(dir,{recursive:true,force:true})}
});

test('manual acceptance updates and rolls back without enabling normal polling',async()=>{
 const {h,controller,state,persisted}=fixture();
 let result=await controller.tick({...state,paused:true},{manualAcceptance:true});
 assert.equal(result.installed.image,next.image);assert.equal(result.paused,true);assert.equal(persisted().paused,true);
 result=await controller.tick(result);
 assert.equal(result.installed.image,next.image);assert.equal(result.paused,true);
 result=await controller.tick(result,{manualRollback:true,manualAcceptance:true});
 assert.equal(result.installed.image,old.image);assert.equal(result.paused,true);assert.equal(persisted().paused,true);
 assert.deepEqual(h.writers,[{slot:'blue',image:old.image}]);
 await assert.rejects(controller.tick(state,{manualAcceptance:true}),/requires paused state/);
});


function initialCandidateFixture(){
 const {h,controller,persisted}=fixture();
 h.target='blocked';h.writers=[];h.legacyActive=true;h.legacyEpoch=null;h.polling=false;
 h.routeState=async()=>h.target;
 h.pollingTimerActive=async()=>h.polling;
 h.legacyServiceActive=async()=>h.legacyActive;
 h.assertNoPreflight=async()=>assert.equal(h.preflight.size,0,'Unexpected preflight');
 h.assertLegacyRelease=async(release,options)=>{
  h.trace.push('legacy:'+release.version);
  assert.equal(release.image,old.image);
  if(h.legacyEpoch===null)assert.equal(options.allowUnadvertisedEpoch,true,'Legacy epoch absent');
  return {apiEpoch:h.legacyEpoch};
 };
 h.prepare=async(slot,release)=>{
  assert.equal(h.legacyActive,true);assert.equal(h.target,'blocked');
  h.trace.push('prepare:'+release.version);h.preflight.add(slot);
  if(h.fail==='prepare')throw Error('candidate DB preflight failed');
 };
 return {h,controller,persisted};
}
test('legacy bootstrap preflight authenticates a distinct candidate and never activates it',async()=>{
 const {h,controller,persisted}=initialCandidateFixture();
 const result=await controller.verifyInitialCandidate(old,next);
 assert.deepEqual(result,{format:'codexia-bootstrap-preflight/v1',legacyImage:old.image,legacyApiEpoch:null,
  candidateImage:next.image,candidateSourceSha:next.sourceSha,candidateApiEpoch:1,activated:false});
 assert.deepEqual(h.trace,['pull:'+next.version,'legacy:'+old.version,'prepare:'+next.version,'legacy:'+old.version]);
 assert.equal(h.preflight.size,0);assert.equal(h.legacyActive,true);assert.equal(h.target,'blocked');
 assert.equal(persisted(),undefined);
});
test('legacy bootstrap rejects unsigned, incompatible or already running candidates before preflight',async()=>{
 for(const change of ['unsigned','epoch','schema','polling','route','preexisting']){
  const {h,controller}=initialCandidateFixture();let candidate=next;
  if(change==='unsigned')h.releases=[old];
  if(change==='epoch')h.epoch=2;
  if(change==='schema'){candidate={...next,migrationFingerprint:'sha256:'+'d'.repeat(64)};h.releases=[old,candidate];}
  if(change==='polling')h.polling=true;
  if(change==='route')h.target='blue';
  if(change==='preexisting')h.preflight.add('green');
  await assert.rejects(controller.verifyInitialCandidate(old,candidate));
  assert.ok(!h.trace.some(entry=>entry.startsWith('prepare:')));
  if(change==='preexisting')assert.ok(h.preflight.has('green'));
 }
});
test('failed bootstrap preflight removes its disposable fixture and retains the legacy writer',async()=>{
 const {h,controller,persisted}=initialCandidateFixture();h.fail='prepare';
 await assert.rejects(controller.verifyInitialCandidate(old,next),/candidate DB preflight failed/);
 assert.equal(h.preflight.size,0);assert.equal(h.legacyActive,true);assert.equal(h.target,'blocked');assert.equal(persisted(),undefined);
});
test('same-image initialization still requires an advertised legacy epoch before draining',async()=>{
 const {h,controller}=initialCandidateFixture();
 await assert.rejects(controller.verifyInitialCandidate(old,old),/Legacy epoch absent/);
 h.legacyEpoch=1;
 const result=await controller.verifyInitialCandidate(old,old);
 assert.equal(result.legacyApiEpoch,1);assert.equal(result.activated,false);
});

test('fresh schema requires signed release, matching frontend and an empty host before invoking migration',async()=>{
 const {h,controller,persisted}=fixture();
 h.writers=[];h.target='blocked';
 h.assertFreshSchemaHost=async()=>{assert.equal(h.writers.length,0);assert.equal(h.target,'blocked');};
 h.initializeFreshSchema=async release=>{h.trace.push('schema:'+release.version);return {fingerprint:release.migrationFingerprint,applied:['0001-initial.sql']};};
 const result=await controller.initializeFreshSchema(next);
 assert.deepEqual(result,{format:'codexia-fresh-schema/v1',image:next.image,fingerprint:next.migrationFingerprint,applied:['0001-initial.sql'],activated:false});
 assert.deepEqual(h.trace,['pull:'+next.version,'schema:'+next.version]);assert.equal(persisted(),undefined);
 for(const invalid of ['unsigned','epoch','writer','route']){
  h.trace=[];h.releases=invalid==='unsigned'?[old]:[old,next];h.epoch=invalid==='epoch'?2:1;
  h.writers=invalid==='writer'?[{slot:'blue',image:old.image}]:[];h.target=invalid==='route'?'blue':'blocked';
  await assert.rejects(controller.initializeFreshSchema(next));
  assert.ok(!h.trace.some(entry=>entry.startsWith('schema:')));
 }
});

test('fresh schema failure or mismatched fingerprint never creates a controller journal or activates a writer',async()=>{
 const {h,controller,persisted}=fixture();
 h.writers=[];h.target='blocked';
 h.assertFreshSchemaHost=async()=>{};
 h.initializeFreshSchema=async()=>{throw Error('untracked schema')};
 await assert.rejects(controller.initializeFreshSchema(next),/untracked schema/);
 h.initializeFreshSchema=async()=>({fingerprint:old.migrationFingerprint.replace('c','d'),applied:[]});
 await assert.rejects(controller.initializeFreshSchema(next),/fingerprint mismatch/);
 assert.equal(persisted(),undefined);assert.deepEqual(h.writers,[]);assert.equal(h.target,'blocked');
});

test('cutover proof binds the exact source release and verified ciphertext manifest',()=>{
 const hash='d'.repeat(64);
 const source={format:'codexia-legacy-backup-proof/v1',release:old,artifactDirectory:'/remote/codexia-20261117T000000Z-12345678-1234-1234-1234-123456789abc',checksumManifestSha256:hash};
 const receipt={format:'codexia-restore-receipt/v1',checksumManifestSha256:hash};
 assert.deepEqual(assertMatchingCutoverBackup(source,receipt,old,hash),source);
 assert.throws(()=>assertMatchingCutoverBackup(source,receipt,next,hash),/selected legacy release/);
 assert.throws(()=>assertMatchingCutoverBackup(source,{...receipt,checksumManifestSha256:'e'.repeat(64)},old,hash),/Restore receipt/);
 assert.throws(()=>assertMatchingCutoverBackup(source,receipt,old,'e'.repeat(64)),/Current off-VM artifact/);
 assert.throws(()=>assertMatchingCutoverBackup(source,{...receipt,approved:true},old,hash));
});

async function pendingInitialFixture(){
 const {h,controller,persisted}=fixture();
 h.target='blocked';h.writers=[];
 h.pollingTimerActive=async()=>false;
 h.assertNoPreflight=async()=>assert.equal(h.preflight.size,0,'Unexpected preflight');
 h.verifyWriterUnits=async()=>{};
 const checkpoint=verifyUpdateChannel(await h.fetchChannel(),pub,null,now).checkpoint;
 const state=await controller.save({...initialControllerState(old,'blue',checkpoint),initialActivationPending:true});
 return {h,controller,persisted,state};
}
test('initial activation resumes after journal persistence, before or after writer startup',async()=>{
 for(const phase of ['journal','preflight','writer','route']){
  const {h,controller,persisted,state}=await pendingInitialFixture();
  if(phase==='preflight')h.preflight.add('blue');
  if(['writer','route'].includes(phase))h.writers=[{slot:'blue',image:old.image}];
  if(phase==='route')h.target='blue';
  const recovered=await controller.reconcile(state,{boot:true});
  assert.equal(recovered.initialActivationPending,undefined);
  assert.equal(recovered.lastError,null);assert.equal(recovered.paused,true);
  assert.equal(h.target,'blue');assert.deepEqual(h.writers,[{slot:'blue',image:old.image}]);assert.equal(h.preflight.size,0);
  assert.equal(h.trace.filter(s=>s==='start:blue').length,['journal','preflight'].includes(phase)?1:0);
  assert.deepEqual(persisted(),recovered);
 }
});
test('initial activation refuses ordinary lifecycle and failed admission stays durably pending',async()=>{
 for(const failure of ['epoch','withdrawn','foreign-writer','foreign-route','probe']){
  const {h,controller,persisted,state}=await pendingInitialFixture();
  await assert.rejects(controller.tick(state),/Initial activation must be recovered/);
  if(failure==='epoch')h.epoch=2;
  if(failure==='withdrawn'){h.sequence=2;h.releases=[next];}
  if(failure==='foreign-writer')h.writers=[{slot:'green',image:next.image}];
  if(failure==='foreign-route')h.target='green';
  if(failure==='probe')h.probe=async()=>{throw Error('probe failed');};
  const recovered=await controller.reconcile(state,{boot:true});
  assert.equal(recovered.initialActivationPending,true);assert.ok(recovered.lastError);assert.equal(h.target,'blocked');assert.equal(recovered.paused,true);
  assert.deepEqual(persisted(),recovered);
 }
});
test('ordinary committed writer with a blocked route is not treated as interrupted initial activation',async()=>{
 const {h,controller,state}=fixture();h.target='blocked';
 const result=await controller.reconcile(state,{boot:true});
 assert.equal(result.initialActivationPending,undefined);assert.match(result.lastError,/Topology reconciliation blocked/);
 assert.equal(h.target,'blocked');
});

test('fresh activation authenticates exact release and persists intent before any writer starts',async()=>{
 const {h,controller,persisted}=fixture();
 h.target='blocked';h.writers=[];
 h.assertFreshLegacyAbsent=async()=>{};
 h.pollingTimerActive=async()=>false;h.tunnelServiceActive=async()=>false;
 h.assertNoPreflight=async()=>assert.equal(h.preflight.size,0);
 h.assertFreshSchemaHost=async()=>{assert.equal(h.writers.length,0);assert.equal(h.target,'blocked');};
 h.startInitialProxy=async()=>{assert.equal(h.target,'blocked');h.trace.push('proxy');};
 h.verifyWriterUnits=async()=>{};
 const start=h.startWriter;
 h.startWriter=async(...args)=>{assert.equal(persisted().initialActivationPending,true);await start.call(h,...args);};
 const result=await controller.activateFresh(next,'blue');
 assert.equal(result.initialActivationPending,undefined);assert.equal(result.lastError,null);
 assert.equal(result.paused,true);assert.equal(result.installed.image,next.image);
 assert.ok(h.trace.indexOf('proxy')<h.trace.indexOf('start:blue'));
 assert.equal(h.target,'blue');
 const trace=[...h.trace];
 assert.deepEqual(await controller.activateFresh(next,'blue',result),result);
 assert.deepEqual(h.trace,trace,'Settled fresh activation must not restart the writer');
 await assert.rejects(controller.activateFresh(old,'blue',result),/differs from durable journal/);
});
test('fresh activation refuses unsigned release, incompatible frontend and existing ingress',async()=>{
 for(const invalid of ['unsigned','epoch','tunnel','legacy']){
  const {h,controller,persisted}=fixture();h.target='blocked';h.writers=[];
  h.assertFreshLegacyAbsent=async()=>{if(invalid==='legacy')throw Error('legacy source exists');};
  h.pollingTimerActive=async()=>false;h.tunnelServiceActive=async()=>invalid==='tunnel';
  h.assertFreshSchemaHost=async()=>{};
  h.startInitialProxy=async()=>{h.trace.push('proxy');};
  if(invalid==='unsigned')h.releases=[old];
  if(invalid==='epoch')h.epoch=2;
  await assert.rejects(controller.activateFresh(next,'blue'));
  assert.ok(!h.trace.includes('proxy'));assert.equal(persisted(),undefined);
 }
});
