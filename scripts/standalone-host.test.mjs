import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {browserAuthEnvironment,imageConfig,assertVersion,PodmanStandaloneHost,validateRuntimeContract,runtimeContainerArgs,assertRuntimeObservation,assertRuntimeUnit,assertModelCacheOutsideVolumes} from '../deploy/updater/standalone-host.mjs';
const origin='https://codexia.example.invalid';
const access={mode:'cloudflare-access',issuer:'https://example.cloudflareaccess.com',audience:'a'.repeat(64),origin,ownerEmail:'owner@example.invalid'};
const release={image:'ghcr.io/yohn-jp/codexia-backend@sha256:'+'b'.repeat(64),version:'0.1.0',profile:'full',apiEpoch:1};
const runtime={
 format:'codexia-runtime/v1',profile:'full',modelCachePath:'/var/cache/codexia/models',
 tmpfs:{tempSize:'64m',moduleCacheSize:'512m'},
 resources:{memoryMaxBytes:8*1024**3,cpuQuotaPercent:250},
};
const imageEnvironmentFromUnit=(imageEnvironment,unit)=>{
 const env=new Map(imageEnvironment.map(entry=>[entry.slice(0,entry.indexOf('=')),entry.slice(entry.indexOf('=')+1)]));
 for(const [,entry] of unit.matchAll(/^Environment=(.*)$/gmu))env.set(entry.slice(0,entry.indexOf('=')),entry.slice(entry.indexOf('=')+1));
 return [...env].map(([key,value])=>key+'='+value);
};

test('typed runtime contract produces the same bounded model, cache and resource settings for a release',()=>{
 assert.deepEqual(validateRuntimeContract(runtime),runtime);
 const quadlet=imageConfig(release,{},runtime);
 assert.ok(quadlet.includes('Volume=/var/cache/codexia/models:/models:ro\n'));
 assert.ok(quadlet.includes('Environment=CODEXIA_TOKENIZER_MODELS_DIR=/models\n'));
 assert.ok(quadlet.includes('Environment=CODEXIA_MODULE_CACHE_DIR=/cache/modules\n'));
 assert.ok(quadlet.includes('Tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m\n'));
 assert.ok(quadlet.includes('Tmpfs=/cache:rw,nosuid,nodev,noexec,size=512m\n'));
 assert.ok(quadlet.includes('Memory=8589934592\n'));
 assert.ok(quadlet.includes('CPUQuota=250%\n'));
 assert.deepEqual(runtimeContainerArgs(runtime),[
  '--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m','--tmpfs','/cache:rw,nosuid,nodev,noexec,size=512m',
  '--env','CODEXIA_MODULE_CACHE_DIR=/cache/modules','--volume','/var/cache/codexia/models:/models:ro',
  '--env','CODEXIA_TOKENIZER_MODELS_DIR=/models','--memory',String(8*1024**3),'--cpu-period','100000','--cpu-quota','250000',
 ]);
 assert.throws(()=>imageConfig(release,{}, {...runtime,profile:'core'}),/release profile/);
});

test('typed runtime contract rejects unsafe paths, unknown settings and impossible bounds',()=>{
 for(const patch of [
  {extraEnvironment:{CODEXIA_HOSTED_MODE:'1'}},
  {modelCachePath:'/var/cache/codexia/models:rw'},
  {modelCachePath:'/etc'},
  {modelCachePath:'/home/codexia/.ssh'},
  {modelCachePath:'/var/cache/codexia/models-evil'},
  {modelCachePath:'/var/cache/codexia/models/../.ssh'},
  {modelCachePath:'/var/../etc'},
  {modelCachePath:'/'},
  {tmpfs:{...runtime.tmpfs,tempSize:'8g'}},
  {resources:{...runtime.resources,cpuQuotaPercent:0}},
  {resources:{...runtime.resources,memoryMaxBytes:512*1024**2}},
 ]) assert.throws(()=>validateRuntimeContract({...runtime,...patch}));
 assert.doesNotThrow(()=>validateRuntimeContract({...runtime,modelCachePath:'/var/cache/codexia/models/semantic'}));
});

test('Full profile requires an explicit model cache outside persistent authoring storage',()=>{
 assert.throws(()=>validateRuntimeContract({...runtime,modelCachePath:null}),/Full profile requires an explicit model cache path/);
});

test('model cache cannot resolve inside an existing authoring or history volume',()=>{
 const data='/home/codexia/.local/share/containers/storage/volumes/codexia-data/_data';
 const history='/home/codexia/.local/share/containers/storage/volumes/codexia-history/_data';
 assert.doesNotThrow(()=>assertModelCacheOutsideVolumes('/var/cache/codexia/models',[data,history]));
 assert.throws(()=>assertModelCacheOutsideVolumes('/var/cache/codexia/models/data',['/var/cache/codexia/models']),/must be outside persistent Codexia volumes/);
 assert.throws(()=>assertModelCacheOutsideVolumes('/var/cache/codexia/models',['/var/cache/codexia/models/persistent']),/must be outside persistent Codexia volumes/);
});

test('failed writer unit is reset only after its exact Podman container is absent',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'codexia-writer-stop-'));
 const previousPath=process.env.PATH;
 const stateFile=path.join(dir,'unit-state');
 const callsFile=path.join(dir,'calls');
 const containerMarker=path.join(dir,'container-present');
 const config={browserAuth:{mode:'token'},frontendIdentityUrl:origin+'/desktop/update-identity.json',routeFile:path.join(dir,'route'),quadletDirectory:dir,githubTokenFile:path.join(dir,'token')};
 const host=new PodmanStandaloneHost(config);
 try{
  await writeFile(stateFile,'active\n');
  await writeFile(path.join(dir,'systemctl'),'#!/usr/bin/env node\n'+
   'const fs=require("node:fs");const a=process.argv.slice(2);const state='+JSON.stringify(stateFile)+';const calls='+JSON.stringify(callsFile)+';'+
   'fs.appendFileSync(calls,a.join(" ")+"\\n");const command=a[1];'+
   'if(command==="show"){process.stdout.write(fs.readFileSync(state,"utf8"));process.exit(0)}'+
   'if(command==="stop"){fs.writeFileSync(state,"failed\\n");process.exit(0)}'+
   'if(command==="reset-failed"){fs.writeFileSync(state,"inactive\\n");process.exit(0)}'+
   'process.exit(97);\n',{mode:0o700});
  await writeFile(path.join(dir,'podman'),'#!/usr/bin/env node\n'+
   'const fs=require("node:fs");const a=process.argv.slice(2);const marker='+JSON.stringify(containerMarker)+';const calls='+JSON.stringify(callsFile)+';fs.appendFileSync(calls,"podman "+a.join(" ")+"\\n");'+
   'if(a[0]==="container"&&a[1]==="exists"){process.exit(fs.existsSync(marker)?0:1)}'+
   'if(a[0]==="inspect"){process.stdout.write(JSON.stringify([{State:{Running:false}}]));process.exit(0)}'+
   'process.exit(97);\n',{mode:0o700});
  process.env.PATH=dir+path.delimiter+previousPath;
  await host.stopWriter('blue');
  assert.equal((await readFile(stateFile,'utf8')).trim(),'inactive');
  let calls=(await readFile(callsFile,'utf8')).trim().split('\n');
  assert.ok(calls.indexOf('podman container exists codexia-slot-blue')<calls.indexOf('--user reset-failed codexia-slot-blue.service'),'reset-failed ran before proving exact container absence');

  await writeFile(stateFile,'failed\n');
  await writeFile(containerMarker,'present');
  await assert.rejects(host.stopWriter('blue'),/Failed writer unit still has its Podman container/);
  assert.equal((await readFile(stateFile,'utf8')).trim(),'failed');
  calls=(await readFile(callsFile,'utf8')).trim().split('\n');
  assert.equal(calls.filter(call=>call==='--user reset-failed codexia-slot-blue.service').length,1,'reset-failed ran while the exact Podman container still existed');
 }finally{process.env.PATH=previousPath;await rm(dir,{recursive:true,force:true});}
});

test('effective writer cgroup must remain beneath its exact systemd unit',async()=>{
 const {assertRuntimeProcessCgroup}=await import('../deploy/updater/standalone-host.mjs');
 const unit='/user.slice/user-1001.slice/user@1001.service/app.slice/codexia-slot-blue.service';
 assert.equal(assertRuntimeProcessCgroup(`0::${unit}\n`,unit),unit);
 const child=unit+'/libpod-abcdef.scope';
 assert.equal(assertRuntimeProcessCgroup(`0::${child}\n`,unit),child);
 assert.throws(()=>assertRuntimeProcessCgroup('0::/user.slice/user-1001.slice/user@1001.service/app.slice/other.service\n',unit),/escaped its systemd service cgroup/);
 assert.throws(()=>assertRuntimeProcessCgroup('1:name=systemd:/user.slice/codexia-slot-blue.service\n',unit),/unified cgroup membership is unobservable/);
 assert.throws(()=>assertRuntimeProcessCgroup(`0::${unit}/../other.service\n`,unit),/process cgroup path is invalid/);
 assert.throws(()=>assertRuntimeProcessCgroup(`0::${unit}\n`,unit.replace('/user@1001.service/','/../')),/control group path is invalid/);
});

test('effective writer memory.max must match the runtime limit including unlimited mode',async()=>{
 const {assertRuntimeMemoryMax}=await import('../deploy/updater/standalone-host.mjs');
 assert.doesNotThrow(()=>assertRuntimeMemoryMax(String(runtime.resources.memoryMaxBytes),runtime));
 assert.throws(()=>assertRuntimeMemoryMax(String(runtime.resources.memoryMaxBytes-1),runtime),/effective memory.max drift/);
 assert.throws(()=>assertRuntimeMemoryMax('max',runtime),/effective memory.max drift/);
 const unlimited={...runtime,resources:{...runtime.resources,memoryMaxBytes:null}};
 assert.doesNotThrow(()=>assertRuntimeMemoryMax('max',unlimited));
 assert.throws(()=>assertRuntimeMemoryMax(String(runtime.resources.memoryMaxBytes),unlimited),/effective memory.max drift/);
 assert.throws(()=>assertRuntimeMemoryMax('unlimited',unlimited),/effective memory.max drift/);
});

test('effective cgroup CPU quota must match the typed runtime contract',async()=>{
 const {assertRuntimeCpuMax}=await import('../deploy/updater/standalone-host.mjs');
 assert.equal(typeof assertRuntimeCpuMax,'function');
 assert.doesNotThrow(()=>assertRuntimeCpuMax('250000 100000',runtime));
 assert.throws(()=>assertRuntimeCpuMax('200000 100000',runtime),/Effective CPU quota drift/);
 assert.doesNotThrow(()=>assertRuntimeCpuMax('max 100000',{...runtime,resources:{...runtime.resources,cpuQuotaPercent:null}}));
 assert.throws(()=>assertRuntimeCpuMax('250000 100000',{...runtime,resources:{...runtime.resources,cpuQuotaPercent:null}}),/Effective CPU quota drift/);
});

test('runtime verification rejects unreviewed writer and proxy systemd drop-ins',async()=>{
 const {assertRuntimeUnitDropIns}=await import('../deploy/updater/standalone-host.mjs');
 assert.equal(typeof assertRuntimeUnitDropIns,'function');
 assert.doesNotThrow(()=>assertRuntimeUnitDropIns(''));
 assert.throws(()=>assertRuntimeUnitDropIns('/home/codexia/.config/systemd/user/codexia-slot-blue.service.d/override.conf'),/unreviewed drop-in/);
});

test('runtime capability proof requires no additions and zero live capability sets',async()=>{
 const {assertRuntimeCapabilitiesDropped,readRuntimeCapabilityStatus}=await import('../deploy/updater/standalone-host.mjs');
 const container={State:{Pid:123},HostConfig:{CapAdd:[]}};
 const zeroStatus=['CapInh:\t0000000000000000','CapPrm:\t0000000000000000','CapEff:\t0000000000000000','CapBnd:\t0000000000000000','CapAmb:\t0000000000000000'].join('\n');
 assert.doesNotThrow(()=>assertRuntimeCapabilitiesDropped(container,zeroStatus,'Writer'));
 assert.throws(()=>assertRuntimeCapabilitiesDropped({...container,HostConfig:{CapAdd:['CAP_SYS_ADMIN']}},zeroStatus,'Writer'),/unexpected capability additions/);
 for(const key of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']){
  assert.throws(()=>assertRuntimeCapabilitiesDropped(container,zeroStatus.split('\n').filter(line=>!line.startsWith(key+':')).join('\n'),'Writer'),new RegExp(key+' is unobservable'));
  assert.throws(()=>assertRuntimeCapabilitiesDropped(container,zeroStatus.replace(key+':\t0000000000000000',key+':\tmalformed'),'Writer'),new RegExp(key+' is unobservable'));
  assert.throws(()=>assertRuntimeCapabilitiesDropped(container,zeroStatus.replace(key+':\t0000000000000000',key+':\t0000000000000001'),'Writer'),new RegExp(key+' must be zero'));
 }
 await assert.rejects(readRuntimeCapabilityStatus({...container,State:{Pid:'123'}},'Writer'),/PID must be numeric/);
 await assert.rejects(readRuntimeCapabilityStatus({...container,State:{Pid:0}},'Writer'),/PID must be numeric/);
});

test('legacy runtime verification rejects undeclared environment, mounts and systemd resource drift',()=>{
 const imageEnvironment=['PATH=/usr/bin','NODE_ENV=production','CODEXIA_PROFILE=full','CODEXIA_MODULE_PROFILE_PATH=/app/generated/server.mjs','CODEXIA_STANDALONE_IDENTITY=1'];
 const authEnvironment=browserAuthEnvironment({browserAuth:access},origin);
 const unit=imageConfig(release,authEnvironment,runtime).replace('PLACEHOLDER','codexia-slot-blue');
 const containerId='d'.repeat(64);
 const zeroCapabilityStatus=['CapInh:\t0000000000000000','CapPrm:\t0000000000000000','CapEff:\t0000000000000000','CapBnd:\t0000000000000000','CapAmb:\t0000000000000000'].join('\n');
 const observed={
  Id:containerId,Name:'/codexia-slot-blue',
  Config:{Hostname:containerId.slice(0,12),Env:[...imageEnvironmentFromUnit(imageEnvironment,unit),'HOSTNAME='+containerId.slice(0,12)]},
  NetworkSettings:{Networks:{codexia:{},'codexia-data':{}}},
  Mounts:[
   {Destination:'/cache',Type:'tmpfs',RW:true},
   {Destination:'/data',Type:'volume',Name:'codexia-data',RW:true},
   {Destination:'/history',Type:'volume',Name:'codexia-history',RW:true},
   {Destination:'/models',Type:'bind',Source:runtime.modelCachePath,RW:false},
   {Destination:'/tmp',Type:'tmpfs',RW:true},
  ],
  HostConfig:{PortBindings:{},ReadonlyRootfs:true,CapDrop:['CAP_CHOWN','CAP_DAC_OVERRIDE','CAP_FOWNER','CAP_FSETID','CAP_KILL','CAP_NET_BIND_SERVICE','CAP_SETFCAP','CAP_SETGID','CAP_SETPCAP','CAP_SETUID','CAP_SYS_CHROOT'],CapAdd:[],SecurityOpt:['no-new-privileges:true'],Memory:runtime.resources.memoryMaxBytes,CpuQuota:0,CpuPeriod:0,Tmpfs:{
   '/tmp':'rw,nosuid,nodev,noexec,size=64m','/cache':'rw,nosuid,nodev,noexec,size=512m',
  }},
 };
 const observe=(container,status=zeroCapabilityStatus)=>assertRuntimeObservation(container,runtime,imageEnvironment,unit,status);
 assert.doesNotThrow(()=>observe(observed));
 assert.doesNotThrow(()=>observe({...observed,Mounts:observed.Mounts.filter(mount=>mount.Type!=='tmpfs')}));
 assert.doesNotThrow(()=>observe({...observed,HostConfig:{...observed.HostConfig,CpuQuota:0,CpuPeriod:0}}));
 assert.doesNotThrow(()=>observe({...observed,HostConfig:{...observed.HostConfig,Tmpfs:{'/tmp':`${observed.HostConfig.Tmpfs['/tmp']},rprivate,tmpcopyup`,'/cache':`${observed.HostConfig.Tmpfs['/cache']},tmpcopyup,rprivate`}}}));
 assert.throws(()=>observe({...observed,HostConfig:{...observed.HostConfig,Tmpfs:{...observed.HostConfig.Tmpfs,'/tmp':`${observed.HostConfig.Tmpfs['/tmp']},exec`}}}),/Legacy temporary filesystem drift/);
 assert.throws(()=>observe(observed,zeroCapabilityStatus.replace('CapEff:\t0000000000000000','CapEff:\t0000000000000001')),/CapEff must be zero/);
 assert.doesNotThrow(()=>assertRuntimeUnit('[Service]\nCPUQuota=250%\n',runtime));
 assert.throws(()=>observe({...observed,Config:{...observed.Config,Hostname:'codexia-slot-blue'}}),/Podman-generated hostname drift/);
 assert.throws(()=>observe({...observed,Config:{...observed.Config,Env:observed.Config.Env.map(entry=>entry==='HOSTNAME='+containerId.slice(0,12)?'HOSTNAME=injected-host':entry)}}),/unexpected runtime environment/);
 assert.throws(()=>observe({...observed,Name:'/codexia-slot-green'}),/Podman container name drift/);
 assert.throws(()=>observe({...observed,Config:{...observed.Config,Env:[...observed.Config.Env,'CODEXIA_UNREVIEWED=1']}}),/Unknown Codexia runtime/);
 assert.throws(()=>observe({...observed,Config:{...observed.Config,Env:[...observed.Config.Env,'CODEXIA_PROFILE=core']}}),/duplicate environment/);
 assert.throws(()=>observe({...observed,Config:{...observed.Config,Env:observed.Config.Env.map(entry=>entry==='CODEXIA_DATA_DIR=/data'?'CODEXIA_DATA_DIR=/tmp/data':entry)}}),/CODEXIA_DATA_DIR environment drift/);
 assert.throws(()=>observe({...observed,Config:{...observed.Config,Env:[...observed.Config.Env,'NODE_OPTIONS=--require=/tmp/inject.js']}}),/unexpected runtime environment/);
 assert.throws(()=>observe({...observed,Config:{...observed.Config,Env:observed.Config.Env.map(entry=>entry==='CODEXIA_DATABASE_USER=codexia'?'CODEXIA_DATABASE_USER=other':entry)}}),/CODEXIA_DATABASE_USER environment drift/);
 assert.throws(()=>observe({...observed,Config:{...observed.Config,Env:observed.Config.Env.map(entry=>entry==='CODEXIA_ACCESS_AUDIENCE='+access.audience?'CODEXIA_ACCESS_AUDIENCE='+'b'.repeat(64):entry)}}),/CODEXIA_ACCESS_AUDIENCE environment drift/);
 assert.throws(()=>observe({...observed,Mounts:[...observed.Mounts,{Destination:'/etc',Type:'bind',Source:'/etc',RW:false}]}),/persistent and host mounts/);
 assert.throws(()=>observe({...observed,HostConfig:{...observed.HostConfig,Memory:0}}),/memory limit drift/);
 assert.throws(()=>observe({...observed,HostConfig:{...observed.HostConfig,CpuQuota:200000}}),/unexpected container CPU quota/);
 assert.throws(()=>observe({...observed,HostConfig:{...observed.HostConfig,PortBindings:{'3000/tcp':[{HostPort:'3000'}]}}}),/host port/u);
 assert.throws(()=>observe({...observed,NetworkSettings:{Networks:{codexia:{}}}}),/network drift/u);
 assert.throws(()=>observe({...observed,HostConfig:{...observed.HostConfig,ReadonlyRootfs:false}}),/root filesystem is not read-only/u);
 assert.throws(()=>observe({...observed,HostConfig:{...observed.HostConfig,CapAdd:['CAP_SYS_ADMIN']}}),/unexpected capability additions/);
 assert.throws(()=>observe({...observed,HostConfig:{...observed.HostConfig,SecurityOpt:[]}}),/security options drift/u);
 assert.throws(()=>assertRuntimeUnit('[Service]\nCPUQuota=200%\n',runtime),/CPU quota drift/);
});

test('standalone host rejects model paths outside the dedicated artifact tree before host access',()=>{
 const config={browserAuth:access,frontendIdentityUrl:origin+'/desktop/update-identity.json',routeFile:'/tmp/route',quadletDirectory:'/tmp',githubTokenFile:'/tmp/token'};
 for(const modelCachePath of ['/etc','/home/codexia/.ssh','/tmp/models','/var/cache/codexia/models-evil']){
  assert.throws(()=>new PodmanStandaloneHost({...config,runtime:{...runtime,modelCachePath}}),/dedicated \/var\/cache\/codexia\/models artifact tree/);
 }
});

test('post-initialization verifies slot unit source and retained runtime settings',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'codexia-runtime-units-'));
 const previousPath=process.env.PATH;
 const config={browserAuth:{mode:'token'},frontendIdentityUrl:origin+'/desktop/update-identity.json',routeFile:path.join(dir,'route'),quadletDirectory:dir,githubTokenFile:path.join(dir,'token'),runtime};
 const host=new PodmanStandaloneHost(config);
 const prior={...release,image:'ghcr.io/yohn-jp/codexia-backend@sha256:'+'c'.repeat(64)};
 const blue=path.join(dir,'codexia-slot-blue.container');
 const green=path.join(dir,'codexia-slot-green.container');
 const env=browserAuthEnvironment({browserAuth:{mode:'token'}},origin);
 const state={installed:release,previous:prior,failedImages:[],journal:{active:{slot:'blue'}}};
 try{
  await writeFile(path.join(dir,'systemctl'),'#!/bin/sh\nprintf "%s" "${CODEXIA_TEST_DROPINS:-}"\n',{mode:0o700});
  process.env.PATH=dir+path.delimiter+previousPath;
  await writeFile(blue,imageConfig(release,env,runtime).replace('PLACEHOLDER','codexia-slot-blue'),{mode:0o600});
  await writeFile(green,imageConfig(prior,env,runtime).replace('PLACEHOLDER','codexia-slot-green'),{mode:0o600});
  await host.verifyWriterUnits(state);
  const validBlue=await readFile(blue,'utf8');
  await writeFile(blue,validBlue.replace(/^Image=\S+$/mu,'Image=localhost/codexia-backend:latest'),{mode:0o600});
  await assert.rejects(host.verifyWriterUnits(state),/Writer Quadlet image is not digest pinned/);
  await writeFile(blue,validBlue.replace(release.image,'ghcr.io/yohn-jp/codexia-backend@sha256:'+'e'.repeat(64)),{mode:0o600});
  await assert.rejects(host.verifyWriterUnits(state),/Writer Quadlet image is absent from controller history/);
  await writeFile(blue,validBlue,{mode:0o600});
  const valid=await readFile(green,'utf8');
  await writeFile(green,valid.replace('size=512m','size=1g'),{mode:0o600});
  await assert.rejects(host.verifyWriterUnits(state),/runtime drift/);
  await writeFile(green,valid,{mode:0o600});
  process.env.CODEXIA_TEST_DROPINS='/home/codexia/.config/systemd/user/codexia-slot-green.service.d/override.conf';
  await assert.rejects(host.verifyWriterUnits(state),/unreviewed drop-in/);
  delete process.env.CODEXIA_TEST_DROPINS;
  await rm(green);
  await symlink(blue,green);
  await assert.rejects(host.verifyWriterUnits(state),/symlink/);
  await rm(green);
  await writeFile(green,valid,{mode:0o600});
  const nextRuntime={...runtime,resources:{...runtime.resources,cpuQuotaPercent:300}};
  const nextHost=new PodmanStandaloneHost({...config,runtime:nextRuntime});
  await nextHost.convergeWriterUnits(state);
  assert.match(await readFile(blue,'utf8'),/CPUQuota=300%/);
  assert.match(await readFile(green,'utf8'),/CPUQuota=300%/);
  await nextHost.verifyWriterUnits(state);
 }finally{process.env.PATH=previousPath;delete process.env.CODEXIA_TEST_DROPINS;await rm(dir,{recursive:true,force:true});}
});

test('standalone writer and preflight use an explicit compatible browser auth mode',()=>{
  const env=browserAuthEnvironment({browserAuth:access},origin);
  assert.equal(env.CODEXIA_BROWSER_AUTH,'cloudflare-access');
  assert.equal(env.CODEXIA_ACCESS_AUDIENCE,access.audience);
  const quadlet=imageConfig(release,env);
  for(const [key,value] of Object.entries(env))assert.ok(quadlet.includes('Environment='+key+'='+value+'\n'));
  assert.ok(quadlet.includes('Environment=CODEXIA_PROFILE=full\n'));
  assert.ok(quadlet.includes('Environment=CODEXIA_DATABASE_MIGRATE_ON_START=0\n'));
  assert.ok(quadlet.includes('Secret=codexia-auth-token,'));
  const version={name:'codexia',version:release.version,profile:'full',hosted:false,apiEpoch:1};
  assertVersion({...version,browserAuth:'cloudflare-access'},release,'cloudflare-access');
  assert.throws(()=>assertVersion(version,release,'cloudflare-access'),/mode mismatch/);
  assertVersion(version,release,'token');
  assert.throws(()=>assertVersion({...version,apiEpoch:2},release,'token'),/epoch mismatch/);
  assert.deepEqual(browserAuthEnvironment({browserAuth:{mode:'token'}},origin),{CODEXIA_BROWSER_AUTH:'token'});
});
test('standalone auth rejects implicit fallback, cross-origin configuration and Quadlet injection',()=>{
  assert.throws(()=>browserAuthEnvironment({},origin),/Explicit browserAuth/);
  assert.throws(()=>browserAuthEnvironment({browserAuth:{...access,origin:'https://other.example.invalid'}},origin),/must match/);
  assert.throws(()=>browserAuthEnvironment({browserAuth:{...access,ownerEmail:'owner@example.invalid\nEnvironment=CODEXIA_HOSTED_MODE=1'}},origin));
  assert.throws(()=>browserAuthEnvironment({browserAuth:{...access,ownerEmail:'owner%h@example.invalid'}},origin));
  assert.throws(()=>browserAuthEnvironment({browserAuth:{...access,audience:'bad'}},origin));
});

test('legacy admission binds the running image ID, version and exact auth settings',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'codexia-legacy-'));
 const previous=process.env.PATH;
 const fixture={...release,format:'codexia-update-release/v1',channel:'stable',state:'published',sourceSha:'a'.repeat(40),platform:'linux/amd64',migrationFingerprint:'sha256:'+'c'.repeat(64),persistenceFormat:1};
 const version={name:'codexia',version:release.version,profile:'full',hosted:false,apiEpoch:1,browserAuth:'cloudflare-access'};
 const id='d'.repeat(64);
 const env=Object.entries(browserAuthEnvironment({browserAuth:access},origin)).map(([k,v])=>k+'='+v);
 const valid={legacy:{Image:id,State:{Running:true},Config:{Env:env}},image:{Id:'sha256:'+id,RepoDigests:[release.image]},version};
 const executable=path.join(dir,'podman');
 const fixturePath=path.join(dir,'fixture.json');
 try{
  await writeFile(executable,'#!/usr/bin/env node\n'+
    'const f=JSON.parse(require("fs").readFileSync('+JSON.stringify(fixturePath)+')); const a=process.argv.slice(2);'+
    'if(a[0]==="container"&&a[1]==="exists")process.exit(a[2]==="codexia-api"?0:1);'+
    'if(a[0]==="inspect")console.log(JSON.stringify([f.legacy]));'+
    'else if(a[0]==="image"&&a[1]==="inspect")console.log(JSON.stringify([f.image]));'+
    'else if(a[0]==="exec")console.log(JSON.stringify(f.version));else process.exit(99);\n',{mode:0o700});
  process.env.PATH=dir+path.delimiter+previous;
  const host=new PodmanStandaloneHost({browserAuth:access,frontendIdentityUrl:origin+'/desktop/update-identity.json',routeFile:'/tmp/route',quadletDirectory:'/tmp',githubTokenFile:'/tmp/token'});
  await writeFile(fixturePath,JSON.stringify(valid));await host.assertLegacyRelease(fixture);
  for(const [patch,pattern] of [
    [{legacy:{...valid.legacy,Image:'e'.repeat(64)}},/image differs/],
    [{version:{...version,version:'0.1.2'}},/strictly equal/],
    [{legacy:{...valid.legacy,Config:{Env:env.map(x=>x.startsWith('CODEXIA_ACCESS_OWNER_EMAIL=')?'CODEXIA_ACCESS_OWNER_EMAIL=other@example.invalid':x)}}},/authentication configuration mismatch/]
  ]){
   await writeFile(fixturePath,JSON.stringify({...valid,...patch}));await assert.rejects(host.assertLegacyRelease(fixture),pattern);
  }
 }finally{process.env.PATH=previous;await rm(dir,{recursive:true,force:true});}
});
