import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { advanceJournal, validateJournal } from './update-host-state.mjs';
import { verifyUpdateChannel, selectUpdateCandidate } from './update-channel.mjs';
import { validateUpdateRelease } from './update-release-policy.mjs';

const stable = journal => ['idle','committed'].includes(journal.phase);
const opposite = slot => slot === 'blue' ? 'green' : 'blue';
const imagePattern = /^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u;

export function validateControllerState(value) {
  assert.equal(value?.format,'codexia-standalone-controller/v1');
  const journal=validateJournal(value.journal);
  const installed=validateUpdateRelease(value.installed);
  assert.equal(installed.image,journal.active.image);
  const pending=value.pending===null?null:validateUpdateRelease(value.pending);
  assert.equal(pending?.image??null,journal.candidate?.image??null);
  const previous=value.previous===null?null:validateUpdateRelease(value.previous);
  assert.ok(Array.isArray(value.failedImages)&&value.failedImages.every(image=>typeof image==='string'&&imagePattern.test(image)));
  assert.equal(typeof value.paused,'boolean');
  assert.ok(value.lastError===null||typeof value.lastError==='string');
  assert.ok(value.lastSuccessAt===null||typeof value.lastSuccessAt==='string');
  return {format:value.format,journal,installed,pending,previous,failedImages:[...new Set(value.failedImages)],paused:value.paused,lastError:value.lastError,lastSuccessAt:value.lastSuccessAt};
}

export async function atomicWrite(filename, content) {
  const dir=path.dirname(filename);
  await mkdir(dir,{recursive:true,mode:0o700});
  const temp=path.join(dir,'.'+path.basename(filename)+'.'+randomUUID()+'.tmp');
  let handle;
  try {
    handle=await open(temp,'wx',0o600);
    await handle.writeFile(content,'utf8'); await handle.sync(); await handle.close(); handle=null;
    await rename(temp,filename);
    const parent=await open(dir,'r');try{await parent.sync();}finally{await parent.close();}
  } finally {if(handle)await handle.close();await rm(temp,{force:true});}
}

export async function loadControllerState(filename) {
  const content=await readFile(filename,'utf8');
  if(Buffer.byteLength(content)>1024*1024)throw new Error('Controller state exceeds limit');
  return validateControllerState(JSON.parse(content));
}

export function initialControllerState(installed,slot,checkpoint) {
  return validateControllerState({format:'codexia-standalone-controller/v1',
    journal:{format:'codexia-updater-journal/v1',generation:0,phase:'idle',active:{slot,image:installed.image},candidate:null,checkpoint},
    installed,pending:null,previous:null,failedImages:[],paused:true,lastError:null,lastSuccessAt:null});
}

function assertRollbackCompatible(installed,prior,uiEpoch) {
  for(const field of ['profile','platform','migrationFingerprint','persistenceFormat','apiEpoch'])assert.equal(prior[field],installed[field],'Rollback changes '+field);
  assert.equal(uiEpoch,prior.apiEpoch,'Rollback UI incompatibility');
  assert.equal(prior.version.split('.')[0],installed.version.split('.')[0],'Rollback crosses major version');
  if(installed.version.startsWith('0.'))assert.equal(prior.version.split('.')[1],installed.version.split('.')[1],'Rollback crosses 0.x minor boundary');
}

function assertObservation(observation,journal) {
  assert.ok(Array.isArray(observation.writers)&&observation.writers.length<=1,'Multiple or unobservable writers');
  for(const writer of observation.writers){
    const expected=[journal.active,journal.candidate].find(slot=>slot?.slot===writer.slot);
    assert.equal(writer.image,expected?.image,'Unexpected running writer image');
  }
}
function isOnlyWriter(observation,slot,image) {
  return observation.writers.length===1&&observation.writers[0].slot===slot&&observation.writers[0].image===image;
}
const safeError=error=>String(error instanceof Error?error.message:error).slice(0,1000);

/** Caller holds the host-wide OS flock. Adapter methods perform and observe real effects. */
export class StandaloneController {
  constructor({host,store,publicKey,observeMilliseconds=300000,intervalMilliseconds=5000,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
    assert.ok(Number.isSafeInteger(observeMilliseconds)&&observeMilliseconds>=0&&observeMilliseconds<=3600000);
    assert.ok(Number.isSafeInteger(intervalMilliseconds)&&intervalMilliseconds>0);
    Object.assign(this,{host,store,publicKey,observeMilliseconds,intervalMilliseconds,now,sleep});
  }
  async save(value){const state=validateControllerState(value);await this.store.save(state);return state;}
  async transition(state,event,patch={}){return this.save({...state,...patch,journal:advanceJournal(state.journal,event)});}
  async channel(state){
    const verified=verifyUpdateChannel(await this.host.fetchChannel(),this.publicKey,state.journal.checkpoint,this.now());
    const checkpoint=verified.checkpoint;
    const next=await this.save({...state,journal:{...state.journal,checkpoint,generation:state.journal.generation+1}});
    return {state:next,verified};
  }
  async uiEpoch(release){
    const observed=await this.host.frontendIdentity();
    assert.equal(observed.profile,release.profile,'Deployed UI profile mismatch');
    assert.equal(observed.apiEpoch,release.apiEpoch,'Deployed UI epoch mismatch');
    return observed.apiEpoch;
  }
  async assertServing(state,slot,release){
    const obs=await this.host.observe();
    assertObservation(obs,state.journal);
    assert.ok(isOnlyWriter(obs,slot,release.image),'Exclusive writer not observed');
    assert.equal(obs.route,slot,'Proxy route mismatch');
    await this.host.probe(slot,release);
  }
  async restoreOld(state,reason){
    const old=state.journal.active;
    const candidate=state.journal.candidate;
    try{
      const obs=await this.host.observe();
      assertObservation(obs,state.journal);
      // Always stop the isolated preflight, which cannot mutate canon.
      if(candidate)await this.host.stopPreflight(candidate.slot);
      if(!isOnlyWriter(obs,old.slot,old.image)||obs.route!==old.slot){
        await this.host.route('blocked');
        if(candidate)await this.host.stopWriter(candidate.slot);
        const fenced=await this.host.observe();
        assertObservation(fenced,state.journal);
        assert.ok(!fenced.writers.some(writer=>writer.slot!==old.slot),'Candidate still owns writer');
        await this.uiEpoch(state.installed);
        if(!isOnlyWriter(fenced,old.slot,old.image)){
          await this.host.pullAndVerify(state.installed);
          await this.host.prepare(old.slot,state.installed);
          await this.host.stopPreflight(old.slot);
          await this.host.startWriter(old.slot,state.installed);
        }
        await this.host.route(old.slot);
      }
      await this.assertServing(state,old.slot,state.installed);
      const failedImages=candidate?[...state.failedImages,candidate.image]:state.failedImages;
      if(!stable(state.journal)){
        if(state.journal.phase!=='blocked')state=await this.transition(state,{to:'blocked'},{failedImages,lastError:reason});
        state=await this.transition(state,{to:'idle',proof:{activeWriterExclusive:true,proxyOnActive:true}},{pending:null,failedImages,lastError:reason});
      }
      return state;
    }catch(error){
      // If topology cannot be established, refuse new traffic and future activation.
      await this.host.route('blocked').catch(()=>undefined);
      const lastError=reason+'; restoration blocked: '+safeError(error);
      if(!stable(state.journal)&&state.journal.phase!=='blocked'){
        return this.transition(state,{to:'blocked'},{paused:true,lastError});
      }
      return this.save({...state,paused:true,lastError});
    }
  }
  async reconcile(state,{boot=false}={}){
    if(!stable(state.journal))return this.restoreOld(state,'Interrupted update recovered from durable journal');
    const active=state.journal.active;
    try{
      const obs=await this.host.observe();
      assertObservation(obs,state.journal);
      if(boot&&obs.writers.length===0){
        await this.host.route('blocked');
        await this.host.pullAndVerify(state.installed);
        await this.host.prepare(active.slot,state.installed);
        await this.host.stopPreflight(active.slot);
        await this.host.startWriter(active.slot,state.installed);
        await this.host.route(active.slot);
      }
      await this.assertServing(state,active.slot,state.installed);
      return state;
    }catch(error){
      await this.host.route('blocked').catch(()=>undefined);
      return this.save({...state,paused:true,lastError:'Topology reconciliation blocked: '+safeError(error)});
    }
  }
  async tick(state,{manualRollback=false}={}){
    state=await this.reconcile(state);
    if(!stable(state.journal)||state.paused&&!manualRollback)return state;
    if(state.lastError?.startsWith('Topology reconciliation blocked:'))return state;
    let candidate;
    const old=state.journal.active;
    try{
      const channel=await this.channel(state);state=channel.state;
      const epoch=await this.uiEpoch(state.installed);
      if(manualRollback){
        if(!state.previous)throw new Error('No previous release recorded');
        candidate=channel.verified.payload.releases.find(release=>release.image===state.previous.image&&release.state==='published');
        if(!candidate)throw new Error('Previous release absent or withdrawn from fresh signed channel');
        assertRollbackCompatible(state.installed,candidate,epoch);
      } else candidate=selectUpdateCandidate(channel.verified,state.installed,epoch);
      if(!candidate||(!manualRollback&&state.failedImages.includes(candidate.image)))return state;
      const slot=opposite(old.slot);
      state=await this.transition(state,{to:'detected',candidate:{slot,image:candidate.image},checkpoint:channel.verified.checkpoint},{pending:candidate});
      state=await this.transition(state,{to:'verified',proof:{channelVerified:true}});
      await this.host.pullAndVerify(candidate);
      state=await this.transition(state,{to:'pulled',proof:{artifactVerified:true}});
      await this.host.prepare(slot,candidate);
      state=await this.transition(state,{to:'candidate-ready',proof:{ready:true,candidateReadOnly:true,migrationDisabled:true}});
      // Re-check signed channel and the actual deployed frontend immediately before taking the old API down.
      const fresh=await this.channel(state);state=fresh.state;
      const stillPublished=fresh.verified.payload.releases.find(release=>release.image===candidate.image&&release.state==='published');
      assert.deepEqual(stillPublished,candidate,'Candidate withdrawn or changed before cutover');
      const currentEpoch=await this.uiEpoch(state.installed);
      if(!manualRollback)assert.deepEqual(selectUpdateCandidate(fresh.verified,state.installed,currentEpoch),candidate,'A different candidate became current');
      else assertRollbackCompatible(state.installed,candidate,currentEpoch);
      await this.host.route('blocked');
      state=await this.transition(state,{to:'draining',proof:{oldAdmissionClosed:true}});
      await this.host.stopWriter(old.slot);
      let obs=await this.host.observe();assertObservation(obs,state.journal);assert.equal(obs.writers.length,0,'Old writer is not fenced');
      await this.host.stopPreflight(slot);
      await this.host.startWriter(slot,candidate);
      obs=await this.host.observe();assertObservation(obs,state.journal);assert.ok(isOnlyWriter(obs,slot,candidate.image),'New writer not exclusive');
      await this.host.route(slot);
      await this.assertServing(state,slot,candidate);
      state=await this.transition(state,{to:'switched',proof:{oldWriterFenced:true,newWriterExclusive:true,proxyOnCandidate:true}});
      state=await this.transition(state,{to:'observing',proof:{candidateServing:true}});
      const end=this.now()+this.observeMilliseconds;
      for(;;){
        await this.uiEpoch(candidate);
        await this.assertServing(state,slot,candidate);
        if(this.now()>=end)break;
        await this.sleep(Math.min(this.intervalMilliseconds,end-this.now()));
      }
      return await this.transition(state,{to:'committed',proof:{candidateHealthy:true,oldWriterFenced:true}},
        {installed:candidate,previous:state.installed,pending:null,lastError:null,lastSuccessAt:new Date(this.now()).toISOString(),
          failedImages:manualRollback?[...state.failedImages,old.image]:state.failedImages});
    }catch(error){
      const reason=safeError(error);
      if(!stable(state.journal))return this.restoreOld(state,reason);
      // Before any cutover, an unavailable channel or invalid manifest cannot disrupt the active API.
      return this.save({...state,lastError:reason});
    }
  }
}
