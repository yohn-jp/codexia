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

test('legacy runtime verification rejects undeclared environment, mounts and systemd resource drift',()=>{
 const imageEnvironment=['PATH=/usr/bin','NODE_ENV=production','CODEXIA_PROFILE=full','CODEXIA_MODULE_PROFILE_PATH=/app/generated/server.mjs','CODEXIA_STANDALONE_IDENTITY=1'];
 const authEnvironment=browserAuthEnvironment({browserAuth:access},origin);
 const unit=imageConfig(release,authEnvironment,runtime).replace('PLACEHOLDER','codexia-slot-blue');
 const containerId='d'.repeat(64);
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
  HostConfig:{PortBindings:{},ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],Memory:runtime.resources.memoryMaxBytes,CpuQuota:250000,CpuPeriod:100000,Tmpfs:{
   '/tmp':'rw,nosuid,nodev,noexec,size=64m','/cache':'rw,nosuid,nodev,noexec,size=512m',
  }},
 };
 assert.doesNotThrow(()=>assertRuntimeObservation(observed,runtime,imageEnvironment,unit));
 assert.doesNotThrow(()=>assertRuntimeObservation({...observed,Mounts:observed.Mounts.filter(mount=>mount.Type!=='tmpfs')},runtime,imageEnvironment,unit));
 assert.doesNotThrow(()=>assertRuntimeUnit('[Service]\nCPUQuota=250%\n',runtime));
 assert.throws(()=>assertRuntimeObservation({...observed,Config:{...observed.Config,Hostname:'codexia-slot-blue'}},runtime,imageEnvironment,unit),/Podman-generated hostname drift/);
 assert.throws(()=>assertRuntimeObservation({...observed,Config:{...observed.Config,Env:observed.Config.Env.map(entry=>entry==='HOSTNAME='+containerId.slice(0,12)?'HOSTNAME=injected-host':entry)}},runtime,imageEnvironment,unit),/unexpected runtime environment/);
 assert.throws(()=>assertRuntimeObservation({...observed,Name:'/codexia-slot-green'},runtime,imageEnvironment,unit),/Podman container name drift/);
 assert.throws(()=>assertRuntimeObservation({...observed,Config:{...observed.Config,Env:[...observed.Config.Env,'CODEXIA_UNREVIEWED=1']}},runtime,imageEnvironment,unit),/Unknown Codexia runtime/);
 assert.throws(()=>assertRuntimeObservation({...observed,Config:{...observed.Config,Env:[...observed.Config.Env,'CODEXIA_PROFILE=core']}},runtime,imageEnvironment,unit),/duplicate environment/);
 assert.throws(()=>assertRuntimeObservation({...observed,Config:{...observed.Config,Env:observed.Config.Env.map(entry=>entry==='CODEXIA_DATA_DIR=/data'?'CODEXIA_DATA_DIR=/tmp/data':entry)}},runtime,imageEnvironment,unit),/CODEXIA_DATA_DIR environment drift/);
 assert.throws(()=>assertRuntimeObservation({...observed,Config:{...observed.Config,Env:[...observed.Config.Env,'NODE_OPTIONS=--require=/tmp/inject.js']}},runtime,imageEnvironment,unit),/unexpected runtime environment/);
 assert.throws(()=>assertRuntimeObservation({...observed,Config:{...observed.Config,Env:observed.Config.Env.map(entry=>entry==='CODEXIA_DATABASE_USER=codexia'?'CODEXIA_DATABASE_USER=other':entry)}},runtime,imageEnvironment,unit),/CODEXIA_DATABASE_USER environment drift/);
 assert.throws(()=>assertRuntimeObservation({...observed,Config:{...observed.Config,Env:observed.Config.Env.map(entry=>entry==='CODEXIA_ACCESS_AUDIENCE='+access.audience?'CODEXIA_ACCESS_AUDIENCE='+'b'.repeat(64):entry)}},runtime,imageEnvironment,unit),/CODEXIA_ACCESS_AUDIENCE environment drift/);
 assert.throws(()=>assertRuntimeObservation({...observed,Mounts:[...observed.Mounts,{Destination:'/etc',Type:'bind',Source:'/etc',RW:false}]},runtime,imageEnvironment,unit),/persistent and host mounts/);
 assert.throws(()=>assertRuntimeObservation({...observed,HostConfig:{...observed.HostConfig,Memory:0}},runtime,imageEnvironment,unit),/memory limit drift/);
 assert.throws(()=>assertRuntimeObservation({...observed,HostConfig:{...observed.HostConfig,CpuQuota:200000}},runtime,imageEnvironment,unit),/CPU limit drift/);
 assert.throws(()=>assertRuntimeObservation({...observed,HostConfig:{...observed.HostConfig,PortBindings:{'3000/tcp':[{HostPort:'3000'}]}}},runtime,imageEnvironment,unit),/host port/u);
 assert.throws(()=>assertRuntimeObservation({...observed,NetworkSettings:{Networks:{codexia:{}}}},runtime,imageEnvironment,unit),/network drift/u);
 assert.throws(()=>assertRuntimeObservation({...observed,HostConfig:{...observed.HostConfig,ReadonlyRootfs:false}},runtime,imageEnvironment,unit),/root filesystem is not read-only/u);
 assert.throws(()=>assertRuntimeObservation({...observed,HostConfig:{...observed.HostConfig,CapDrop:[]}},runtime,imageEnvironment,unit),/capability drop contract drift/u);
 assert.throws(()=>assertRuntimeObservation({...observed,HostConfig:{...observed.HostConfig,SecurityOpt:[]}},runtime,imageEnvironment,unit),/security options drift/u);
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
