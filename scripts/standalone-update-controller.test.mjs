import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StandaloneController, initialControllerState, atomicWrite, loadControllerState } from './standalone-update-controller.mjs';
import { signUpdateChannel } from './update-channel.mjs';
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
