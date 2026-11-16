import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, loadControllerState, StandaloneController } from '../../scripts/standalone-update-controller.mjs';
import { PodmanStandaloneHost, validateRuntimeContract } from './standalone-host.mjs';

export const MAINTENANCE_SOURCE_FILES = Object.freeze([
  'deploy/updater/codexia-updater',
  'deploy/updater/standalone-updater.mjs',
  'deploy/updater/standalone-host.mjs',
  'deploy/updater/standalone-maintenance.mjs',
  'deploy/updater/proxy.mjs',
  'deploy/updater/standalone-backup.sh',
  'scripts/standalone-update-controller.mjs',
  'scripts/update-host-state.mjs',
  'scripts/update-channel.mjs',
  'scripts/update-release-policy.mjs',
]);
export const MAINTENANCE_UNIT_FILES = Object.freeze([
  'codexia-updater-boot.service',
  'codexia-updater.service',
  'codexia-updater.timer',
]);

function plainObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}

export function validateMaintenanceConfig(current,candidate){
  assert.ok(plainObject(current)&&plainObject(candidate),'Maintenance configuration must be an object');
  assert.equal(typeof current.enabled,'boolean','Current update enabled state is unobservable');
  assert.equal(typeof candidate.enabled,'boolean','Candidate update enabled state is invalid');
  assert.ok(Number.isSafeInteger(current.observeMilliseconds),'Current updater observation interval is invalid');
  assert.ok(Number.isSafeInteger(candidate.observeMilliseconds)&&candidate.observeMilliseconds>=60000&&candidate.observeMilliseconds<=3600000,'Candidate observation interval must be 60 seconds–60 minutes');
  if(current.runtime!==undefined)assert.ok(candidate.runtime!==undefined,'Maintenance cannot remove the typed runtime contract');
  if(candidate.runtime!==undefined){
    validateRuntimeContract(candidate.runtime);
    if(current.runtime!==undefined)assert.equal(candidate.runtime.profile,current.runtime.profile,'Runtime profile changes require a compatible signed release transition');
  }
  // A first Phase C maintenance run may adopt the typed contract only after
  // the running writer has been observed against it below.
  const normalizedCurrent={...current,observeMilliseconds:candidate.observeMilliseconds,runtime:candidate.runtime??current.runtime};
  const normalizedCandidate={...candidate,enabled:current.enabled};
  assert.deepEqual(normalizedCandidate,normalizedCurrent,'Maintenance cannot change release trust, browser authentication, runtime, host paths, or other controller identity');
  return normalizedCandidate;
}
export function assertProxyImageStable(currentText,candidateText){
  const images=text=>[...text.matchAll(/^Image=(\S+)$/gmu)].map(match=>match[1]);
  const current=images(currentText),candidate=images(candidateText);
  assert.equal(current.length,1,'Current proxy image identity is unobservable');
  assert.equal(candidate.length,1,'Candidate proxy image identity is unobservable');
  assert.match(current[0],/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u,'Current proxy image is not digest pinned');
  assert.equal(candidate[0],current[0],'A proxy image change requires its own reviewed transition');
}

export function assertNoDropInPaths(value){
  assert.equal(typeof value,'string','Systemd unit override paths are unobservable');
  assert.equal(value.trim(),'','Systemd unit drop-ins are not part of the reviewed updater contract');
}

export async function activateProxyRevision({changed,restart,verify}){
  assert.equal(typeof changed,'boolean','Proxy revision change state is unobservable');
  assert.equal(typeof restart,'function','Proxy restart operation is unavailable');
  assert.equal(typeof verify,'function','Proxy verification operation is unavailable');
  if(!changed)return false;
  await restart();
  await verify();
  return true;
}

export async function transitionRuntimeWriter({currentHost,targetHost,slot,release,state,verify}){
  assert.ok(['blue','green'].includes(slot),'Runtime maintenance writer slot is invalid');
  assert.equal(state?.journal?.active?.slot,slot,'Runtime maintenance must preserve the committed writer slot');
  assert.equal(typeof verify,'function','Runtime maintenance verification is unavailable');
  await targetHost.route('blocked');
  await currentHost.stopWriter(slot);
  await targetHost.convergeWriterUnits(state);
  await targetHost.startWriter(slot,release);
  await targetHost.route(slot);
  try{await verify();}catch(error){await targetHost.route('blocked').catch(()=>undefined);throw error;}
}

export async function preflightMaintenanceRuntime({currentConfig,nextConfig,currentHost,candidateHost,currentController,candidateController,state,activeSlot}){
  const adoptingRuntime=currentConfig.runtime===undefined&&nextConfig.runtime!==undefined;
  const observedHost=adoptingRuntime?candidateHost:currentHost;
  const observedController=adoptingRuntime?candidateController:currentController;
  await observedHost.verifyWriterUnits(state);
  await observedController.assertServing(state,activeSlot,state.installed);
  return adoptingRuntime;
}

async function restartProxyService(){
  assertNoDropInPaths(run('systemctl',['--user','show','--property=DropInPaths','--value','codexia-api-proxy.service']));
  run('systemctl',['--user','restart','codexia-api-proxy.service'],{timeout:120000});
  assert.equal(run('systemctl',['--user','show','--property=ActiveState','--value','codexia-api-proxy.service']),'active','Private proxy did not become active after maintenance restart');
}

export function timerActivationCommand(expected){
  assert.ok(expected&&['active','inactive'].includes(expected.active),'Updater timer active state is invalid');
  assert.ok(['enabled','disabled'].includes(expected.enabled),'Updater timer enabled state is invalid');
  return expected.active==='active'?'start':'stop';
}

function run(binary,args){
  try{return execFileSync(binary,args,{encoding:'utf8',timeout:120000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']}).trim();}
  catch(error){throw new Error(binary+' '+args[0]+' failed (status '+String(error.status??'unknown')+')');}
}
function commandState(args,accepted){
  const result=spawnSync('systemctl',args,{encoding:'utf8',timeout:15000});
  const value=result.stdout.trim();
  assert.ok(accepted.includes(value),'Systemd state is not safely observable: '+args.join(' '));
  if(result.status!==0)assert.ok(args[1]==='is-active'&&['inactive','failed'].includes(value)||args[1]==='is-enabled'&&['disabled'].includes(value),'Systemd state query failed: '+args.join(' '));
  return value;
}
function timerState(){
  return {
    active:commandState(['--user','is-active','codexia-updater.timer'],['active','inactive']),
    enabled:commandState(['--user','is-enabled','codexia-updater.timer'],['enabled','disabled']),
  };
}
function assertTimerState(expected){
  assert.deepEqual(timerState(),expected,'Maintenance changed updater timer activation');
}
function updaterServiceState(){
  return commandState(['--user','is-active','codexia-updater.service'],['active','inactive','failed']);
}
function assertNoActiveUpdaterService(){
  const observed=updaterServiceState();
  if(observed==='failed')run('systemctl',['--user','reset-failed','codexia-updater.service']);
  assert.equal(updaterServiceState(),'inactive','Updater poll service is not idle under the maintenance lock');
}
async function stopTimerPolling(){
  run('systemctl',['--user','stop','codexia-updater.timer']);
  assertNoActiveUpdaterService();
  assert.equal(timerState().active,'inactive','Updater timer did not suspend polling');
}
async function restoreTimerPolling(expected){
  run('systemctl',['--user',timerActivationCommand(expected),'codexia-updater.timer']);
  assertNoActiveUpdaterService();
  assertTimerState(expected);
}
async function keepTimerStopped(){
  run('systemctl',['--user','stop','codexia-updater.timer']);
  const observed=updaterServiceState();
  if(observed==='failed')run('systemctl',['--user','reset-failed','codexia-updater.service']);
}
function withPause(state,paused){return {...state,paused};}
function withoutPause(state){
  const copy={...state};delete copy.paused;return copy;
}
async function readRegularFile(filename,{required=true}={}){
  let observed;
  try{observed=await lstat(filename);}catch(error){
    if(error.code==='ENOENT'&&!required)return null;
    throw error;
  }
  assert.ok(observed.isFile()&&!observed.isSymbolicLink(),'Maintenance target must be a regular non-symlink file');
  assert.equal(observed.mode&0o777,0o600,'Maintenance target permissions drift');
  if(typeof process.getuid==='function')assert.equal(observed.uid,process.getuid(),'Maintenance target owner drift');
  const parent=path.dirname(filename);
  assert.equal(await realpath(parent),path.resolve(parent),'Maintenance target parent cannot traverse a symlink');
  return await readFile(filename,'utf8');
}
async function readCandidate(root,relative){
  assert.ok(!path.isAbsolute(relative)&&!relative.split(path.sep).includes('..'),'Candidate path escapes its staging root');
  const filename=path.join(root,relative);
  assert.ok(filename.startsWith(root+path.sep),'Candidate path escapes its staging root');
  const observed=await lstat(filename);
  assert.ok(observed.isFile()&&!observed.isSymbolicLink(),'Candidate file must be a regular non-symlink file');
  assert.equal(observed.mode&0o777,0o600,'Candidate file permissions drift');
  assert.equal(await realpath(filename),filename,'Candidate file cannot traverse a symlink');
  return await readFile(filename,'utf8');
}
async function assertUnitLoaded(unitName,expectedPath){
  const observed=run('systemctl',['--user','show','--property=FragmentPath','--value',unitName]);
  assert.equal(path.resolve(observed),path.resolve(expectedPath),'Systemd did not load the reviewed unit file');
  assertNoDropInPaths(run('systemctl',['--user','show','--property=DropInPaths','--value',unitName]));
}
async function snapshotFiles(files,snapshotRoot){
  const records=[];
  for(let index=0;index<files.length;index++){
    const entry=files[index];
    const content=await readRegularFile(entry.target,{required:!entry.allowMissing});
    const backup=path.join(snapshotRoot,'previous',String(index).padStart(3,'0'));
    if(content!==null){
      await mkdir(path.dirname(backup),{recursive:true,mode:0o700});
      await writeFile(backup,content,{mode:0o600,flag:'wx'});
    }
    records.push({target:entry.target,backup,exists:content!==null});
  }
  return records;
}
async function restoreFiles(records){
  for(const record of records){
    if(record.exists){
      const content=await readFile(record.backup,'utf8');
      await atomicWrite(record.target,content);
      await chmod(record.target,0o600);
    }else await rm(record.target,{force:true});
  }
}
async function writeCandidates(files){
  for(const entry of files)await atomicWrite(entry.target,entry.content);
}
function assertStateExceptPause(expected,observed){
  assert.deepEqual(withoutPause(observed),withoutPause(expected),'Maintenance changed controller journal/checkpoint state');
}
async function readTransaction(markerPath){
  let raw;
  try{raw=await readFile(markerPath,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const marker=JSON.parse(raw);
  assert.equal(marker.format,'codexia-maintenance-transaction/v1');
  assert.ok(path.isAbsolute(marker.snapshotRoot)&&path.isAbsolute(marker.configPath)&&path.isAbsolute(marker.sourceDir)&&path.isAbsolute(marker.unitDir));
  assert.ok(Array.isArray(marker.files)&&marker.files.every(item=>typeof item.target==='string'&&typeof item.backup==='string'&&typeof item.exists==='boolean'));
  assert.equal(typeof marker.originalPaused,'boolean');
  assert.equal(typeof marker.stateFile,'string');
  assert.equal(typeof marker.routeFile,'string');
  assert.equal(typeof marker.routeContent,'string');
  assert.equal(typeof marker.quadletDir,'string');
  assert.equal(marker.updaterServiceState,'inactive');
  if(marker.proxyRestartRequired===undefined)marker.proxyRestartRequired=false;
  assert.equal(typeof marker.proxyRestartRequired,'boolean');
  if(marker.runtimeChanged===undefined)marker.runtimeChanged=false;
  assert.equal(typeof marker.runtimeChanged,'boolean');
  assert.ok(marker.timerState&&['active','inactive'].includes(marker.timerState.active)&&['enabled','disabled'].includes(marker.timerState.enabled));
  const allowedTargets=new Set([
    ...MAINTENANCE_SOURCE_FILES.map(relative=>path.join(marker.sourceDir,relative)),
    ...MAINTENANCE_UNIT_FILES.map(filename=>path.join(marker.unitDir,filename)),
    marker.configPath,
    path.join(marker.quadletDir,'codexia-api-proxy.container'),
  ]);
  assert.ok(marker.files.every(item=>allowedTargets.has(item.target)),'Interrupted maintenance target escaped the reviewed file set');
  assert.ok(marker.files.every(item=>item.backup.startsWith(path.join(marker.snapshotRoot,'previous')+path.sep)),'Interrupted maintenance backup escaped its snapshot');
  assert.ok(marker.snapshotRoot.startsWith(path.join(path.dirname(marker.stateFile),'maintenance','snapshots')+path.sep),'Interrupted maintenance snapshot escaped its private state directory');
  return marker;
}
async function verifyOldCode(marker){
  const oldEntry=path.join(marker.snapshotRoot,'old-source','deploy/updater/standalone-updater.mjs');
  await readFile(oldEntry,'utf8');
  execFileSync('node',[oldEntry,'verify',marker.configPath],{
    encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024,
    env:{...process.env,CODEXIA_UPDATER_LOCK_DIRECTORY:path.dirname(marker.stateFile)},
    stdio:['ignore','pipe','pipe'],
  });
}
async function recoverInterrupted(config,store,markerPath){
  const marker=await readTransaction(markerPath);
  if(!marker)return false;
  assert.equal(marker.stateFile,config.stateFile,'Interrupted maintenance belongs to a different controller');
  assert.equal(marker.routeFile,config.routeFile,'Interrupted maintenance belongs to a different route');
  const stateBefore=await loadControllerState(marker.stateFile);
  assertStateExceptPause(JSON.parse(await readFile(path.join(marker.snapshotRoot,'controller.json'),'utf8')),stateBefore);
  await stopTimerPolling();
  const recoveryHost=new PodmanStandaloneHost(config);
  if(marker.proxyRestartRequired||marker.runtimeChanged)await recoveryHost.route('blocked');
  await restoreFiles(marker.files);
  run('systemctl',['--user','daemon-reload']);
  const interruptedRoute=await readFile(marker.routeFile,'utf8');
  assert.ok(interruptedRoute===marker.routeContent||(marker.proxyRestartRequired||marker.runtimeChanged)&&interruptedRoute==='blocked\n','Maintenance route changed during interrupted recovery');
  const oldConfig=JSON.parse(await readFile(marker.configPath,'utf8'));
  const oldHost=new PodmanStandaloneHost(oldConfig);
  if(marker.proxyRestartRequired){
    await oldHost.route('blocked');
    await activateProxyRevision({changed:true,restart:restartProxyService,verify:async()=>{}});
  }
  if(marker.runtimeChanged){
    const oldController=new StandaloneController({host:oldHost,store,publicKey,observeMilliseconds:oldConfig.observeMilliseconds??300000});
    await transitionRuntimeWriter({
      currentHost:oldHost,targetHost:oldHost,slot:stateBefore.journal.active.slot,release:stateBefore.installed,state:stateBefore,
      verify:async()=>{await oldHost.verifyWriterUnits(stateBefore);await oldController.assertServing(stateBefore,stateBefore.journal.active.slot,stateBefore.installed);},
    });
  }else if(marker.proxyRestartRequired)await oldHost.route(marker.routeContent.trim());
  else await oldHost.route(marker.routeContent.trim());
  try{await verifyOldCode(marker);}catch(error){await oldHost.route('blocked').catch(()=>undefined);throw error;}
  const after=await loadControllerState(marker.stateFile);
  assertStateExceptPause(JSON.parse(await readFile(path.join(marker.snapshotRoot,'controller.json'),'utf8')),after);
  if(after.paused!==marker.originalPaused)await store.save(withPause(after,marker.originalPaused));
  await restoreTimerPolling(marker.timerState);
  await rm(markerPath,{force:true});
  await rm(marker.snapshotRoot,{recursive:true,force:true});
  return true;
}

function filesFor(manifest,config,candidateConfig){
  const sourceDir=path.resolve(manifest.sourceDir);
  const unitDir=path.resolve(manifest.unitDir);
  const quadletDir=path.resolve(config.quadletDirectory);
  const root=path.resolve(manifest.candidateRoot);
  return [
    ...MAINTENANCE_SOURCE_FILES.map(relative=>({
      target:path.join(sourceDir,relative),candidate:relative,allowMissing:relative==='deploy/updater/standalone-maintenance.mjs',
    })),
    ...MAINTENANCE_UNIT_FILES.map(filename=>({
      target:path.join(unitDir,filename),candidate:path.join('units',filename),
    })),
    {target:manifest.configPath,candidate:'config.json'},
    {target:path.join(quadletDir,'codexia-api-proxy.container'),candidate:path.join('quadlet','codexia-api-proxy.container')},
  ].map(entry=>({...entry,content:undefined,root}));
}
async function candidateFiles(entries,root){
  const result=[];
  let total=0;
  for(const entry of entries){
    const content=await readCandidate(root,entry.candidate);
    total+=Buffer.byteLength(content);
    assert.ok(total<=16*1024*1024,'Maintenance candidate exceeds the reviewed source limit');
    result.push({...entry,content});
  }
  return result;
}
async function checkFilesApplied(files){
  for(const entry of files)assert.equal(await readRegularFile(entry.target),entry.content,'Maintenance file installation differs from its candidate');
}

export async function maintainStandaloneUpdater({config,manifestPath,publicKey,state,store}){
  assert.equal(path.dirname(config.stateFile),process.env.CODEXIA_UPDATER_LOCK_DIRECTORY,'Maintenance must use the canonical host lock');
  const stateDir=path.dirname(config.stateFile);
  const maintenanceDir=path.join(stateDir,'maintenance');
  const markerPath=path.join(maintenanceDir,'in-progress.json');
  await mkdir(maintenanceDir,{recursive:true,mode:0o700});
  const recovered=await recoverInterrupted(config,store,markerPath);
  if(recovered){
    state=await loadControllerState(config.stateFile);
    config=JSON.parse(await readFile(path.join(path.dirname(config.publicKeyFile),'config.json'),'utf8'));
  }
  assert.ok(['idle','committed'].includes(state.journal.phase),'Maintenance requires a stable controller checkpoint');
  assert.equal(state.lastError,null,'Maintenance refuses a controller with a recorded error');

  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(),['candidateRoot','configPath','format','sourceDir','unitDir']);
  assert.equal(manifest.format,'codexia-updater-maintenance/v1');
  for(const key of ['candidateRoot','configPath','sourceDir','unitDir'])assert.ok(path.isAbsolute(manifest[key]),'Maintenance manifest paths must be absolute');
  const candidateRoot=path.resolve(manifest.candidateRoot);
  assert.equal(path.resolve(manifestPath),path.join(candidateRoot,'manifest.json'),'Maintenance manifest must be staged with its candidate');
  assert.equal(await realpath(candidateRoot),candidateRoot,'Maintenance candidate root cannot traverse a symlink');
  assert.ok(candidateRoot.startsWith(path.join(maintenanceDir,'candidates')+path.sep),'Maintenance candidate must remain in its private staging directory');
  assert.equal(path.resolve(manifest.configPath),path.join(path.dirname(config.publicKeyFile),'config.json'),'Maintenance may update only the canonical private configuration');
  const serviceHome=path.dirname(path.dirname(path.dirname(config.publicKeyFile)));
  assert.equal(path.resolve(manifest.unitDir),path.join(serviceHome,'.config','systemd','user'),'Maintenance unit directory is outside the service user configuration');
  assert.equal(path.resolve(manifest.sourceDir),'/opt/codexia-updater','Maintenance source directory differs from the canonical installation');

  const candidateConfig=JSON.parse(await readCandidate(candidateRoot,'config.json'));
  const nextConfig=validateMaintenanceConfig(config,candidateConfig);
  const candidateHost=new PodmanStandaloneHost(nextConfig);
  const currentHost=new PodmanStandaloneHost(config);
  const runtimeChanged=!isDeepStrictEqual(config.runtime,nextConfig.runtime);
  if(runtimeChanged)assert.equal(nextConfig.runtime?.profile,state.installed.profile,'Runtime profile changes require a compatible signed release transition');
  await candidateHost.assertRuntimeSources();
  const controller=new StandaloneController({host:candidateHost,store,publicKey,observeMilliseconds:nextConfig.observeMilliseconds??300000});
  const activeSlot=state.journal.active.slot;
  const currentController=new StandaloneController({host:currentHost,store,publicKey,observeMilliseconds:config.observeMilliseconds??300000});
  await preflightMaintenanceRuntime({currentConfig:config,nextConfig,currentHost,candidateHost,currentController,candidateController:controller,state,activeSlot});

  const entries=filesFor(manifest,{...config,...nextConfig},candidateConfig);
  const files=await candidateFiles(entries,candidateRoot);
  const proxyIndex=files.findIndex(entry=>entry.candidate==='quadlet/codexia-api-proxy.container');
  assertProxyImageStable(await readRegularFile(files[proxyIndex].target),files[proxyIndex].content);
  let proxyRestartRequired=false;
  for(const entry of files){
    if(entry.candidate!=='deploy/updater/proxy.mjs'&&entry.candidate!=='quadlet/codexia-api-proxy.container')continue;
    const previous=await readRegularFile(entry.target);
    if(previous!==entry.content)proxyRestartRequired=true;
  }

  const routeContent=await readFile(config.routeFile,'utf8');
  const initialTimer=timerState();
  assert.equal(updaterServiceState(),'inactive','Updater poll service must be idle before maintenance');
  const snapshotRoot=path.join(maintenanceDir,'snapshots',randomUUID());
  await mkdir(snapshotRoot,{recursive:true,mode:0o700});
  const records=await snapshotFiles(files.map(({target,allowMissing})=>({target,allowMissing})),snapshotRoot);
  await writeFile(path.join(snapshotRoot,'controller.json'),JSON.stringify(state)+'\n',{mode:0o600,flag:'wx'});
  const oldSourceRoot=path.join(snapshotRoot,'old-source');
  for(const relative of MAINTENANCE_SOURCE_FILES){
    const oldContent=await readRegularFile(path.join(manifest.sourceDir,relative),{required:relative!=='deploy/updater/standalone-maintenance.mjs'});
    if(oldContent===null)continue;
    const backup=path.join(oldSourceRoot,relative);
    await mkdir(path.dirname(backup),{recursive:true,mode:0o700});
    await writeFile(backup,oldContent,{mode:0o600,flag:'wx'});
  }
  assert.ok(await readFile(path.join(oldSourceRoot,'deploy/updater/standalone-updater.mjs'),'utf8'),'Existing updater entrypoint is required for rollback verification');
  const marker={
    format:'codexia-maintenance-transaction/v1',snapshotRoot,files:records,
    configPath:manifest.configPath,sourceDir:manifest.sourceDir,unitDir:manifest.unitDir,
    stateFile:config.stateFile,routeFile:config.routeFile,routeContent,quadletDir:config.quadletDirectory,
    originalPaused:state.paused,timerState:initialTimer,updaterServiceState:'inactive',proxyRestartRequired,runtimeChanged,
  };
  await atomicWrite(markerPath,JSON.stringify(marker)+'\n');
  try{
    await stopTimerPolling();
    if(!state.paused)await store.save(withPause(state,true));
    await writeCandidates(files);
    run('systemctl',['--user','daemon-reload']);
    await checkFilesApplied(files);
    for(const filename of MAINTENANCE_UNIT_FILES){
      const unitName=filename.replace(/\.example$/u,'');
      const target=path.join(manifest.unitDir,filename);
      await assertUnitLoaded(unitName,target);
    }
    if(runtimeChanged){
      await transitionRuntimeWriter({
        currentHost,targetHost:candidateHost,slot:activeSlot,release:state.installed,state,
        verify:async()=>{await candidateHost.verifyWriterUnits(state);await controller.assertServing(state,activeSlot,state.installed);},
      });
    }
    if(proxyRestartRequired)await candidateHost.route('blocked');
    await activateProxyRevision({changed:proxyRestartRequired,restart:restartProxyService,verify:async()=>{}});
    if(proxyRestartRequired)await candidateHost.route(activeSlot);
    await candidateHost.assertRuntimeSources();
    await candidateHost.verifyWriterUnits(state);
    await controller.assertServing(state,activeSlot,state.installed);
    const finalState=await loadControllerState(config.stateFile);
    assertStateExceptPause(state,finalState);
    if(finalState.paused!==state.paused)await store.save(withPause(finalState,state.paused));
    assert.equal(await readFile(config.routeFile,'utf8'),routeContent,'Maintenance changed the active proxy route');
    await restoreTimerPolling(initialTimer);
    await rm(markerPath,{force:true});
    await rm(snapshotRoot,{recursive:true,force:true}).catch(()=>{});
    return {format:'codexia-updater-maintenance/v1',updatedFiles:files.length,recoveredInterruptedMaintenance:recovered};
  }catch(error){
    try{
      await restoreFiles(records);
      run('systemctl',['--user','daemon-reload']);
      const oldHost=new PodmanStandaloneHost(config);
      if(proxyRestartRequired){
        await oldHost.route('blocked');
        await activateProxyRevision({changed:true,restart:restartProxyService,verify:async()=>{}});
      }
      if(runtimeChanged){
        const oldController=new StandaloneController({host:oldHost,store,publicKey,observeMilliseconds:config.observeMilliseconds??300000});
        await transitionRuntimeWriter({
          currentHost:candidateHost,targetHost:oldHost,slot:activeSlot,release:state.installed,state,
          verify:async()=>{await oldHost.verifyWriterUnits(state);await oldController.assertServing(state,activeSlot,state.installed);},
        });
      }else if(proxyRestartRequired)await oldHost.route(activeSlot);
      assert.equal(await readFile(config.routeFile,'utf8'),routeContent,'Maintenance changed the active proxy route');
      const currentState=await loadControllerState(config.stateFile);
      assertStateExceptPause(state,currentState);
      await verifyOldCode(marker);
      if(currentState.paused!==state.paused)await store.save(withPause(currentState,state.paused));
      await restoreTimerPolling(initialTimer);
      await rm(markerPath,{force:true});
      await rm(snapshotRoot,{recursive:true,force:true});
    }catch(rollbackError){
      const currentState=await loadControllerState(config.stateFile);
      if(currentState.paused!==true)await store.save(withPause(currentState,true));
      await new PodmanStandaloneHost(config).route('blocked').catch(()=>undefined);
      await keepTimerStopped().catch(()=>undefined);
      throw new Error('Updater maintenance failed and rollback remains blocked for recovery: '+String(rollbackError.message??rollbackError));
    }
    throw new Error('Updater maintenance failed; previous source/config/units were restored: '+String(error.message??error));
  }
}
