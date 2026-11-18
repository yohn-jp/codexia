import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { assertMatchingControllerBackup, assertMatchingCutoverBackup, validateControllerBackupProof, verifyBackupPublication, validateLegacyBackupProof, validateLegacyCutover, validateFreshSchemaProof, atomicWrite, clearBackupIntent, initialControllerState, loadBackupIntent, loadControllerState, StandaloneController } from '../../scripts/standalone-update-controller.mjs';
import { PodmanStandaloneHost } from './standalone-host.mjs';
import { verifyUpdateChannel } from '../../scripts/update-channel.mjs';
import { validateUpdateRelease } from '../../scripts/update-release-policy.mjs';
import { assertMaintenanceSnapshotVerifier, maintainStandaloneUpdater, recoverInterruptedMaintenance } from './standalone-maintenance.mjs';

const [command,configPath,...arguments_]=process.argv.slice(2);
if(!command||!configPath||!path.isAbsolute(configPath))throw Error('Usage: codexia-updater <verify-legacy|verify-bootstrap|verify-cutover-backup|verify-maintenance-backup|cutover|recover-cutover|initialize-schema|init-fresh|init|recover-initial|boot|tick|status|verify|pause|resume|maintain|backup|rollback|acceptance-update|acceptance-rollback> /absolute/config.json [arguments]');
let config=JSON.parse(await readFile(configPath,'utf8'));
assert.equal(config.format,'codexia-standalone-updater/v1');
assert.ok(path.isAbsolute(config.stateFile)&&path.isAbsolute(config.publicKeyFile));
assert.equal(path.dirname(config.routeFile),path.dirname(config.stateFile),'Route and state must share the protected host state directory');
assert.equal(path.basename(config.routeFile),'route');
assert.equal(path.dirname(config.stateFile),process.env.CODEXIA_UPDATER_LOCK_DIRECTORY,'Use the host-wide locked wrapper');
const publicKey=await readFile(config.publicKeyFile,'utf8');
const backupIntentFile=path.join(path.dirname(config.stateFile),'backup-intent.json');
const backupRecoveryFile=path.join(path.dirname(config.stateFile),'backup-recovery.json');
const cutoverFile=path.join(path.dirname(config.stateFile),'legacy-cutover.json');
const freshSchemaProofFile=path.join(path.dirname(config.stateFile),'fresh-schema.json');
const store={
  loadFreshSchema:()=>readPrivateProof(freshSchemaProofFile).then(validateFreshSchemaProof).catch(error=>{if(error.code==='ENOENT')return null;throw error;}),
  saveFreshSchema:proof=>atomicWrite(freshSchemaProofFile,JSON.stringify(validateFreshSchemaProof(proof))+'\n'),
  loadState:()=>loadControllerState(config.stateFile).catch(error=>{if(error.code==='ENOENT')return null;throw error;}),
  loadCutover:()=>readPrivateProof(cutoverFile,256*1024).then(validateLegacyCutover).catch(error=>{if(error.code==='ENOENT')return null;throw error;}),
  saveCutover:intent=>atomicWrite(cutoverFile,JSON.stringify(validateLegacyCutover(intent))+'\n'),
  clearCutover:()=>clearBackupIntent(cutoverFile),
  save:state=>atomicWrite(config.stateFile,JSON.stringify(state)+'\n'),
  saveBackupIntent:intent=>atomicWrite(backupIntentFile,JSON.stringify(intent)+'\n'),
  loadBackupIntent:()=>loadBackupIntent(backupIntentFile),
  clearBackupIntent:()=>clearBackupIntent(backupIntentFile),
  saveBackupRecoveryIntent:intent=>atomicWrite(backupRecoveryFile,JSON.stringify(intent)+'\n'),
  loadBackupRecoveryIntent:()=>loadBackupIntent(backupRecoveryFile),
  clearBackupRecoveryIntent:()=>clearBackupIntent(backupRecoveryFile),
};
const legacyBackupProofFile=path.join(path.dirname(config.stateFile),'legacy-backup-proof.json');
const controllerBackupProofFile=path.join(path.dirname(config.stateFile),'controller-backup-proof.json');
async function readPrivateProof(filename,limit=65536){
  const metadata=await lstat(filename);
  assert.ok(metadata.isFile()&&!metadata.isSymbolicLink()&&(metadata.mode&0o777)===0o600&&metadata.size<=limit,'Backup evidence must be a private regular file');
  if(typeof process.getuid==='function')assert.equal(metadata.uid,process.getuid(),'Backup evidence owner differs from the service user');
  return JSON.parse(await readFile(filename,'utf8'));
}
const maintenanceMarker=path.join(path.dirname(config.stateFile),'maintenance','in-progress.json');
const pendingCutover=await store.loadCutover();
if(pendingCutover)assert.ok(['boot','recover-cutover'].includes(command),'Interrupted legacy cutover must recover before other operations');
const pendingMaintenance=await lstat(maintenanceMarker).then(()=>true,error=>{if(error.code==='ENOENT')return false;if(command==='boot'||command==='maintain')return true;throw error;});
if(pendingMaintenance){
  assert.equal(pendingCutover,null,'Simultaneous cutover and maintenance intents require operator repair');
  assert.equal(await store.loadBackupIntent(),null,'Simultaneous backup and maintenance intents require operator repair');
  assert.equal(await store.loadBackupRecoveryIntent(),null,'Simultaneous backup recovery and maintenance intents require operator repair');
  if(command==='verify'){
    // Rollback verification runs the exact captured old entrypoint under the
    // parent controller's lock, while the durable recovery marker still exists.
    await assertMaintenanceSnapshotVerifier({config,configPath,entry:fileURLToPath(import.meta.url)});
  }else assert.ok(command==='boot'||command==='maintain','Pending runtime maintenance requires recovery before other operations');
}
if(command==='boot'){
  const recovered=await recoverInterruptedMaintenance({config,store,publicKey});
  if(recovered)config=JSON.parse(await readFile(configPath,'utf8'));
}
const host=new PodmanStandaloneHost(config);
if(command!=='maintain')await host.assertRuntimeSources();
const controller=new StandaloneController({host,store,publicKey,observeMilliseconds:config.observeMilliseconds??300000});
if(command==='recover-cutover'||(command==='boot'&&pendingCutover)){
  assert.equal(arguments_.length,0);
  assert.equal(config.enabled,false,'Legacy cutover recovery requires disabled polling');
  if(!pendingCutover){console.log(JSON.stringify({recovered:false}));process.exit(0);}
  const state=await controller.recoverLegacyCutover(await store.loadState(),pendingCutover);
  console.log(JSON.stringify({recovered:true,initialized:state!==null}));
  process.exit(0);
}else if(command==='cutover'){
  assert.equal(arguments_.length,3,'Provide exact signed legacy release, isolated restore receipt and --approved');
  const [releaseFile,receiptFile,approval]=arguments_;
  assert.ok(path.isAbsolute(releaseFile)&&path.isAbsolute(receiptFile)&&approval==='--approved','Legacy cutover requires explicit approval');
  assert.equal(config.enabled,false,'Legacy cutover requires disabled polling');
  const release=validateUpdateRelease(JSON.parse(await readFile(releaseFile,'utf8')));
  const source=validateLegacyBackupProof(await readPrivateProof(legacyBackupProofFile));
  const restore=await readPrivateProof(receiptFile);
  const state=await controller.cutoverLegacy(release,config.initialSlot??'blue',source,restore);
  console.log(JSON.stringify({format:'codexia-legacy-cutover/v1',activated:true,slot:state.journal.active.slot}));
  process.exit(0);
}else if(command==='backup'){
  if(arguments_.at(-1)!=='--approved')throw new Error('Backup requires the explicit --approved maintenance attestation');
  const backupArguments=arguments_.slice(0,-1);
  let state;
  try{state=await loadControllerState(config.stateFile);}catch(error){if(error.code!=='ENOENT')throw error;}
  state=await controller.recoverBackupIntent(state??null);
  let result;
  if(state){
    assert.ok(!state.initialActivationPending,'Recover initial activation before backup');
    assert.equal(backupArguments.length,2,'Initialized backup usage: backup /absolute/config.json /absolute/remote/destination age1-recipient --approved');
    const databaseId=await host.freshDatabaseIdentity();
    result=await controller.backup(state,{destination:backupArguments[0],recipient:backupArguments[1]});
    assert.deepEqual(result.state.journal,state.journal,'Backup recovery changed the controller journal');
    assert.deepEqual(result.state.installed,state.installed,'Backup recovery changed the installed release');
    assert.equal(await host.freshDatabaseIdentity(),databaseId,'Database identity changed during backup');
    const publication=await verifyBackupPublication(result.output,backupArguments[0],host);
    const proof=validateControllerBackupProof({format:'codexia-controller-backup-proof/v1',release:state.installed,
      journalGeneration:state.journal.generation,databaseId,...publication});
    await atomicWrite(controllerBackupProofFile,JSON.stringify(proof)+'\n');
  }else{
    assert.equal(backupArguments.length,3,'Legacy backup usage: backup /absolute/config.json /absolute/signed-release.json /absolute/remote/destination age1-recipient --approved');
    assert.ok(path.isAbsolute(backupArguments[0]),'Explicit signed legacy release JSON is required before controller initialization');
    const release=validateUpdateRelease(JSON.parse(await readFile(backupArguments[0],'utf8')));
    result=await controller.backupLegacy(release,{destination:backupArguments[1],recipient:backupArguments[2]});
    // A successful locked backup AND identity-preserving recovery is required.
    const publication=await verifyBackupPublication(result.output,backupArguments[1],host);
    const proof=validateLegacyBackupProof({format:'codexia-legacy-backup-proof/v1',release,...publication});
    await atomicWrite(legacyBackupProofFile,JSON.stringify(proof)+'\n');
  }
  console.log(result.output);
  process.exit(0);
}else if(command==='verify-maintenance-backup'){
  assert.equal(arguments_.length,1,'Provide the isolated restore receipt');
  assert.ok(path.isAbsolute(arguments_[0]),'An absolute receipt path is required');
  await controller.assertNoBackupIntent();
  const state=await loadControllerState(config.stateFile);
  const proof=validateControllerBackupProof(await readPrivateProof(controllerBackupProofFile));
  const receipt=await readPrivateProof(arguments_[0]);
  const databaseId=await host.freshDatabaseIdentity();
  assertMatchingControllerBackup(proof,receipt,state,databaseId,await host.backupArtifactIdentity(proof.artifactDirectory));
  await host.verifyWriterUnits(state);
  await controller.assertServing(state,state.journal.active.slot,state.installed);
  console.log(JSON.stringify({format:'codexia-controller-backup-verification/v1',verified:true,checksumManifestSha256:proof.checksumManifestSha256}));
  process.exit(0);
}else if(command==='verify-cutover-backup'){
  assert.equal(arguments_.length,2,'Provide the selected legacy release and isolated restore receipt');
  assert.ok(arguments_.every(file=>path.isAbsolute(file)),'Absolute evidence paths are required');
  assert.equal(config.enabled,false,'Initial cutover requires disabled polling');
  try{await loadControllerState(config.stateFile);throw Error('Existing controller cannot use legacy cutover evidence');}catch(error){if(error.code!=='ENOENT')throw error;}
  await controller.assertNoBackupIntent();
  const release=validateUpdateRelease(JSON.parse(await readFile(arguments_[0],'utf8')));
  const source=validateLegacyBackupProof(await readPrivateProof(legacyBackupProofFile));
  const restore=await readPrivateProof(arguments_[1]);
  assertMatchingCutoverBackup(source,restore,release,source.checksumManifestSha256);
  const observed=await host.backupArtifactIdentity(source.artifactDirectory);
  assertMatchingCutoverBackup(source,restore,release,observed);
  await host.assertLegacyBackupRelease(release);
  console.log('Verified off-VM legacy backup and matching isolated restore receipt');
  process.exit(0);
}else if(command==='verify-legacy'||command==='verify-bootstrap'){
  const [legacyFile,candidateFile]=arguments_;
  assert.equal(arguments_.length,command==='verify-bootstrap'?2:1,'Provide the exact signed release record(s)');
  assert.ok(arguments_.every(file=>path.isAbsolute(file)),'Absolute signed release record paths are required');
  assert.equal(config.enabled,false,'Initial candidate preflight requires disabled polling');
  try{await loadControllerState(config.stateFile);throw Error('Existing state cannot be initialized again');}catch(error){if(error.code!=='ENOENT')throw error;}
  const legacy=validateUpdateRelease(JSON.parse(await readFile(legacyFile,'utf8')));
  const candidate=command==='verify-bootstrap'?validateUpdateRelease(JSON.parse(await readFile(candidateFile,'utf8'))):legacy;
  if(command==='verify-bootstrap')assert.notEqual(legacy.image,candidate.image,'Explicit bootstrap requires a distinct candidate');
  const result=await controller.verifyInitialCandidate(legacy,candidate);
  console.log(JSON.stringify(result));
  process.exit(0);
}else if(command==='initialize-schema'){
  assert.equal(arguments_.length,2,'Provide an exact signed release record and --approved');
  const [releaseFile,approval]=arguments_;
  assert.ok(path.isAbsolute(releaseFile)&&approval==='--approved','Fresh schema initialization requires explicit approval');
  assert.equal(config.enabled,false,'Fresh schema initialization requires disabled polling');
  try{await loadControllerState(config.stateFile);throw Error('Existing controller cannot initialize a fresh schema');}catch(error){if(error.code!=='ENOENT')throw error;}
  const release=validateUpdateRelease(JSON.parse(await readFile(releaseFile,'utf8')));
  const result=await controller.initializeFreshSchema(release);
   console.log(JSON.stringify(result));
  process.exit(0);
}else if(command==='init-fresh'){
  assert.equal(arguments_.length,2,'Provide the exact schema-initialized release record and --approved');
  const [releaseFile,approval]=arguments_;
  assert.ok(path.isAbsolute(releaseFile)&&approval==='--approved','Fresh activation requires explicit approval');
  assert.equal(config.enabled,false,'Fresh activation requires disabled polling');
  const release=validateUpdateRelease(JSON.parse(await readFile(releaseFile,'utf8')));
   let existing=null;
  try{existing=await loadControllerState(config.stateFile);}catch(error){if(error.code!=='ENOENT')throw error;}
  const state=await controller.activateFresh(release,config.initialSlot??'blue',existing);
  if(state.initialActivationPending||state.lastError)throw Error(state.lastError??'Fresh activation remains pending');
  console.log(JSON.stringify({format:'codexia-fresh-activation/v1',image:state.installed.image,slot:state.journal.active.slot,activated:true,publicHandoff:false,changed:!existing||existing.initialActivationPending===true}));
  process.exit(0);
}else if(command==='init'){
  const [argument]=arguments_;
  assert.equal(arguments_.length,1,'Provide exactly one signed installed release JSON');
  assert.ok(argument&&path.isAbsolute(argument),'Explicit trusted installed release JSON is required');
  try{await loadControllerState(config.stateFile);throw Error('Existing state cannot be initialized again');}catch(error){if(error.code!=='ENOENT')throw error;}
  await controller.recoverBackupIntent(null);
  assert.equal(config.enabled,false,'Initial activation requires disabled polling');
  assert.equal(await host.pollingTimerActive(),false,'Initial activation requires stopped polling');
  const release=validateUpdateRelease(JSON.parse(await readFile(argument,'utf8')));
  const channel=verifyUpdateChannel(await host.fetchChannel(),publicKey,null);
  assert.ok(channel.payload.releases.some(r=>r.state==='published'&&JSON.stringify(r)===JSON.stringify(release)),'Installed release must be in trusted signed channel');
  await host.pullAndVerify(release);
  await controller.uiEpoch(release);
  const slot=config.initialSlot??'blue';
  await host.assertInitialLegacyAbsent();
  const observed=await host.observe();
  assert.equal(observed.writers.length,0,'Initialize only after the legacy writer is drained and removed');
  // Persist the trusted installed identity before any service activation.
  assert.equal(observed.route,'blocked','Initial activation requires a blocked route');
  await host.assertNoPreflight();
  let state=await controller.save({...initialControllerState(release,slot,channel.checkpoint),initialActivationPending:true,initialActivationId:randomUUID()});
  state=await controller.reconcile(state,{boot:true});
  console.log(JSON.stringify(state,null,2));
  if(state.lastError)process.exitCode=1;
}else if(command==='recover-initial'){
  assert.equal(arguments_.length,0);
  const state=await loadControllerState(config.stateFile);
  if(!state.initialActivationPending){console.log(JSON.stringify({recovered:false}));process.exit(0);}
  assert.equal(config.enabled,false,'Initial activation recovery requires disabled polling');
  const recovered=await controller.reconcile(state,{boot:true});
  if(recovered.initialActivationPending||recovered.lastError)throw Error(recovered.lastError??'Initial activation remains pending');
  console.log(JSON.stringify({recovered:true}));
  process.exit(0);
}else if(command==='maintain'){
  assert.equal(arguments_.length,1,'Provide exactly one staged maintenance manifest');
  const [argument]=arguments_;
  assert.ok(path.isAbsolute(argument),'An absolute staged maintenance manifest is required');
  assert.equal(await controller.loadBackupIntent(),null,'Pending backup recovery prevents runtime maintenance');
  const state=await loadControllerState(config.stateFile);
  assert.ok(!state.initialActivationPending,'Recover initial activation before runtime maintenance');
  const result=await maintainStandaloneUpdater({config,manifestPath:argument,publicKey,state,store});
  console.log(JSON.stringify(result));
  process.exit(0);
}else{
  assert.equal(arguments_.length,0,'This controller command does not accept positional arguments');
  let state;
  try{state=await loadControllerState(config.stateFile);}catch(error){if(command!=='boot'||error.code!=='ENOENT')throw error;}
  if(state?.initialActivationPending&&command!=='boot'&&command!=='status')throw Error('Recover initial activation before ordinary lifecycle operations');
  if(command==='boot'){
    if(state?.initialActivationPending)assert.equal(config.enabled,false,'Initial activation recovery requires disabled polling');
    state=await controller.recoverBackupIntent(state??null);
    if(!state){console.log('No controller state or interrupted backup recovery intent; legacy runtime unchanged');process.exit(0);}
    state=await controller.reconcile(state,{boot:true});
  }
  else if(command==='status'){console.log(JSON.stringify({state,backupIntent:await controller.loadBackupIntent(),observed:await host.observe()},null,2));process.exit(0);}
  else if(command==='verify'){
    assert.equal(await controller.loadBackupIntent(),null,'Pending backup recovery prevents service verification');
    assert.ok(['idle','committed'].includes(state.journal.phase),'Unreconciled journal requires operator repair');
    assert.equal(state.lastError,null,'Controller has a recorded error');
    await host.verifyWriterUnits(state);
    await controller.assertServing(state,state.journal.active.slot,state.installed);
    console.log(JSON.stringify({state,observed:await host.observe()},null,2));
    process.exit(0);
  }
  else if(command==='pause'){
    state=await controller.recoverBackupIntent(state);
    state=await controller.save({...state,paused:true});
  }
  else if(command==='resume'){
    state=await controller.recoverBackupIntent(state);
    state=await controller.reconcile(state);
    await controller.assertServing(state,state.journal.active.slot,state.installed);
    assert.ok(['idle','committed'].includes(state.journal.phase),'Unreconciled journal requires operator repair');
    state=await controller.save({...state,paused:false,lastError:null});
  }else if(command==='tick'){
    if(config.enabled!==true)process.exit(0);
    state=await controller.recoverBackupIntent(state);
    state=await controller.tick(state);
  }else if(command==='acceptance-update'||command==='acceptance-rollback'){
    state=await controller.recoverBackupIntent(state);
    assert.equal(config.enabled,false,'Acceptance exercises require automatic updates disabled');
    assert.equal(state.paused,true,'Acceptance exercises require a paused controller');
    assert.ok(['idle','committed'].includes(state.journal.phase),'Unreconciled journal requires operator repair');
    const rollback=command==='acceptance-rollback';
    const before=state.installed.image;
    const previous=state.previous?.image;
    if(rollback)assert.ok(previous,'First exercise an approved compatible update');
    await controller.assertServing(state,state.journal.active.slot,state.installed);
    state=await controller.tick(state,{manualRollback:rollback,manualAcceptance:true});
    assert.equal(state.paused,true,'Acceptance must preserve pause');
    if(state.lastError)throw Error(state.lastError);
    assert.notEqual(state.installed.image,before,'No compatible release was activated');
    if(rollback)assert.equal(state.installed.image,previous,'Previous release was not restored');
  }else if(command==='rollback'){
    assert.equal(config.enabled,true,'Operator must enable update controller');
    state=await controller.recoverBackupIntent(state);
    state=await controller.tick(state,{manualRollback:true});
  }else throw Error('Unknown controller command');
  console.log(JSON.stringify(state,null,2));
  if(state.lastError)process.exitCode=1;
}
