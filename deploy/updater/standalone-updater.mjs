import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { atomicWrite, initialControllerState, loadControllerState, StandaloneController } from '../../scripts/standalone-update-controller.mjs';
import { PodmanStandaloneHost } from './standalone-host.mjs';
import { verifyUpdateChannel } from '../../scripts/update-channel.mjs';
import { validateUpdateRelease } from '../../scripts/update-release-policy.mjs';
import { maintainStandaloneUpdater } from './standalone-maintenance.mjs';

const [command,configPath,argument]=process.argv.slice(2);
if(!command||!configPath||!path.isAbsolute(configPath))throw Error('Usage: codexia-updater <verify-legacy|init|boot|tick|status|verify|pause|resume|maintain|rollback|acceptance-update|acceptance-rollback> /absolute/config.json [argument]');
const config=JSON.parse(await readFile(configPath,'utf8'));
assert.equal(config.format,'codexia-standalone-updater/v1');
assert.ok(path.isAbsolute(config.stateFile)&&path.isAbsolute(config.publicKeyFile));
assert.equal(path.dirname(config.routeFile),path.dirname(config.stateFile),'Route and state must share the protected host state directory');
assert.equal(path.basename(config.routeFile),'route');
assert.equal(path.dirname(config.stateFile),process.env.CODEXIA_UPDATER_LOCK_DIRECTORY,'Use the host-wide locked wrapper');
const publicKey=await readFile(config.publicKeyFile,'utf8');
const host=new PodmanStandaloneHost(config);
await host.assertRuntimeSources();
const store={save:state=>atomicWrite(config.stateFile,JSON.stringify(state)+'\n')};
const controller=new StandaloneController({host,store,publicKey,observeMilliseconds:config.observeMilliseconds??300000});
if(command==='init'||command==='verify-legacy'){
  assert.ok(argument&&path.isAbsolute(argument),'Explicit trusted installed release JSON is required');
  try{await loadControllerState(config.stateFile);throw Error('Existing state cannot be initialized again');}catch(error){if(error.code!=='ENOENT')throw error;}
  const release=validateUpdateRelease(JSON.parse(await readFile(argument,'utf8')));
  const channel=verifyUpdateChannel(await host.fetchChannel(),publicKey,null);
  assert.ok(channel.payload.releases.some(r=>r.state==='published'&&JSON.stringify(r)===JSON.stringify(release)),'Installed release must be in trusted signed channel');
  await host.pullAndVerify(release);
  await controller.uiEpoch(release);
  if(command==='verify-legacy'){
    await host.assertLegacyRelease(release);
    console.log('Verified running legacy release and browser authentication');
    process.exit(0);
  }
  const slot=config.initialSlot??'blue';
  const observed=await host.observe();
  assert.equal(observed.writers.length,0,'Initialize only after the legacy writer is drained and removed');
  // Persist the trusted installed identity before any service activation.
  let state=await controller.save(initialControllerState(release,slot,channel.checkpoint));
  state=await controller.reconcile(state,{boot:true});
  console.log(JSON.stringify(state,null,2));
  if(state.lastError)process.exitCode=1;
}else{
  let state=await loadControllerState(config.stateFile);
  if(command==='boot')state=await controller.reconcile(state,{boot:true});
  else if(command==='status'){console.log(JSON.stringify({state,observed:await host.observe()},null,2));process.exit(0);}
  else if(command==='verify'){
    assert.ok(['idle','committed'].includes(state.journal.phase),'Unreconciled journal requires operator repair');
    assert.equal(state.lastError,null,'Controller has a recorded error');
    await host.verifyWriterUnits(state);
    await controller.assertServing(state,state.journal.active.slot,state.installed);
    console.log(JSON.stringify({state,observed:await host.observe()},null,2));
    process.exit(0);
  }
  else if(command==='maintain'){
    assert.ok(argument&&path.isAbsolute(argument),'An absolute staged maintenance manifest is required');
    const result=await maintainStandaloneUpdater({config,manifestPath:argument,publicKey,state,store});
    console.log(JSON.stringify(result));
    process.exit(0);
  }
  else if(command==='pause')state=await controller.save({...state,paused:true});
  else if(command==='resume'){
    state=await controller.reconcile(state);
    await controller.assertServing(state,state.journal.active.slot,state.installed);
    assert.ok(['idle','committed'].includes(state.journal.phase),'Unreconciled journal requires operator repair');
    state=await controller.save({...state,paused:false,lastError:null});
  }else if(command==='tick'){
    if(config.enabled!==true)process.exit(0);
    state=await controller.tick(state);
  }else if(command==='acceptance-update'||command==='acceptance-rollback'){
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
    state=await controller.tick(state,{manualRollback:true});
  }else throw Error('Unknown controller command');
  console.log(JSON.stringify(state,null,2));
  if(state.lastError)process.exitCode=1;
}
