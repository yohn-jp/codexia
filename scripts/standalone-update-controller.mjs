import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { advanceJournal, validateJournal } from './update-host-state.mjs';
import { verifyUpdateChannel, selectUpdateCandidate } from './update-channel.mjs';
import { assertLegacyBootstrapCandidate, validateUpdateRelease } from './update-release-policy.mjs';

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
  const initialActivationPending=value.initialActivationPending;
  if(initialActivationPending!==undefined){
    assert.equal(initialActivationPending,true,'Invalid initial activation marker');
    assert.match(value.initialActivationId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,'Initial activation requires a durable operation identity');
    if(value.initialActivationFreshDatabaseId!==undefined)assert.match(value.initialActivationFreshDatabaseId,/^[1-9]\d{0,19}:[1-9]\d{0,9}$/u,'Invalid initial activation database identity');
    assert.equal(journal.phase,'idle');
    assert.ok(journal.checkpoint,'Initial activation requires an authenticated checkpoint');
    assert.equal(previous,null);
    assert.equal(pending,null);
    assert.equal(value.paused,true,'Initial activation must remain paused');
    assert.equal(value.lastSuccessAt,null);
    assert.deepEqual(value.failedImages,[]);
  }
  return {format:value.format,journal,installed,pending,previous,failedImages:[...new Set(value.failedImages)],paused:value.paused,lastError:value.lastError,lastSuccessAt:value.lastSuccessAt,
    ...(initialActivationPending===true?{initialActivationPending:true,initialActivationId:value.initialActivationId,
      ...(value.initialActivationFreshDatabaseId!==undefined?{initialActivationFreshDatabaseId:value.initialActivationFreshDatabaseId}:{})}:{})};
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

export function validateBackupIntent(value) {
  assert.ok(['codexia-backup-intent/v1','codexia-backup-intent/v3'].includes(value?.format));
  assert.ok(Number.isFinite(Date.parse(value.createdAt)), 'Backup intent timestamp is invalid');
  assert.equal(typeof value.timerWasActive, 'boolean');
  if (value.kind === 'controller') {
    assert.equal(value.format,'codexia-backup-intent/v1');
    assert.deepEqual(Object.keys(value).sort(), ['createdAt','format','image','journalGeneration','kind','priorLastError','priorPaused','slot','timerWasActive'].sort());
    assert.ok(['blue','green'].includes(value.slot));
    assert.match(value.image, imagePattern);
    assert.ok(Number.isSafeInteger(value.journalGeneration) && value.journalGeneration >= 0);
    assert.equal(typeof value.priorPaused, 'boolean');
    assert.ok(value.priorLastError === null || (typeof value.priorLastError === 'string' && value.priorLastError.length <= 1000));
    return { format:value.format, kind:value.kind, slot:value.slot, image:value.image,
      journalGeneration:value.journalGeneration, priorPaused:value.priorPaused,
      priorLastError:value.priorLastError, timerWasActive:value.timerWasActive, createdAt:value.createdAt };
  }
  assert.equal(value.kind, 'legacy');
  assert.equal(value.format,'codexia-backup-intent/v3','Legacy backup recovery intent is missing captured runtime and startup identity');
  assert.deepEqual(Object.keys(value).sort(), ['apiWasEnabled','autostartLinks','createdAt','format','identity','kind','release','timerWasActive','tunnelWasActive','tunnelWasEnabled'].sort());
  assert.equal(typeof value.tunnelWasActive, 'boolean');
  assert.equal(typeof value.apiWasEnabled, 'boolean');
  assert.equal(typeof value.tunnelWasEnabled, 'boolean');
  assert.deepEqual(Object.keys(value.autostartLinks??{}).sort(),['api','tunnel']);
  for(const [service,enabled] of [['api',value.apiWasEnabled],['tunnel',value.tunnelWasEnabled]]){
    const links=value.autostartLinks[service];
    assert.deepEqual(Object.keys(links??{}).sort(),['defaultTargetWants','generatorTarget']);
    assert.equal(typeof links.defaultTargetWants,'boolean');
    assert.equal(links.defaultTargetWants,enabled,'Captured default.target dependency state disagrees');
    assert.ok(links.generatorTarget===null||(typeof links.generatorTarget==='string'&&links.generatorTarget.length>0&&!/[\r\n\0]/u.test(links.generatorTarget)));
  }
  assert.deepEqual(Object.keys(value.identity??{}).sort(),['api','tunnel']);
  for(const service of ['api','tunnel']){
    assert.deepEqual(Object.keys(value.identity[service]??{}).sort(),['runtimeFingerprint','unitFingerprint']);
    assert.match(value.identity[service].unitFingerprint,/^[a-f0-9]{64}$/u);
    if(value.identity[service].runtimeFingerprint!==null)assert.match(value.identity[service].runtimeFingerprint,/^[a-f0-9]{64}$/u);
  }
  assert.match(value.identity.api.runtimeFingerprint,/^[a-f0-9]{64}$/u);
  if(value.tunnelWasActive)assert.match(value.identity.tunnel.runtimeFingerprint,/^[a-f0-9]{64}$/u);
  return { format:value.format, kind:value.kind, release:validateUpdateRelease(value.release), identity:value.identity,
    autostartLinks:value.autostartLinks,
    apiWasEnabled:value.apiWasEnabled,tunnelWasEnabled:value.tunnelWasEnabled,
    tunnelWasActive:value.tunnelWasActive, timerWasActive:value.timerWasActive, createdAt:value.createdAt };
}

export async function loadBackupIntent(filename) {
  let metadata;
  try { metadata = await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), 'Backup intent must be a regular file');
  assert.equal(metadata.mode & 0o077, 0, 'Backup intent permissions must be private');
  if (typeof process.getuid === 'function') assert.equal(metadata.uid, process.getuid(), 'Backup intent owner differs from the service user');
  assert.ok(metadata.size <= 65536, 'Backup intent exceeds the size limit');
  return validateBackupIntent(JSON.parse(await readFile(filename, 'utf8')));
}

export async function clearBackupIntent(filename) {
  try { await unlink(filename); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parent = await open(path.dirname(filename), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}

function validateBackupProofIdentity(value){
  assert.ok(typeof value.artifactDirectory==='string'&&path.isAbsolute(value.artifactDirectory)&&!/[\r\n\0]/u.test(value.artifactDirectory),'Backup artifact directory is invalid');
  assert.match(path.basename(value.artifactDirectory),/^codexia-\d{8}T\d{6}Z-[a-f0-9-]{36}$/u,'Backup artifact name is invalid');
  assert.match(value.checksumManifestSha256,/^[a-f0-9]{64}$/u,'Backup manifest checksum is invalid');
  return {...value,release:validateUpdateRelease(value.release)};
}

export function validateLegacyBackupProof(value){
  assert.deepEqual(Object.keys(value??{}).sort(),['artifactDirectory','checksumManifestSha256','format','release']);
  assert.equal(value.format,'codexia-legacy-backup-proof/v1');
  return validateBackupProofIdentity(value);
}

export function validateControllerBackupProof(value){
  assert.deepEqual(Object.keys(value??{}).sort(),['artifactDirectory','checksumManifestSha256','databaseId','format','journalGeneration','release']);
  assert.equal(value.format,'codexia-controller-backup-proof/v1');
  assert.ok(Number.isSafeInteger(value.journalGeneration)&&value.journalGeneration>=0,'Invalid backup journal generation');
  assert.match(value.databaseId,/^[1-9]\d{0,19}:[1-9]\d{0,9}$/u,'Invalid backup database identity');
  return validateBackupProofIdentity(value);
}

export async function verifyBackupPublication(output,destination,host){
  const prefix='Encrypted backup committed: ';
  const lines=output.split('\n');
  const digestLine=/^Published checksum manifest sha256: ([a-f0-9]{64})$/u.exec(lines[1]??'');
  assert.ok(lines.length===2&&lines[0].startsWith(prefix)&&!/[\r\n]/u.test(lines[0])&&digestLine,'Backup did not return one committed artifact and publication digest');
  const artifactDirectory=await realpath(lines[0].slice(prefix.length));
  assert.equal(path.dirname(artifactDirectory),await realpath(destination),'Backup artifact is outside the approved destination');
  assert.equal(await host.backupArtifactIdentity(artifactDirectory),digestLine[1],'Published backup changed before recording source evidence');
  return {artifactDirectory,checksumManifestSha256:digestLine[1]};
}

function assertMatchingBackupArtifact(source,restore,observedHash){
  assert.deepEqual(Object.keys(restore??{}).sort(),['checksumManifestSha256','format']);
  assert.equal(restore.format,'codexia-restore-receipt/v1');
  assert.equal(restore.checksumManifestSha256,source.checksumManifestSha256,'Restore receipt does not match the source backup');
  assert.equal(observedHash,source.checksumManifestSha256,'Current off-VM artifact differs from the verified backup');
}

export function assertMatchingCutoverBackup(sourceValue,restore,release,observedHash){
  const source=validateLegacyBackupProof(sourceValue);
  assert.deepEqual(source.release,validateUpdateRelease(release),'Backup was not taken for the selected legacy release');
  assertMatchingBackupArtifact(source,restore,observedHash);
  return source;
}

export function assertMatchingControllerBackup(sourceValue,restore,state,databaseId,observedHash){
  const source=validateControllerBackupProof(sourceValue);
  state=validateControllerState(state);
  assert.ok(stable(state.journal)&&!state.initialActivationPending&&state.lastError===null,'Backup evidence requires a stable initialized controller');
  assert.equal(source.journalGeneration,state.journal.generation,'Backup was taken for a different controller generation');
  assert.deepEqual(source.release,state.installed,'Backup was taken for a different installed release');
  assert.equal(source.databaseId,databaseId,'Backup was taken for a different database identity');
  assertMatchingBackupArtifact(source,restore,observedHash);
  return source;
}

export function validateFreshSchemaProof(value){
  assert.deepEqual(Object.keys(value??{}).sort(),['databaseId','fingerprint','format','phase','release']);
  assert.equal(value.format,'codexia-fresh-schema-proof/v2');
  assert.ok(['initializing','complete'].includes(value.phase),'Invalid fresh schema proof phase');
  const release=validateUpdateRelease(value.release);
  assert.equal(value.fingerprint,release.migrationFingerprint,'Fresh schema proof fingerprint differs from release');
  assert.match(value.databaseId,/^[1-9]\d{0,19}:[1-9]\d{0,9}$/u,'Invalid database identity');
  return {...value,release};
}
export function switchLegacyTunnelSource(source){
  assert.ok(typeof source==='string'&&source.length<=65536&&!source.includes('\0'),'Invalid legacy Tunnel source');
  const lines=source.split('\n');
  for(const [before,after] of [['Requires=codexia-api.service','Requires=codexia-api-proxy.service'],['After=network-online.target codexia-api.service','After=network-online.target codexia-api-proxy.service']]){
    assert.equal(lines.filter(line=>line===before).length,1,'Tunnel is not in canonical legacy state');
    assert.ok(!lines.includes(after),'Tunnel already contains proxy dependency');
    lines[lines.indexOf(before)]=after;
  }
  return lines.join('\n');
}
export function validateLegacyCutover(value){
  assert.deepEqual(Object.keys(value??{}).sort(),['apiSource','backupIntent','checkpoint','format','operationId','proofHash','slot','tunnelSource'].sort());
  assert.equal(value.format,'codexia-legacy-cutover/v1');
  const backupIntent=validateBackupIntent(value.backupIntent);
  assert.equal(backupIntent.kind,'legacy');
  assert.equal(backupIntent.timerWasActive,false,'Cutover requires stopped polling');
  assert.equal(backupIntent.tunnelWasActive,true,'Legacy cutover requires the original serving Tunnel');
  assert.ok(typeof value.apiSource==='string'&&value.apiSource.length>0&&value.apiSource.length<=65536&&!value.apiSource.includes('\0'));
  switchLegacyTunnelSource(value.tunnelSource);
  assert.match(value.operationId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  assert.match(value.proofHash,/^[a-f0-9]{64}$/u);
  initialControllerState(backupIntent.release,value.slot,value.checkpoint);
  assert.ok(value.checkpoint,'Cutover requires an authenticated checkpoint');
  return {...value,backupIntent};
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
  // Pre-journal admission only. No writer, route, journal, timer, Tunnel or
  // database mutation is authorized by this result. The isolated read-only
  // candidate must become ready while the original legacy writer still serves.
  async verifyInitialCandidate(legacyValue,candidateValue,{owner,slot='blue'}={}){
    const legacy=validateUpdateRelease(legacyValue);
    const candidate=validateUpdateRelease(candidateValue);
    const sameImage=legacy.image===candidate.image;
    if(sameImage)assert.deepEqual(legacy,candidate,'Same-image admission requires the identical release record');
    await this.assertNoBackupIntent();
    assert.equal(await this.host.routeState(),'blocked','Initial candidate requires the blocked private proxy route');
    assert.equal(await this.host.pollingTimerActive(),false,'Initial candidate requires polling stopped');
    assert.equal(await this.host.legacyServiceActive(),true,'Initial candidate requires a running legacy writer');
    await this.host.assertNoPreflight();
    const channel=verifyUpdateChannel(await this.host.fetchChannel(),this.publicKey,null,this.now());
    for(const release of [legacy,candidate]){
      assert.ok(channel.payload.releases.some(r=>r.state==='published'&&JSON.stringify(r)===JSON.stringify(release)),'Initial release must be published in the fresh signed channel');
    }
    const uiEpoch=await this.uiEpoch(candidate);
    if(!sameImage)assertLegacyBootstrapCandidate(legacy,candidate,uiEpoch);
    await this.host.pullAndVerify(candidate);
    const options={allowUnadvertisedEpoch:!sameImage};
    const before=await this.host.assertLegacyRelease(legacy,options);
    // Only this owned disposable fixture may be removed. Refuse a pre-existing
    // fixture rather than treating its presence as permission to delete it.
    await this.host.assertNoPreflight();
    try{
      await this.host.prepare(slot,candidate,owner);
    }finally{
      if(owner)await this.host.stopInitialPreflight(slot,owner);
      else await this.host.stopPreflight(slot,candidate.image);
    }
    await this.host.assertNoPreflight();
    assert.equal(await this.host.legacyServiceActive(),true,'Legacy writer changed during initial candidate preflight');
    assert.equal(await this.host.routeState(),'blocked','Proxy route changed during initial candidate preflight');
    assert.equal(await this.host.pollingTimerActive(),false,'Polling changed during initial candidate preflight');
    assert.deepEqual(await this.host.assertLegacyRelease(legacy,options),before,'Legacy identity changed during initial candidate preflight');
    await this.uiEpoch(candidate);
    return {format:'codexia-bootstrap-preflight/v1',legacyImage:legacy.image,legacyApiEpoch:before.apiEpoch,
      candidateImage:candidate.image,candidateSourceSha:candidate.sourceSha,candidateApiEpoch:candidate.apiEpoch,
      activated:false};
  }
  /** Same-release legacy adoption, with a durable snapshot and the existing
   * backup startup fence. All effects occur under the caller's host lock. */
  async cutoverLegacy(value,slot,source,restore){
    const release=validateUpdateRelease(value);
    assert.equal(await this.store.loadState(),null,'Legacy cutover requires no controller journal');
    assert.equal(await this.store.loadCutover(),null,'Recover interrupted cutover first');
    await this.assertNoBackupIntent();
    await this.host.removeBackupStartupFence();
    assert.equal(await this.host.routeState(),'blocked');
    assert.equal(await this.host.pollingTimerActive(),false);
    assert.equal(await this.host.legacyServiceActive(),true);
    assert.equal(await this.host.tunnelServiceActive(),true);
    await this.host.assertNoSlotSources();
    await this.host.assertNoPreflight();
    const channel=verifyUpdateChannel(await this.host.fetchChannel(),this.publicKey,null,this.now());
    assert.ok(channel.payload.releases.some(r=>r.state==='published'&&JSON.stringify(r)===JSON.stringify(release)),'Legacy cutover release is not published');
    await this.uiEpoch(release);
    const proof=assertMatchingCutoverBackup(source,restore,release,await this.host.backupArtifactIdentity(source.artifactDirectory));
    const autostart=await this.host.captureBackupAutostart();
    const api=await this.host.assertLegacyBackupRelease(release);
    const tunnel=await this.host.assertLegacyBackupTunnel();
    const sources=await this.host.captureCutoverSources(release);
    assert.equal(api.unitFingerprint,sources.apiFingerprint);
    assert.equal(tunnel.unitFingerprint,sources.tunnelFingerprint);
    const backupIntent=validateBackupIntent({format:'codexia-backup-intent/v3',kind:'legacy',release,
      identity:{api,tunnel},...autostart,tunnelWasActive:true,timerWasActive:false,createdAt:new Date(this.now()).toISOString()});
    let intent=validateLegacyCutover({format:'codexia-legacy-cutover/v1',backupIntent,
      checkpoint:channel.checkpoint,slot,operationId:randomUUID(),proofHash:proof.checksumManifestSha256,
      apiSource:sources.apiSource,tunnelSource:sources.tunnelSource});
    await this.store.saveCutover(intent);
    try{
      await this.verifyInitialCandidate(release,release,{owner:{operationId:intent.operationId,release},slot});
      // Recheck the exact off-VM evidence and identities immediately before
      // recording the startup fence and stopping the writer.
      assertMatchingCutoverBackup(proof,restore,release,await this.host.backupArtifactIdentity(proof.artifactDirectory));
      await this.host.assertLegacyBackupRelease(release,{expectedIdentity:api});
      await this.host.assertLegacyBackupTunnel({expectedIdentity:tunnel});
      const fresh=verifyUpdateChannel(await this.host.fetchChannel(),this.publicKey,intent.checkpoint,this.now());
      assert.ok(fresh.payload.releases.some(item=>item.state==='published'&&JSON.stringify(item)===JSON.stringify(release)),'Legacy release changed before disruption');
      await this.uiEpoch(release);
      intent=validateLegacyCutover({...intent,checkpoint:fresh.checkpoint});
      await this.store.saveCutover(intent);
      await this.saveBackupRecoveryIntent(backupIntent);
      await this.host.installBackupStartupFence();
      await this.host.assertBackupAutostartGated(backupIntent);
      await this.host.stopTunnel();
      await this.host.stopLegacyWriter();
      await this.host.applyCutoverSources(intent);
      await this.host.startInitialProxy();
      await this.host.assertInitialLegacyAbsent();
      const state=await this.save({...initialControllerState(release,slot,intent.checkpoint),
        initialActivationPending:true,initialActivationId:intent.operationId});
      return await this.recoverLegacyCutover(state,intent);
    }catch(error){
      // The journal is the irreversible ownership boundary. Before it exists
      // restore the old sources and writer; after it exists retain evidence
      // and retry only the new controller. Never delete a journal to roll back.
      const persisted=await this.store.loadState();
      if(!persisted)await this.recoverLegacyCutover(null,intent);
      else await this.host.route('blocked').catch(()=>undefined);
      throw error;
    }
  }
  async recoverLegacyCutover(state,value){
    const intent=validateLegacyCutover(value);
    const old=intent.backupIntent;
    const release=old.release;
    const observed=await this.loadBackupIntent();
    if(observed)assert.deepEqual(observed,old,'Cutover and backup recovery identities disagree');
    if(!state){
      await this.host.route('blocked');
      await this.host.stopInitialPreflight(intent.slot,{operationId:intent.operationId,release});
      await this.host.assertNoSlotSources();
      // Before the startup fence is written no writer disruption has
      // occurred. Preserve a still-proven legacy service on admission failure.
      if(!observed&&await this.host.legacyServiceActive({recoverStopped:true})&&await this.host.tunnelServiceActive()){
        await this.host.assertLegacyBackupRelease(release,{expectedIdentity:old.identity.api});
        await this.host.assertLegacyBackupTunnel({expectedIdentity:old.identity.tunnel});
        await this.host.assertCutoverOriginalSources(intent);
        await this.store.clearCutover();
        return null;
      }
      await this.host.restoreCutoverSources(intent);
      if(!observed)await this.saveBackupRecoveryIntent(old);
      await this.recoverBackupIntent(null);
      await this.store.clearCutover();
      return null;
    }
    state=validateControllerState(state);
    assert.deepEqual(state.installed,release,'Cutover journal release differs from durable intent');
    assert.equal(state.journal.active.slot,intent.slot);
    assert.equal(state.journal.generation,0);
    assert.equal(state.paused,true);
    assert.equal(state.journal.phase,'idle');
    assert.equal(state.previous,null);
    assert.equal(state.pending,null);
    assert.deepEqual(state.failedImages,[]);
    try{
      await this.host.assertCutoverSources(intent);
      if(state.initialActivationPending){
      assert.equal(state.initialActivationId,intent.operationId);
      assert.deepEqual(observed,old,'Pending activation lost its legacy startup fence');
      await this.host.route('blocked');
      await this.host.startInitialProxy();
      state=await this.recoverInitialActivation(state,{legacyCutoverIntent:old});
      if(state.initialActivationPending||state.lastError)throw Error(state.lastError??'Cutover activation remains pending');
      }else{
        // A retained cutover intent is explicit authority to resume a
        // committed first writer with a blocked route, not generic drift.
        assert.equal(state.lastError,null);
        assert.ok(state.lastSuccessAt);
        const obs=await this.host.observe();
        assertObservation(obs,state.journal);
        assert.ok(obs.route==='blocked'||obs.route===intent.slot,'Cutover handoff route drift');
        await this.host.route('blocked');
        const verified=verifyUpdateChannel(await this.host.fetchChannel(),this.publicKey,state.journal.checkpoint,this.now());
        assert.ok(verified.payload.releases.some(item=>item.state==='published'&&JSON.stringify(item)===JSON.stringify(release)),'Cutover release no longer published');
        await this.uiEpoch(release);
        await this.host.pullAndVerify(release);
        await this.host.startInitialProxy();
        const owner={operationId:intent.operationId,release};
        await this.host.stopInitialPreflight(intent.slot,owner);
        await this.host.assertNoPreflight();
        if(obs.writers.length===0){
          try{await this.host.prepare(intent.slot,release,owner);}
          finally{await this.host.stopInitialPreflight(intent.slot,owner);}
          await this.host.startWriter(intent.slot,release);
        }
        await this.host.verifyWriterUnits(state);
        await this.host.assertCutoverSources(intent);
        await this.host.route(intent.slot);
        await this.assertServing(state,intent.slot,release);
        state=await this.save({...state,journal:{...state.journal,checkpoint:verified.checkpoint}});
      }
      await this.assertServing(state,intent.slot,release);
      await this.clearBackupRecoveryIntent();
      await this.clearBackupIntent();
      await this.host.removeBackupStartupFence();
      await this.host.startCutoverTunnel(intent);
      await this.store.clearCutover();
      return state;
    }catch(error){
      await this.host.route('blocked').catch(()=>undefined);
      throw error;
    }
  }
  /** A separate fresh-only operation; it never starts a writer or creates a controller journal. */
  async initializeFreshSchema(value){
    const release=validateUpdateRelease(value);
    await this.assertNoBackupIntent();
    await this.host.assertFreshSchemaHost();
    const channel=verifyUpdateChannel(await this.host.fetchChannel(),this.publicKey,null,this.now());
    assert.ok(channel.payload.releases.some(r=>r.state==='published'&&JSON.stringify(r)===JSON.stringify(release)),'Fresh schema release must be published in the signed channel');
    await this.uiEpoch(release);
    await this.host.pullAndVerify(release);
    await this.host.assertFreshSchemaHost();
    const databaseId=await this.host.freshDatabaseIdentity();
    const observation=await this.host.inspectFreshSchema(release);
    assert.equal(observation.fingerprint,release.migrationFingerprint,'Schema observation fingerprint mismatch');
    let proof=await this.store.loadFreshSchema();
    if(proof){
      proof=validateFreshSchemaProof(proof);
      assert.deepEqual(proof.release,release,'Fresh schema intent belongs to another release');
      assert.equal(proof.databaseId,databaseId,'Fresh schema intent belongs to another database');
      if(proof.phase==='complete')assert.equal(observation.pristine,false,'Completed fresh schema ledger is missing');
    }else{
      // An arbitrary existing exact ledger is not proof of fresh storage.
      assert.equal(observation.pristine,true,'Existing database lacks fresh initialization provenance; use legacy adoption');
      proof=validateFreshSchemaProof({format:'codexia-fresh-schema-proof/v2',phase:'initializing',release,databaseId,fingerprint:release.migrationFingerprint});
      await this.store.saveFreshSchema(proof);
    }
    const result=await this.host.initializeFreshSchema(release);
    assert.equal(result.fingerprint,release.migrationFingerprint,'Initialized schema fingerprint mismatch');
    assert.equal(await this.host.freshDatabaseIdentity(),databaseId,'Database identity changed during fresh schema initialization');
    await this.host.assertFreshSchemaHost();
    await this.uiEpoch(release);
    await this.store.saveFreshSchema({...proof,phase:'complete'});
    return {format:'codexia-fresh-schema/v1',image:release.image,fingerprint:result.fingerprint,applied:result.applied,activated:false};
  }
  /** Fresh activation is distinct from legacy adoption. The caller has
   * verified the durable schema receipt and owns the host-wide lock. */
  async activateFresh(value,slot,existing=null){
    const release=validateUpdateRelease(value);
    assert.ok(['blue','green'].includes(slot),'Invalid initial slot');
    await this.assertNoBackupIntent();
    await this.host.assertInitialLegacyAbsent();
    assert.equal(await this.host.pollingTimerActive(),false,'Fresh activation requires stopped polling');
    await this.host.assertFreshTunnelInactive();
    const proof=validateFreshSchemaProof(await this.store.loadFreshSchema());
    assert.equal(proof.phase,'complete','Fresh activation requires completed schema proof');
    assert.deepEqual(proof.release,release,'Fresh activation release differs from schema proof');
    assert.equal(proof.databaseId,await this.host.freshDatabaseIdentity(),'Fresh activation database differs from schema proof');
    if(existing){
      existing=validateControllerState(existing);
      assert.deepEqual(existing.installed,release,'Fresh activation release differs from durable journal');
      assert.equal(existing.journal.active.slot,slot,'Fresh activation slot differs from durable journal');
      assert.equal(existing.paused,true,'Fresh activation must remain paused');
      if(existing.initialActivationPending){
        assert.equal(existing.initialActivationFreshDatabaseId,proof.databaseId,'Pending fresh activation belongs to a different database or lifecycle');
        await this.host.route('blocked');
        await this.host.startInitialProxy();
        return this.reconcile(existing,{boot:true});
      }
      assert.ok(['idle','committed'].includes(existing.journal.phase)&&existing.lastError===null,'Fresh activation journal is not settled');
      await this.uiEpoch(release);
      await this.assertServing(existing,slot,release);
      return existing;
    }
    await this.host.assertFreshSchemaHost();
    const channel=verifyUpdateChannel(await this.host.fetchChannel(),this.publicKey,null,this.now());
    assert.ok(channel.payload.releases.some(r=>r.state==='published'&&JSON.stringify(r)===JSON.stringify(release)),'Fresh activation release must be published in the signed channel');
    await this.uiEpoch(release);
    await this.host.pullAndVerify(release);
    await this.host.startInitialProxy();
    await this.host.assertFreshSchemaHost();
    // No writer or preflight has started. A crash from here is covered by
    // the same durable first-activation recovery path as legacy adoption.
    const state=await this.save({...initialControllerState(release,slot,channel.checkpoint),initialActivationPending:true,initialActivationId:randomUUID(),initialActivationFreshDatabaseId:proof.databaseId});
    return this.reconcile(state,{boot:true});
  }
  async assertServing(state,slot,release){
    const obs=await this.host.observe();
    assertObservation(obs,state.journal);
    assert.ok(isOnlyWriter(obs,slot,release.image),'Exclusive writer not observed');
    assert.equal(obs.route,slot,'Proxy route mismatch');
    await this.host.probe(slot,release);
  }
  async loadBackupIntent(){
    const primary=this.store.loadBackupIntent?await this.store.loadBackupIntent():null;
    const recovery=this.store.loadBackupRecoveryIntent?await this.store.loadBackupRecoveryIntent():null;
    const validatedPrimary=primary===null||primary===undefined?null:validateBackupIntent(primary);
    const validatedRecovery=recovery===null||recovery===undefined?null:validateBackupIntent(recovery);
    if(validatedPrimary&&validatedRecovery)assert.deepEqual(validatedPrimary,validatedRecovery,'Primary and independent backup recovery intents disagree');
    return validatedPrimary??validatedRecovery;
  }
  async saveBackupIntent(value){
    assert.ok(this.store.saveBackupIntent,'Durable backup intent storage is required');
    await this.store.saveBackupIntent(validateBackupIntent(value));
  }
  async clearBackupIntent(){
    assert.ok(this.store.clearBackupIntent,'Durable backup intent removal is required');
    await this.store.clearBackupIntent();
  }
  async saveBackupRecoveryIntent(value){
    assert.ok(this.store.saveBackupRecoveryIntent,'Independent durable backup recovery intent storage is required');
    await this.store.saveBackupRecoveryIntent(validateBackupIntent(value));
  }
  async clearBackupRecoveryIntent(){
    assert.ok(this.store.clearBackupRecoveryIntent,'Independent durable backup recovery intent removal is required');
    await this.store.clearBackupRecoveryIntent();
  }
  async assertNoBackupIntent(){
    assert.equal(await this.loadBackupIntent(),null,'Interrupted backup recovery is required before maintenance');
  }
  async recoverBackupIntent(state=null){
    const intent=await this.loadBackupIntent();
    if(!intent){await this.host.removeBackupStartupPermits?.();await this.host.removeBackupStartupFence?.();return state;}
    let legacyApiStartedByRecovery=false;
    let legacyApiIdentityVerified=false;
    let legacyIntentCleared=false;
    let legacyIntentClearAttempted=false;
    let legacyRecoveryIntentCleared=false;
    let legacyRecoveryIntentClearAttempted=false;
    let legacyRecoveryIntentSaved=false;
    let controllerIntentClearAttempted=false;
    let controllerIntentCleared=false;
    let controllerRecoveryIntentClearAttempted=false;
    let controllerRecoveryIntentCleared=false;
    try{
      if(intent.kind==='controller'){
        assert.ok(state,'Controller backup intent has no durable controller state');
        assert.equal(state.journal.generation,intent.journalGeneration,'Controller journal changed during backup recovery');
        assert.equal(state.journal.active.slot,intent.slot,'Controller active slot changed during backup recovery');
        assert.equal(state.installed.image,intent.image,'Controller release changed during backup recovery');
        // Keep an independent durable copy until the primary clear is committed.
        await this.saveBackupRecoveryIntent(intent);
        await this.host.route('blocked');
        if(await this.host.pollingTimerActive())await this.host.stopPollingTimer();
        await this.host.assertNoPreflight();
        let observed=await this.host.observe();
        assertObservation(observed,state.journal);
        if(observed.writers.length===0){
          await this.host.pullAndVerify(state.installed);
          await this.host.prepare(intent.slot,state.installed);
          await this.host.stopPreflight(intent.slot,state.installed.image);
          observed=await this.host.observe();
          assertObservation(observed,state.journal);
          assert.equal(observed.writers.length,0,'Unexpected writer appeared during backup recovery');
          await this.host.startWriter(intent.slot,state.installed);
        }else assert.ok(isOnlyWriter(observed,intent.slot,intent.image),'Unexpected writer prevents backup recovery');
        await this.host.route(intent.slot);
        await this.assertServing(state,intent.slot,state.installed);
        const timerActive=await this.host.pollingTimerActive();
        if(intent.timerWasActive&&!timerActive)await this.host.startPollingTimer();
        else if(!intent.timerWasActive&&timerActive)await this.host.stopPollingTimer();
        state=await this.save({...state,paused:intent.priorPaused,lastError:intent.priorLastError});
        controllerIntentClearAttempted=true;
        await this.clearBackupIntent();
        controllerIntentCleared=true;
        controllerRecoveryIntentClearAttempted=true;
        await this.clearBackupRecoveryIntent();
        controllerRecoveryIntentCleared=true;
        return state;
      }

      assert.equal(state,null,'Legacy backup intent unexpectedly has a controller journal');
      const release=intent.release;
      const channel=verifyUpdateChannel(await this.host.fetchChannel(),this.publicKey,null,this.now());
      assert.ok(channel.payload.releases.some(item=>item.state==='published'&&JSON.stringify(item)===JSON.stringify(release)),
        'Legacy backup release is no longer present in the signed channel');
      await this.uiEpoch(release);
      await this.saveBackupRecoveryIntent(intent);
      legacyRecoveryIntentSaved=true;
      await this.host.removeBackupStartupPermits();
      await this.host.installBackupStartupFence();
      await this.host.assertBackupAutostartGated(intent);
      await this.host.route('blocked');
      if(await this.host.pollingTimerActive())await this.host.stopPollingTimer();
      await this.host.assertNoPreflight();
      const apiActive=await this.host.legacyServiceActive({recoverStopped:true});
      const tunnelActive=await this.host.tunnelServiceActive();
      if(!intent.tunnelWasActive)assert.equal(tunnelActive,false,'Legacy Tunnel became active during a backup that recorded it inactive');
      await this.host.assertLegacyBackupRelease(release,{allowStopped:!apiActive,expectedIdentity:intent.identity.api});
      const tunnelIdentity=await this.host.assertLegacyBackupTunnel({allowStopped:!tunnelActive,expectedIdentity:intent.identity.tunnel});
      if(!intent.tunnelWasActive)assert.equal(tunnelIdentity.runtimeFingerprint,intent.identity.tunnel.runtimeFingerprint,'Inactive legacy Tunnel runtime identity changed during backup recovery');
      legacyApiIdentityVerified=apiActive;
      if(tunnelActive)await this.host.stopTunnel();
      if(!apiActive){
        legacyApiStartedByRecovery=true;
        await this.host.startLegacyWriter();
      }
      await this.host.assertLegacyBackupRelease(release,{expectedIdentity:intent.identity.api});
      legacyApiIdentityVerified=true;
      if(intent.tunnelWasActive){
        await this.host.startTunnel();
        await this.host.assertLegacyBackupTunnel({expectedIdentity:intent.identity.tunnel});
      }
      // Keep the generated Wants links unchanged. The independent durable
      // recovery marker blocks boot starts; a per-service volatile permit
      // authorizes only this verified start while the controller holds its lock.
      await this.host.installBackupStartupFence();
      await this.host.assertBackupAutostartGated(intent);
      await this.host.assertLegacyBackupRelease(release,{expectedIdentity:intent.identity.api});
      assert.equal(await this.host.routeState(),'blocked','Legacy backup recovery changed the controller-owned route');
      const timerActive=await this.host.pollingTimerActive();
      if(intent.timerWasActive&&!timerActive)await this.host.startPollingTimer();
      else if(!intent.timerWasActive&&timerActive)await this.host.stopPollingTimer();
      await this.host.restoreBackupAutostart(intent);
      legacyIntentClearAttempted=true;
      await this.clearBackupIntent();
      legacyIntentCleared=true;
      // Keep both reviewed startup fences loaded until both durable recovery
      // records have been cleared. A crash before marker deletion remains
      // recoverable; after marker deletion, service identities and timer state
      // have already been verified, so ordinary autostart is safe even if a
      // later fence cleanup is interrupted.
      legacyRecoveryIntentClearAttempted=true;
      await this.clearBackupRecoveryIntent();
      legacyRecoveryIntentCleared=true;
      await this.host.removeBackupStartupFence();
      return null;
    }catch(error){
      const prefix=intent.kind==='legacy'?'Legacy backup recovery blocked: ':'Backup recovery blocked: ';
      const reason=prefix+safeError(error);
      if(intent.kind==='legacy'&&legacyIntentCleared&&legacyRecoveryIntentCleared){
        throw new Error('Legacy backup recovery committed but startup-fence cleanup failed: '+safeError(error));
      }
      if(intent.kind==='legacy'){
        await this.host.route('blocked').catch(()=>undefined);
        await this.host.stopPollingTimer().catch(()=>undefined);
        if(legacyIntentClearAttempted&&!legacyIntentCleared){
          try{await this.saveBackupIntent(intent);}catch{}
        }
        if((legacyRecoveryIntentClearAttempted&&!legacyRecoveryIntentCleared)||!legacyRecoveryIntentSaved){
          try{await this.saveBackupRecoveryIntent(intent);legacyRecoveryIntentSaved=true;}catch{}
        }
        await this.host.removeBackupStartupPermits().catch(()=>undefined);
        if(legacyRecoveryIntentSaved){
          await this.host.installBackupStartupFence().catch(()=>undefined);
          await this.host.assertBackupAutostartGated(intent).catch(()=>undefined);
        }
        await this.host.stopTunnel().catch(()=>undefined);
        if(legacyApiStartedByRecovery&&!legacyApiIdentityVerified)await this.host.stopLegacyWriter().catch(()=>undefined);
      }else{
        // An unlink may have succeeded even if parent fsync failed. Re-create
        // the affected recovery record before returning a blocked topology.
        if(controllerIntentClearAttempted&&!controllerIntentCleared){
          try{await this.saveBackupIntent(intent);}catch{}
        }
        if(controllerRecoveryIntentClearAttempted&&!controllerRecoveryIntentCleared){
          try{await this.saveBackupRecoveryIntent(intent);}
          catch{try{await this.saveBackupIntent(intent);}catch{}}
        }
        await this.host.route('blocked').catch(()=>undefined);
        await this.host.stopPollingTimer().catch(()=>undefined);
      }
      if(intent.kind==='controller'&&state){
        await this.save({...state,paused:true,lastError:reason}).catch(()=>undefined);
      }
      throw new Error(reason);
    }
  }
  async backup(state,{destination,recipient}={}){
    assert.ok(stable(state.journal),'Backup requires a stable controller journal');
    assert.equal(state.lastError,null,'Controller error requires operator repair before backup');
    assert.ok(typeof destination==='string'&&path.isAbsolute(destination),'Backup destination must be an absolute external path');
    assert.ok(typeof recipient==='string'&&/^age1[0-9a-z]+$/u.test(recipient),'Provide an age public recipient');
    await this.assertNoBackupIntent();
    await this.host.validateBackupDestination(destination);
    const original=state;
    const active=state.journal.active;
    const timerWasActive=await this.host.pollingTimerActive();
    const before=await this.host.observe();
    assert.ok(Array.isArray(before.writers)&&before.writers.length===1,'Backup requires exactly one active writer');
    assertObservation(before,state.journal);
    assert.ok(isOnlyWriter(before,active.slot,state.installed.image),'Backup requires exactly one active writer');
    assert.equal(before.route,active.slot,'Backup requires the route to target the active writer');
    await this.host.assertNoPreflight();
    await this.assertServing(state,active.slot,state.installed);

    const intent={format:'codexia-backup-intent/v1',kind:'controller',slot:active.slot,image:state.installed.image,
      journalGeneration:state.journal.generation,priorPaused:state.paused,priorLastError:state.lastError,
      timerWasActive,createdAt:new Date(this.now()).toISOString()};
    await this.saveBackupIntent(intent);
    let maintenanceState=state;
    let output;
    let operationError;
    try{
      if(!maintenanceState.paused)maintenanceState=await this.save({...maintenanceState,paused:true});
      if(timerWasActive)await this.host.stopPollingTimer();
      await this.host.route('blocked');
      await this.host.stopWriter(active.slot);
      const fenced=await this.host.observe();
      assertObservation(fenced,maintenanceState.journal);
      assert.equal(fenced.route,'blocked','Proxy admission was not blocked');
      assert.equal(fenced.writers.length,0,'Writer fencing was not confirmed');
      output=await this.host.backup(destination,recipient);
    }catch(error){operationError=error;}

    let restored;
    try{restored=await this.recoverBackupIntent(maintenanceState);}
    catch(error){throw new Error(operationError?safeError(operationError)+'; '+safeError(error):safeError(error));}
    if(operationError)throw operationError;
    return {state:restored,output};
  }
  async backupLegacy(release,{destination,recipient}={}){
    release=validateUpdateRelease(release);
    assert.ok(typeof destination==='string'&&path.isAbsolute(destination),'Backup destination must be an absolute external path');
    assert.ok(typeof recipient==='string'&&/^age1[0-9a-z]+$/u.test(recipient),'Provide an age public recipient');
    await this.assertNoBackupIntent();
    await this.host.removeBackupStartupFence?.();
    const channel=verifyUpdateChannel(await this.host.fetchChannel(),this.publicKey,null,this.now());
    assert.ok(channel.payload.releases.some(item=>item.state==='published'&&JSON.stringify(item)===JSON.stringify(release)),'Legacy backup release must be published in the signed channel');
    await this.host.validateBackupDestination(destination);
    assert.equal(await this.host.routeState(),'blocked','Legacy backup requires the controller-owned route marker to be blocked');
    assert.equal(await this.host.legacyServiceActive(),true,'Legacy backup requires the legacy API service to be active');
    const tunnelWasActive=await this.host.tunnelServiceActive();
    const timerWasActive=await this.host.pollingTimerActive();
    await this.host.assertNoPreflight();
    await this.uiEpoch(release);
    const autostart=await this.host.captureBackupAutostart();
    const apiIdentity=await this.host.assertLegacyBackupRelease(release);
    const tunnelIdentity=await this.host.assertLegacyBackupTunnel({allowStopped:!tunnelWasActive});
    for(const [name,identity] of [['API',apiIdentity],['Tunnel',tunnelIdentity]]){
      assert.match(identity.unitFingerprint,/^[a-f0-9]{64}$/u,name+' systemd/Quadlet identity is not fingerprinted');
      if(name==='API'||tunnelWasActive)assert.match(identity.runtimeFingerprint,/^[a-f0-9]{64}$/u,name+' runtime identity is not fingerprinted');
    }
    const intent={format:'codexia-backup-intent/v3',kind:'legacy',release,identity:{api:apiIdentity,tunnel:tunnelIdentity},...autostart,tunnelWasActive,timerWasActive,
      createdAt:new Date(this.now()).toISOString()};
    await this.saveBackupRecoveryIntent(intent);
    await this.host.installBackupStartupFence();
    await this.saveBackupIntent(intent);
    let output;
    let operationError;
    try{
      await this.host.assertBackupAutostartGated(intent);
      if(timerWasActive)await this.host.stopPollingTimer();
      await this.host.route('blocked');
      if(tunnelWasActive)await this.host.stopTunnel();
      await this.host.stopLegacyWriter();
      assert.equal(await this.host.legacyServiceActive(),false,'Legacy API writer fencing was not confirmed');
      assert.equal(await this.host.tunnelServiceActive(),false,'Tunnel admission fencing was not confirmed');
      output=await this.host.backup(destination,recipient);
    }catch(error){operationError=error;}

    try{await this.recoverBackupIntent(null);}
    catch(error){throw new Error(operationError?safeError(operationError)+'; '+safeError(error):safeError(error));}
    if(operationError)throw operationError;
    return {output};
  }
  async restoreOld(state,reason){
    const old=state.journal.active;
    const candidate=state.journal.candidate;
    try{
      const obs=await this.host.observe();
      assertObservation(obs,state.journal);
      // Always stop the isolated preflight, which cannot mutate canon.
      if(candidate)await this.host.stopPreflight(candidate.slot,candidate.image);
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
          await this.host.stopPreflight(old.slot,state.installed.image);
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
  // Only an explicitly persisted initial activation may recover a blocked
  // route with an already-started writer. Ordinary committed topology drift
  // is still rejected. Caller owns the host-wide lock.
  async recoverInitialActivation(state,{legacyCutoverIntent=null}={}){
    state=validateControllerState(state);
    assert.equal(state.initialActivationPending,true);
    const active=state.journal.active;
    try{
      if(legacyCutoverIntent)assert.deepEqual(await this.loadBackupIntent(),legacyCutoverIntent,'Cutover startup fence identity changed');
      else await this.assertNoBackupIntent();
      await this.host.assertInitialLegacyAbsent();
      if(state.initialActivationFreshDatabaseId!==undefined){
        assert.equal(legacyCutoverIntent,null,'Fresh and legacy activation identities conflict');
        const proof=validateFreshSchemaProof(await this.store.loadFreshSchema());
        assert.equal(proof.phase,'complete');
        assert.deepEqual(proof.release,state.installed);
        assert.equal(proof.databaseId,state.initialActivationFreshDatabaseId);
        assert.equal(await this.host.freshDatabaseIdentity(),proof.databaseId,'Fresh activation database changed during interruption');
        await this.host.assertFreshTunnelInactive();
      }
      assert.equal(await this.host.pollingTimerActive(),false,'Initial activation requires stopped polling');
      const observed=await this.host.observe();
      assertObservation(observed,state.journal);
      assert.ok(observed.route==='blocked'||observed.route===active.slot,'Unexpected initial activation route');
      // Close admission before any recovery effects; a crashed writer may
      // already be running but has not yet earned durable serving proof.
      await this.host.route('blocked');
      const verified=verifyUpdateChannel(await this.host.fetchChannel(),this.publicKey,state.journal.checkpoint,this.now());
      assert.ok(verified.payload.releases.some(release=>release.state==='published'&&JSON.stringify(release)===JSON.stringify(state.installed)),
        'Initial release is absent or withdrawn from the fresh signed channel');
      state=await this.save({...state,journal:{...state.journal,checkpoint:verified.checkpoint}});
      await this.uiEpoch(state.installed);
      await this.host.pullAndVerify(state.installed);
      // A prior attempt may have left only its own read-only preflight.
      const owner={operationId:state.initialActivationId,release:state.installed};
      await this.host.stopInitialPreflight(active.slot,owner);
      await this.host.assertNoPreflight();
      if(observed.writers.length===0){
        try{await this.host.prepare(active.slot,state.installed,owner);}
        finally{await this.host.stopInitialPreflight(active.slot,owner);}
        await this.host.assertNoPreflight();
        await this.host.startWriter(active.slot,state.installed);
      }
      await this.host.assertInitialLegacyAbsent();
      const after=await this.host.observe();
      assertObservation(after,state.journal);
      assert.ok(isOnlyWriter(after,active.slot,state.installed.image),'Initial writer is not exclusive');
      await this.host.verifyWriterUnits(state);
      await this.uiEpoch(state.installed);
      await this.host.route(active.slot);
      await this.assertServing(state,active.slot,state.installed);
      const {initialActivationPending,initialActivationId,initialActivationFreshDatabaseId,...committed}=state;
      return await this.save({...committed,lastError:null,lastSuccessAt:new Date(this.now()).toISOString()});
    }catch(error){
      await this.host.route('blocked').catch(()=>undefined);
      return this.save({...state,paused:true,lastError:'Initial activation blocked: '+safeError(error)});
    }
  }
  async reconcile(state,{boot=false}={}){
    if(state.initialActivationPending){
      assert.ok(boot,'Initial activation must be recovered before ordinary lifecycle operations');
      return this.recoverInitialActivation(state);
    }
    if(!stable(state.journal))return this.restoreOld(state,'Interrupted update recovered from durable journal');
    const active=state.journal.active;
    try{
      const obs=await this.host.observe();
      assertObservation(obs,state.journal);
      if(boot&&obs.writers.length===0){
        await this.host.route('blocked');
        await this.host.pullAndVerify(state.installed);
        await this.host.prepare(active.slot,state.installed);
        await this.host.stopPreflight(active.slot,state.installed.image);
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
  async tick(state,{manualRollback=false,manualAcceptance=false}={}){
    if(manualAcceptance)assert.equal(state.paused,true,'Manual acceptance requires paused state');
    state=await this.reconcile(state);
    if(!stable(state.journal)||state.paused&&!manualRollback&&!manualAcceptance)return state;
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
      await this.host.stopPreflight(slot,candidate.image);
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
