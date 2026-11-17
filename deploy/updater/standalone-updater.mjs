import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { atomicWrite, clearBackupIntent, initialControllerState, loadBackupIntent, loadControllerState, StandaloneController } from '../../scripts/standalone-update-controller.mjs';
import { PodmanStandaloneHost } from './standalone-host.mjs';
import { verifyUpdateChannel } from '../../scripts/update-channel.mjs';
import { validateUpdateRelease } from '../../scripts/update-release-policy.mjs';
import { assertMaintenanceSnapshotVerifier, maintainStandaloneUpdater, recoverInterruptedMaintenance } from './standalone-maintenance.mjs';

const [command,configPath,...arguments_]=process.argv.slice(2);
if(!command||!configPath||!path.isAbsolute(configPath))throw Error('Usage: codexia-updater <verify-legacy|verify-bootstrap|init|boot|tick|status|verify|pause|resume|maintain|backup|rollback|acceptance-update|acceptance-rollback> /absolute/config.json [arguments]');
let config=JSON.parse(await readFile(configPath,'utf8'));
assert.equal(config.format,'codexia-standalone-updater/v1');
assert.ok(path.isAbsolute(config.stateFile)&&path.isAbsolute(config.publicKeyFile));
assert.equal(path.dirname(config.routeFile),path.dirname(config.stateFile),'Route and state must share the protected host state directory');
assert.equal(path.basename(config.routeFile),'route');
assert.equal(path.dirname(config.stateFile),process.env.CODEXIA_UPDATER_LOCK_DIRECTORY,'Use the host-wide locked wrapper');
const publicKey=await readFile(config.publicKeyFile,'utf8');
const backupIntentFile=path.join(path.dirname(config.stateFile),'backup-intent.json');
const backupRecoveryFile=path.join(path.dirname(config.stateFile),'backup-recovery.json');
const store={
  save:state=>atomicWrite(config.stateFile,JSON.stringify(state)+'\n'),
  saveBackupIntent:intent=>atomicWrite(backupIntentFile,JSON.stringify(intent)+'\n'),
  loadBackupIntent:()=>loadBackupIntent(backupIntentFile),
  clearBackupIntent:()=>clearBackupIntent(backupIntentFile),
  saveBackupRecoveryIntent:intent=>atomicWrite(backupRecoveryFile,JSON.stringify(intent)+'\n'),
  loadBackupRecoveryIntent:()=>loadBackupIntent(backupRecoveryFile),
  clearBackupRecoveryIntent:()=>clearBackupIntent(backupRecoveryFile),
};
const maintenanceMarker=path.join(path.dirname(config.stateFile),'maintenance','in-progress.json');
const pendingMaintenance=await lstat(maintenanceMarker).then(()=>true,error=>{if(error.code==='ENOENT')return false;if(command==='boot'||command==='maintain')return true;throw error;});
if(pendingMaintenance){
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
if(command==='backup'){
  if(arguments_.at(-1)!=='--approved')throw new Error('Backup requires the explicit --approved maintenance attestation');
  const backupArguments=arguments_.slice(0,-1);
  let state;
  try{state=await loadControllerState(config.stateFile);}catch(error){if(error.code!=='ENOENT')throw error;}
  state=await controller.recoverBackupIntent(state??null);
  let result;
  if(state){
    assert.equal(backupArguments.length,2,'Initialized backup usage: backup /absolute/config.json /absolute/remote/destination age1-recipient --approved');
    result=await controller.backup(state,{destination:backupArguments[0],recipient:backupArguments[1]});
  }else{
    assert.equal(backupArguments.length,3,'Legacy backup usage: backup /absolute/config.json /absolute/signed-release.json /absolute/remote/destination age1-recipient --approved');
    assert.ok(path.isAbsolute(backupArguments[0]),'Explicit signed legacy release JSON is required before controller initialization');
    result=await controller.backupLegacy(JSON.parse(await readFile(backupArguments[0],'utf8')),{destination:backupArguments[1],recipient:backupArguments[2]});
  }
  console.log(result.output);
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
}else if(command==='init'){
  const [argument]=arguments_;
  assert.equal(arguments_.length,1,'Provide exactly one signed installed release JSON');
  assert.ok(argument&&path.isAbsolute(argument),'Explicit trusted installed release JSON is required');
  try{await loadControllerState(config.stateFile);throw Error('Existing state cannot be initialized again');}catch(error){if(error.code!=='ENOENT')throw error;}
  await controller.recoverBackupIntent(null);
  const release=validateUpdateRelease(JSON.parse(await readFile(argument,'utf8')));
  const channel=verifyUpdateChannel(await host.fetchChannel(),publicKey,null);
  assert.ok(channel.payload.releases.some(r=>r.state==='published'&&JSON.stringify(r)===JSON.stringify(release)),'Installed release must be in trusted signed channel');
  await host.pullAndVerify(release);
  await controller.uiEpoch(release);
  const slot=config.initialSlot??'blue';
  const observed=await host.observe();
  assert.equal(observed.writers.length,0,'Initialize only after the legacy writer is drained and removed');
  // Persist the trusted installed identity before any service activation.
  let state=await controller.save(initialControllerState(release,slot,channel.checkpoint));
  state=await controller.reconcile(state,{boot:true});
  console.log(JSON.stringify(state,null,2));
  if(state.lastError)process.exitCode=1;
}else if(command==='maintain'){
  assert.equal(arguments_.length,1,'Provide exactly one staged maintenance manifest');
  const [argument]=arguments_;
  assert.ok(path.isAbsolute(argument),'An absolute staged maintenance manifest is required');
  assert.equal(await controller.loadBackupIntent(),null,'Pending backup recovery prevents runtime maintenance');
  const state=await loadControllerState(config.stateFile);
  const result=await maintainStandaloneUpdater({config,manifestPath:argument,publicKey,state,store});
  console.log(JSON.stringify(result));
  process.exit(0);
}else{
  assert.equal(arguments_.length,0,'This controller command does not accept positional arguments');
  let state;
  try{state=await loadControllerState(config.stateFile);}catch(error){if(command!=='boot'||error.code!=='ENOENT')throw error;}
  if(command==='boot'){
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
