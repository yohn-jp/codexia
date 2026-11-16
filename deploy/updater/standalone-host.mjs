import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, readFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../../scripts/standalone-update-controller.mjs';
import { validateUpdateRelease } from '../../scripts/update-release-policy.mjs';

const SLOT = /^(blue|green)$/u;
const name = slot => {if(!SLOT.test(slot))throw Error('Invalid slot');return 'codexia-slot-'+slot;};
const preflight = slot => {name(slot);return 'codexia-preflight-'+slot;};
const channelUrl='https://api.github.com/repos/yohn-jp/codexia/contents/stable-channel.json?ref=codexia-stable-channel';
const fingerprintCode='import { packagedMigrationFingerprint } from "@codexia/api"; console.log(await packagedMigrationFingerprint());';
const readyCode=`const health=await fetch("http://127.0.0.1:3000/health/ready",{signal:AbortSignal.timeout(5000)});if(!health.ok)process.exit(1);const version=await fetch("http://127.0.0.1:3000/api/version",{signal:AbortSignal.timeout(5000)});if(!version.ok)process.exit(1);console.log(JSON.stringify(await version.json()));`;
const proxyProbeCode=`const r=await fetch("http://127.0.0.1:3000/api/version",{signal:AbortSignal.timeout(5000)});if(!r.ok)process.exit(1);console.log(JSON.stringify({slot:r.headers.get("x-codexia-upstream-slot"),version:await r.json()}));`;
const authProbeCode=`import {readFileSync} from "node:fs";const token=readFileSync("/run/secrets/codexia-auth-token","utf8").trim();const r=await fetch("http://codexia-api-proxy:3000/api/v1/persistence/status",{headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(5000)});if(!r.ok)process.exit(1);const body=await r.json();if(body.available!==true)process.exit(1);`;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const tmpfsTempSizes=new Set(['16m','32m','64m','128m','256m','512m','1g']);
const tmpfsCacheSizes=new Set(['128m','256m','512m','1g','2g','4g','8g']);
const toBytes=value=>{const [,amount,unit]=/^(\d+)(m|g)$/u.exec(value)??[];return Number(amount)*(unit==='g'?1024**3:1024**2);};

export function validateRuntimeContract(value){
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value),'Runtime contract must be an object');
  assert.deepEqual(Object.keys(value).sort(),['format','modelCachePath','profile','resources','tmpfs'],'Unexpected runtime contract fields');
  assert.equal(value.format,'codexia-runtime/v1','Unsupported runtime contract');
  assert.ok(['core','full'].includes(value.profile),'Runtime profile must be core or full');
  if(value.profile==='full')assert.ok(value.modelCachePath!==null,'Full profile requires an explicit model cache path');
  if(value.modelCachePath!==null){
    assert.equal(typeof value.modelCachePath,'string','Model cache path must be a string or null');
    assert.ok(path.isAbsolute(value.modelCachePath)&&path.resolve(value.modelCachePath)===value.modelCachePath&&value.modelCachePath!=='/','Model cache path must be a normalized non-root absolute path');
    assert.match(value.modelCachePath,/^[A-Za-z0-9._/-]+$/u,'Model cache path contains a Quadlet delimiter or unsafe character');
  }
  assert.ok(value.tmpfs&&typeof value.tmpfs==='object'&&!Array.isArray(value.tmpfs));
  assert.deepEqual(Object.keys(value.tmpfs).sort(),['moduleCacheSize','tempSize'],'Unexpected runtime tmpfs fields');
  assert.ok(tmpfsTempSizes.has(value.tmpfs.tempSize),'Unsupported temporary filesystem size');
  assert.ok(tmpfsCacheSizes.has(value.tmpfs.moduleCacheSize),'Unsupported module-cache filesystem size');
  assert.ok(value.resources&&typeof value.resources==='object'&&!Array.isArray(value.resources));
  assert.deepEqual(Object.keys(value.resources).sort(),['cpuQuotaPercent','memoryMaxBytes'],'Unexpected runtime resource fields');
  const {memoryMaxBytes,cpuQuotaPercent}=value.resources;
  assert.ok(memoryMaxBytes===null||Number.isSafeInteger(memoryMaxBytes)&&memoryMaxBytes>=256*1024**2&&memoryMaxBytes<=64*1024**3,'Memory limit must be null or 256 MiB–64 GiB');
  assert.ok(cpuQuotaPercent===null||Number.isSafeInteger(cpuQuotaPercent)&&cpuQuotaPercent>=10&&cpuQuotaPercent<=800,'CPU quota must be null or 10–800 percent');
  if(memoryMaxBytes!==null)assert.ok(memoryMaxBytes>=toBytes(value.tmpfs.tempSize)+toBytes(value.tmpfs.moduleCacheSize),'Memory limit is smaller than the configured tmpfs capacity');
  return value;
}

export function assertModelCacheOutsideVolumes(modelCachePath,volumeMountpoints){
  assert.ok(path.isAbsolute(modelCachePath)&&path.resolve(modelCachePath)===modelCachePath,'Model cache path must be normalized and absolute');
  for(const mountpoint of volumeMountpoints){
    assert.ok(path.isAbsolute(mountpoint)&&path.resolve(mountpoint)===mountpoint,'Persistent volume mountpoint is unobservable');
    assert.ok(modelCachePath!==mountpoint&&!modelCachePath.startsWith(mountpoint+path.sep),'Model cache must be outside persistent Codexia volumes');
  }
}

export function runtimeContainerArgs(value){
  const runtime=validateRuntimeContract(value);
  const args=['--tmpfs',`/tmp:rw,nosuid,nodev,noexec,size=${runtime.tmpfs.tempSize}`,
    '--tmpfs',`/cache:rw,nosuid,nodev,noexec,size=${runtime.tmpfs.moduleCacheSize}`,
    '--env','CODEXIA_MODULE_CACHE_DIR=/cache/modules'];
  if(runtime.modelCachePath)args.push('--volume',`${runtime.modelCachePath}:/models:ro`,'--env','CODEXIA_TOKENIZER_MODELS_DIR=/models');
  if(runtime.resources.memoryMaxBytes!==null)args.push('--memory',String(runtime.resources.memoryMaxBytes));
  if(runtime.resources.cpuQuotaPercent!==null)args.push('--cpu-period','100000','--cpu-quota',String(runtime.resources.cpuQuotaPercent*1000));
  return args;
}

function environmentMap(entries,label){
  assert.ok(Array.isArray(entries),label+' environment is unobservable');
  const values=entries.map(value=>{
    const split=value.indexOf('=');
    return split<0?['',value]:[value.slice(0,split),value.slice(split+1)];
  });
  assert.ok(values.every(([key])=>key.length>0),label+' environment contains an invalid setting');
  assert.equal(new Set(values.map(([key])=>key)).size,values.length,label+' environment contains duplicate settings');
  return new Map(values);
}

function assertContainerEnvironment(container,imageEnvironment,unitText,label){
  assert.equal(typeof unitText,'string',label+' Quadlet environment is unobservable');
  const expected=environmentMap(imageEnvironment,'Pinned image');
  const declared=[...unitText.matchAll(/^Environment=(.*)$/gmu)].map(match=>match[1]);
  for(const [key,value] of environmentMap(declared,label+' Quadlet'))expected.set(key,value);
  const actual=environmentMap(container?.Config?.Env,label+' runtime');
  for(const [key,value] of expected)assert.equal(actual.get(key),value,label+' '+key+' environment drift');
  const containerName=typeof container?.Name==='string'?container.Name.replace(/^\//u,''):'';
  for(const [key,value] of actual){
    if(expected.has(key))continue;
    if(key==='container'&&value==='podman')continue;
    if(key==='HOSTNAME'&&containerName&&value===containerName)continue;
    if(key==='HOME'&&value==='/root'&&['','0','root'].includes(container.Config?.User??''))continue;
    assert.fail(label+' contains an unexpected runtime environment setting: '+key);
  }
}

export function assertRuntimeObservation(container,value,imageEnvironment,unitText){
  const runtime=validateRuntimeContract(value);
  const environment=container?.Config?.Env;
  assert.ok(Array.isArray(environment),'Legacy runtime environment is unobservable');
  const entries=environment.map(value=>{
    const split=value.indexOf('=');
    return split<0?['',value]:[value.slice(0,split),value.slice(split+1)];
  });
  assert.ok(entries.every(([key])=>key.length>0),'Legacy runtime contains an invalid environment setting');
  assert.equal(new Set(entries.map(([key])=>key)).size,entries.length,'Legacy runtime contains duplicate environment settings');
  const env=new Map(entries);
  const allowed=new Set(['CODEXIA_AUTH_TOKEN_FILE','CODEXIA_DATABASE_PASSWORD_FILE','CODEXIA_DATABASE_USER','CODEXIA_DATABASE_NAME','CODEXIA_DATABASE_HOST','CODEXIA_DATABASE_MIGRATE_ON_START','CODEXIA_TRUST_PROXY','CODEXIA_BROWSER_AUTH','CODEXIA_ACCESS_ISSUER','CODEXIA_ACCESS_AUDIENCE','CODEXIA_ACCESS_ORIGIN','CODEXIA_ACCESS_OWNER_EMAIL','CODEXIA_HOSTED_MODE','CODEXIA_PROFILE','CODEXIA_DATA_DIR','CODEXIA_USAGE_DIR','CODEXIA_MODULE_PROFILE_PATH','CODEXIA_MODULE_CACHE_DIR','CODEXIA_TOKENIZER_MODELS_DIR','CODEXIA_STANDALONE_IDENTITY','CODEXIA_PRODUCER_REVISION','CODEXIA_BUILD_PROFILE','CODEXIA_BUILD_MODULE_PROFILE_PATH','CODEXIA_BUILD_DATA_DIR','CODEXIA_BUILD_USAGE_DIR']);
  for(const [key] of entries)if(key.startsWith('CODEXIA_'))assert.ok(allowed.has(key),'Unknown Codexia runtime environment setting: '+key);
  assertContainerEnvironment(container,imageEnvironment,unitText,'Legacy runtime');
  assert.equal(env.get('CODEXIA_PROFILE'),runtime.profile,'Legacy runtime profile drift');
  assert.equal(env.get('CODEXIA_DATA_DIR'),'/data','Legacy data directory drift');
  assert.equal(env.get('CODEXIA_USAGE_DIR'),'/history','Legacy usage directory drift');
  assert.equal(env.get('HOST'),'0.0.0.0','Legacy application bind address drift');
  assert.equal(env.get('PORT'),'3000','Legacy application port drift');
  assert.equal(env.get('CODEXIA_MODULE_CACHE_DIR'),'/cache/modules','Legacy module-cache path drift');
  assert.equal(env.get('CODEXIA_TOKENIZER_MODELS_DIR'),runtime.modelCachePath?'/models':undefined,'Legacy model-cache path drift');

  const mounts=container?.Mounts;
  assert.ok(Array.isArray(mounts),'Legacy runtime mounts are unobservable');
  const actual=mounts.map(mount=>({
    destination:mount.Destination,type:mount.Type,name:mount.Name??null,source:mount.Type==='bind'?mount.Source??null:null,rw:mount.RW,
  })).sort((left,right)=>left.destination.localeCompare(right.destination));
  const persistent=actual.filter(mount=>mount.type!=='tmpfs');
  const expectedPersistent=[
    {destination:'/data',type:'volume',name:'codexia-data',source:null,rw:true},
    {destination:'/history',type:'volume',name:'codexia-history',source:null,rw:true},
    ...(runtime.modelCachePath?[{destination:'/models',type:'bind',name:null,source:runtime.modelCachePath,rw:false}]:[]),
  ].sort((left,right)=>left.destination.localeCompare(right.destination));
  assert.deepEqual(persistent,expectedPersistent,'Legacy persistent and host mounts differ from the declared runtime contract');
  const tmpfsMounts=actual.filter(mount=>mount.type==='tmpfs');
  const allowedTmpfs=new Set(['/cache','/tmp','/dev','/dev/shm','/run','/var/tmp']);
  assert.ok(tmpfsMounts.every(mount=>allowedTmpfs.has(mount.destination)&&mount.rw),'Legacy runtime has an undeclared tmpfs mount');
  assert.ok(tmpfsMounts.some(mount=>mount.destination==='/cache')&&tmpfsMounts.some(mount=>mount.destination==='/tmp'),'Declared runtime tmpfs mounts are missing');
  assert.equal(actual.length,persistent.length+tmpfsMounts.length,'Legacy runtime contains an unsupported mount type');
  assert.equal(container.HostConfig?.Memory??0,runtime.resources.memoryMaxBytes??0,'Legacy memory limit drift');
  const expectedCpuQuota=runtime.resources.cpuQuotaPercent===null?0:runtime.resources.cpuQuotaPercent*1000;
  assert.equal(container.HostConfig?.CpuQuota??0,expectedCpuQuota,'Legacy CPU limit drift');
  if(expectedCpuQuota!==0)assert.equal(container.HostConfig?.CpuPeriod??0,100000,'Legacy CPU period drift');
  const tmpfs=container.HostConfig?.Tmpfs;
  assert.ok(tmpfs&&typeof tmpfs==='object','Legacy tmpfs settings are unobservable');
  assert.deepEqual(Object.keys(tmpfs).sort(),['/cache','/tmp'],'Legacy tmpfs mount set drift');
  assert.equal(tmpfs['/tmp'],`rw,nosuid,nodev,noexec,size=${runtime.tmpfs.tempSize}`,'Legacy temporary filesystem drift');
  assert.equal(tmpfs['/cache'],`rw,nosuid,nodev,noexec,size=${runtime.tmpfs.moduleCacheSize}`,'Legacy module-cache filesystem drift');
}

export function assertProxyRuntimeObservation(quadletText,container,activeState,imageInfo,{home=process.env.HOME}={}){
  const images=[...quadletText.matchAll(/^Image=(\S+)$/gmu)].map(match=>match[1]);
  assert.equal(images.length,1,'Proxy Quadlet image identity is unobservable');
  assert.match(images[0],/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u,'Proxy Quadlet image is not digest pinned');
  assert.equal(activeState,'active','Private proxy systemd unit is not active');
  assert.equal(container?.State?.Running,true,'Private proxy container is not running');
  const observed=container.ImageName??container.Config?.Image;
  assert.equal(observed,images[0],'Running private proxy image differs from its pinned Quadlet');
  assert.ok(imageInfo&&typeof imageInfo.Id==='string'&&imageInfo.Id.startsWith('sha256:'),'Pinned proxy image content identity is unobservable');
  assert.ok(Array.isArray(imageInfo.RepoDigests)&&imageInfo.RepoDigests.includes(images[0]),'Pinned proxy digest is not present in the local image');
  assert.equal(container.Image,imageInfo.Id,'Running private proxy container uses different image content');
  assertContainerEnvironment(container,imageInfo.Config?.Env,quadletText,'Private proxy');

  for(const [directive,expected] of [
    ['User','0'],['Entrypoint','node'],['Exec','/config/proxy.mjs'],['ReadOnly','true'],
    ['NoNewPrivileges','true'],['DropCapability','all'],['Tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16m'],
  ]){
    const observed=[...quadletText.matchAll(new RegExp('^'+directive+'=(.*)$','gmu'))].map(match=>match[1]);
    assert.deepEqual(observed,[expected],'Private proxy Quadlet '+directive+' contract drift');
  }
  assert.deepEqual([...quadletText.matchAll(/^PublishPort=(.*)$/gmu)].map(match=>match[1]),[],'Private proxy Quadlet declares a host port');

  const networks=[...quadletText.matchAll(/^Network=(\S+)$/gmu)].map(match=>match[1]);
  assert.deepEqual(networks,['codexia.network'],'Private proxy Quadlet network contract drift');
  const observedNetworks=container.NetworkSettings?.Networks;
  assert.ok(observedNetworks&&typeof observedNetworks==='object'&&!Array.isArray(observedNetworks),'Private proxy networks are unobservable');
  assert.deepEqual(Object.keys(observedNetworks).sort(),['codexia'],'Private proxy network drift');

  const portBindings=container.HostConfig?.PortBindings;
  assert.ok(portBindings===null||portBindings&&typeof portBindings==='object'&&!Array.isArray(portBindings),'Private proxy host port bindings are unobservable');
  assert.equal(Object.keys(portBindings??{}).length,0,'Private proxy exposes a host port');

  assert.ok(path.isAbsolute(home),'Private proxy service home is unobservable');
  const declaredVolumes=[...quadletText.matchAll(/^Volume=(\S+)$/gmu)].map(match=>match[1]);
  const expectedMounts=declaredVolumes.map(value=>{
    const [source,destination,...optionParts]=value.split(':');
    assert.ok(source&&destination&&optionParts.length>0,'Private proxy volume declaration is invalid');
    const options=optionParts.join(':').split(',');
    assert.ok(options.includes('ro')&&!options.includes('rw'),'Private proxy host mount must be read-only');
    const resolvedSource=source.replace(/^%h(?=\/|$)/u,home);
    assert.ok(path.isAbsolute(resolvedSource),'Private proxy host mount source is not absolute');
    return {source:path.resolve(resolvedSource),destination,readOnly:true};
  }).sort((left,right)=>left.destination.localeCompare(right.destination));
  assert.deepEqual(expectedMounts.map(mount=>mount.destination).sort(),['/config/proxy.mjs','/config/state'],'Private proxy mount contract drift');
  const mounts=container.Mounts;
  assert.ok(Array.isArray(mounts),'Private proxy mounts are unobservable');
  const actualBinds=mounts.filter(mount=>mount.Type==='bind'||mount.Type==='volume').map(mount=>({
    source:path.resolve(mount.Source??''),destination:mount.Destination,readOnly:mount.RW===false,
  })).sort((left,right)=>left.destination.localeCompare(right.destination));
  assert.deepEqual(actualBinds,expectedMounts,'Private proxy mounts differ from the reviewed read-only host mounts');
  const allowedTmpfs=new Set(['/dev','/dev/shm','/run','/tmp','/var/tmp']);
  assert.ok(mounts.every(mount=>mount.Type==='bind'||mount.Type==='volume'||mount.Type==='tmpfs'&&allowedTmpfs.has(mount.Destination)),'Private proxy has an unsupported mount type');

  const hostConfig=container.HostConfig;
  assert.equal(hostConfig?.ReadonlyRootfs,true,'Private proxy root filesystem is not read-only');
  assert.deepEqual((hostConfig?.CapDrop??[]).map(value=>String(value).toLowerCase()).sort(),['all'],'Private proxy capability drop contract drift');
  assert.ok(Array.isArray(hostConfig?.SecurityOpt),'Private proxy security options are unobservable');
  assert.equal(hostConfig.SecurityOpt.length,1,'Private proxy security options drift');
  assert.match(hostConfig.SecurityOpt[0],/^no-new-privileges(?::true)?$/iu,'Private proxy no-new-privileges setting is missing or has an unexpected override');
  assert.deepEqual(hostConfig?.Tmpfs,{'/tmp':'rw,nosuid,nodev,noexec,size=16m'},'Private proxy temporary filesystem drift');
  assert.equal(container.Config?.User,'0','Private proxy container user drift');
  assert.deepEqual(container.Config?.Entrypoint,['node'],'Private proxy entrypoint drift');
  assert.deepEqual(container.Config?.Cmd,['/config/proxy.mjs'],'Private proxy command drift');
}

export function assertRuntimeUnit(unitText,value){
  const runtime=validateRuntimeContract(value);
  const quotas=[...unitText.matchAll(/^CPUQuota=(.+)$/gmu)].map(match=>match[1]);
  assert.deepEqual(quotas,runtime.resources.cpuQuotaPercent===null?[]:[`${runtime.resources.cpuQuotaPercent}%`],'Legacy CPU quota drift');
}

export function assertRuntimeUnitDropIns(value){
  assert.equal(typeof value,'string','Runtime systemd unit overrides are unobservable');
  assert.equal(value.trim(),'','Runtime systemd unit has an unreviewed drop-in');
}

export function assertRuntimeCpuMax(cpuMax,value){
  const runtime=validateRuntimeContract(value);
  const match=/^(max|[0-9]+) ([0-9]+)$/u.exec(cpuMax.trim());
  assert.ok(match,'Effective cgroup CPU quota is unobservable');
  const [,quota,periodText]=match;
  const period=BigInt(periodText);
  assert.ok(period>0n,'Effective cgroup CPU period is invalid');
  if(runtime.resources.cpuQuotaPercent===null){
    assert.equal(quota,'max','Effective CPU quota drift');
    return;
  }
  assert.notEqual(quota,'max','Effective CPU quota drift');
  assert.equal(BigInt(quota)*100n,BigInt(runtime.resources.cpuQuotaPercent)*period,'Effective CPU quota drift');
}

export async function assertRuntimeSystemdCpuQuota(unitName,value){
  const controlGroup=run('systemctl',['--user','show','--property=ControlGroup','--value',unitName]).trim();
  assert.ok(controlGroup.startsWith('/')&&controlGroup!=='/'&&path.posix.normalize(controlGroup)===controlGroup,'Systemd control group path is invalid');
  const cgroupRoot=await realpath('/sys/fs/cgroup');
  const cpuMaxPath=path.join(cgroupRoot,controlGroup.slice(1),'cpu.max');
  const observedPath=await realpath(cpuMaxPath);
  assert.ok(observedPath.startsWith(cgroupRoot+path.sep),'Systemd CPU quota path escapes the cgroup root');
  assertRuntimeCpuMax(await readFile(observedPath,'utf8'),value);
}

async function boundedJson(url,headers,max=2*1024*1024){
  const response=await fetch(url,{headers,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!response.ok||!response.body)throw Error('Read-only update metadata request failed: HTTP '+response.status);
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.byteLength;if(size>max)throw Error('Update metadata response too large');chunks.push(chunk);}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}
function run(binary,args,{timeout=120000,env=process.env}={}){
  try{return execFileSync(binary,args,{encoding:'utf8',timeout,maxBuffer:4*1024*1024,env,stdio:['ignore','pipe','pipe']}).trim();}
  catch(error){throw new Error(binary+' '+args[0]+' failed (status '+String(error.status??'unknown')+')');}
}
function exists(container){
  const result=spawnSync('podman',['container','exists',container],{timeout:15000,stdio:'ignore'});
  if(result.status===0)return true;if(result.status===1)return false;throw Error('Podman container existence unobservable');
}
function inspect(container){
  if(!exists(container))return null;
  const result=JSON.parse(run('podman',['inspect','--type','container',container]))[0];
  if(typeof result?.State?.Running!=='boolean')throw Error('Podman state unobservable');
  return result;
}
function activeUnit(slot){return name(slot)+'.service';}
function unitStatus(slot){
  const result=spawnSync('systemctl',['--user','show','-p','ActiveState','--value',activeUnit(slot)],{encoding:'utf8',timeout:15000});
  if(result.status!==0)throw Error('Systemd unit state unobservable');
  return result.stdout.trim();
}
export function browserAuthEnvironment(config,frontendOrigin){
  const auth=config.browserAuth;
  assert.ok(auth&&typeof auth==='object'&&!Array.isArray(auth),'Explicit browserAuth configuration required');
  if(auth.mode==='token'){
    assert.deepEqual(Object.keys(auth),['mode'],'Unexpected token browserAuth fields');
    return {CODEXIA_BROWSER_AUTH:'token'};
  }
  assert.equal(auth.mode,'cloudflare-access','Unsupported browser auth mode');
  assert.deepEqual(Object.keys(auth).sort(),['audience','issuer','mode','origin','ownerEmail']);
  assert.match(auth.issuer,/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/u);
  assert.match(auth.audience,/^[a-f0-9]{64}$/u);
  assert.equal(new URL(auth.origin).origin,auth.origin);
  assert.match(auth.origin,/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/u);
  assert.equal(auth.origin,frontendOrigin,'Access origin must match deployed UI');
  // Restrict Quadlet values to literal safe characters, not directives or specifiers.
  assert.match(auth.ownerEmail,/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/u);
  return {CODEXIA_BROWSER_AUTH:auth.mode,CODEXIA_ACCESS_ISSUER:auth.issuer,CODEXIA_ACCESS_AUDIENCE:auth.audience,CODEXIA_ACCESS_ORIGIN:auth.origin,CODEXIA_ACCESS_OWNER_EMAIL:auth.ownerEmail};
}
export function assertVersion(version,release,browserAuth){
  assert.equal(version?.name,'codexia');assert.equal(version.version,release.version);
  assert.equal(version.profile,release.profile);assert.equal(version.hosted,false);
  assert.equal(version.apiEpoch,release.apiEpoch,'Candidate API compatibility epoch mismatch');
  assert.equal(version.browserAuth??'token',browserAuth,'Candidate browser authentication mode mismatch');
}
export function imageConfig(release,authEnvironment,runtimeValue){
  const runtime=runtimeValue===undefined?null:validateRuntimeContract(runtimeValue);
  if(runtime)assert.equal(runtime.profile,release.profile,'Runtime contract release profile mismatch');
  const tmpfsLines=runtime?`Tmpfs=/tmp:rw,nosuid,nodev,noexec,size=${runtime.tmpfs.tempSize}\nTmpfs=/cache:rw,nosuid,nodev,noexec,size=${runtime.tmpfs.moduleCacheSize}\n`:'Tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m\n';
  const runtimeEnvironment=runtime?`Environment=CODEXIA_MODULE_CACHE_DIR=/cache/modules\n${runtime.modelCachePath?'Environment=CODEXIA_TOKENIZER_MODELS_DIR=/models\n':''}`:'';
  const runtimeMount=runtime?.modelCachePath?`Volume=${runtime.modelCachePath}:/models:ro\n`:'';
  const memory=runtime?.resources.memoryMaxBytes!==null&&runtime?.resources.memoryMaxBytes!==undefined?`Memory=${runtime.resources.memoryMaxBytes}\n`:'';
  const cpuQuota=runtime?.resources.cpuQuotaPercent!==null&&runtime?.resources.cpuQuotaPercent!==undefined?`CPUQuota=${runtime.resources.cpuQuotaPercent}%\n`:'';
  return `[Unit]
Description=Codexia exclusive writer
Requires=codexia-db.service
After=codexia-db.service
[Container]
Image=${release.image}
${memory.trimEnd()}
ContainerName=PLACEHOLDER
Network=codexia.network
Network=codexia-data.network
Volume=codexia-data.volume:/data
Volume=codexia-history.volume:/history
${runtimeMount.trimEnd()}
Secret=codexia-auth-token,type=mount,target=/run/secrets/codexia-auth-token
Secret=codexia-postgres-app-password,type=mount,target=/run/secrets/app-password
Environment=CODEXIA_AUTH_TOKEN_FILE=/run/secrets/codexia-auth-token
Environment=CODEXIA_DATABASE_PASSWORD_FILE=/run/secrets/app-password
Environment=CODEXIA_DATABASE_USER=codexia
Environment=CODEXIA_DATABASE_NAME=codexia
Environment=CODEXIA_DATABASE_HOST=codexia-db
Environment=CODEXIA_DATABASE_MIGRATE_ON_START=0
Environment=CODEXIA_TRUST_PROXY=1
${Object.entries(authEnvironment).map(([key,value])=>'Environment='+key+'='+value).join('\n')}
Environment=CODEXIA_HOSTED_MODE=0
Environment=CODEXIA_PROFILE=${release.profile}
Environment=HOST=0.0.0.0
Environment=PORT=3000
Environment=CODEXIA_DATA_DIR=/data
Environment=CODEXIA_USAGE_DIR=/history
${runtimeEnvironment.trimEnd()}
ReadOnly=true
${tmpfsLines.trimEnd()}
NoNewPrivileges=true
DropCapability=all
StopTimeout=60
[Service]
Restart=on-failure
RestartSec=10
TimeoutStartSec=120
TimeoutStopSec=90
${cpuQuota.trimEnd()}
`;
}

export function validateFrontendIdentity(value){
  assert.equal(value?.format,'codexia-frontend-identity/v1');
  assert.match(value.sourceSha,/^[a-f0-9]{40}$/u);
  assert.match(value.version,/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  assert.ok(['core','full'].includes(value.profile));
  assert.ok(Number.isSafeInteger(value.apiEpoch)&&value.apiEpoch>0);
  return value;
}

export class PodmanStandaloneHost{
  constructor(config){
    const url=new URL(config.frontendIdentityUrl);
    assert.equal(url.protocol,'https:');assert.equal(url.pathname,'/desktop/update-identity.json');
    assert.ok(!url.username&&!url.password&&!url.search&&!url.hash);
    for(const key of ['routeFile','quadletDirectory','githubTokenFile'])assert.ok(path.isAbsolute(config[key]),key+' must be absolute');
    assert.ok(!config.accessClientIdFile===!config.accessClientSecretFile,'Access credentials must be paired');
    for(const key of ['accessClientIdFile','accessClientSecretFile'])if(config[key])assert.ok(path.isAbsolute(config[key]));
    this.authEnvironment=browserAuthEnvironment(config,url.origin);
    this.runtime=config.runtime===undefined?null:validateRuntimeContract(config.runtime);
    this.config=config;this.url=url.href;
  }
  async assertRuntimeSources(){
    if(!this.runtime?.modelCachePath)return;
    const observed=await lstat(this.runtime.modelCachePath);
    assert.ok(observed.isDirectory()&&!observed.isSymbolicLink(),'Model cache source must be an existing real directory');
    const canonicalCache=await realpath(this.runtime.modelCachePath);
    assert.equal(canonicalCache,this.runtime.modelCachePath,'Model cache source cannot traverse a symlink');
    await access(this.runtime.modelCachePath,fsConstants.R_OK|fsConstants.X_OK);
    const volumeMountpoints=[];
    for(const volume of ['codexia-data','codexia-history']){
      const mountpoint=run('podman',['volume','inspect','--format','{{.Mountpoint}}',volume]).trim();
      assert.ok(path.isAbsolute(mountpoint),'Persistent volume mountpoint is unobservable');
      volumeMountpoints.push(await realpath(mountpoint));
    }
    assertModelCacheOutsideVolumes(canonicalCache,volumeMountpoints);
  }
  async verifyWriterUnits(state){
    if(!this.runtime)return;
    const activeSlot=state?.journal?.active?.slot;
    assert.ok(['blue','green'].includes(activeSlot),'Committed writer slot is unobservable');
    assert.equal(state.installed?.profile,this.runtime.profile,'Installed release profile differs from runtime contract');
    const acceptedImages=new Set([state.installed.image,state.previous?.image,...(state.failedImages??[])] .filter(Boolean));
    for(const slot of ['blue','green']){
      const filename=path.join(this.config.quadletDirectory,name(slot)+'.container');
      let observed;
      try{observed=await lstat(filename);}catch(error){
        if(error.code==='ENOENT'&&slot!==activeSlot)continue;
        throw error.code==='ENOENT'?new Error('Committed writer Quadlet is missing'):error;
      }
      assert.ok(observed.isFile()&&!observed.isSymbolicLink(),'Writer Quadlet must be a regular non-symlink file');
      assert.equal(observed.mode&0o777,0o600,'Writer Quadlet permissions drift');
      if(typeof process.getuid==='function')assert.equal(observed.uid,process.getuid(),'Writer Quadlet owner drift');
      const content=await readFile(filename,'utf8');
      const image=content.match(/^Image=(\S+)$/mu)?.[1];
      assert.ok(image&&/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u.test(image),'Writer Quadlet image is not digest pinned');
      assert.ok(acceptedImages.has(image),'Writer Quadlet image is absent from controller history');
      if(slot===activeSlot)assert.equal(image,state.installed.image,'Committed writer Quadlet image drift');
      const expected=imageConfig({image,profile:this.runtime.profile},this.authEnvironment,this.runtime).replace('PLACEHOLDER',name(slot));
      assert.equal(content,expected,'Writer Quadlet runtime drift');
      assertRuntimeUnitDropIns(run('systemctl',['--user','show','--property=DropInPaths','--value',activeUnit(slot)]));
    }
  }
  async convergeWriterUnits(state){
    if(!this.runtime)return;
    const activeSlot=state?.journal?.active?.slot;
    assert.ok(['blue','green'].includes(activeSlot),'Committed writer slot is unobservable');
    assert.equal(state.installed?.profile,this.runtime.profile,'Installed release profile differs from runtime contract');
    const acceptedImages=new Set([state.installed.image,state.previous?.image,...(state.failedImages??[])].filter(Boolean));
    for(const slot of ['blue','green']){
      const filename=path.join(this.config.quadletDirectory,name(slot)+'.container');
      let observed;
      try{observed=await lstat(filename);}catch(error){
        if(error.code==='ENOENT'&&slot!==activeSlot)continue;
        throw error.code==='ENOENT'?new Error('Committed writer Quadlet is missing'):error;
      }
      assert.ok(observed.isFile()&&!observed.isSymbolicLink(),'Writer Quadlet must be a regular non-symlink file');
      assert.equal(observed.mode&0o777,0o600,'Writer Quadlet permissions drift');
      if(typeof process.getuid==='function')assert.equal(observed.uid,process.getuid(),'Writer Quadlet owner drift');
      const content=await readFile(filename,'utf8');
      const image=content.match(/^Image=(\S+)$/mu)?.[1];
      assert.ok(image&&/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u.test(image),'Writer Quadlet image is not digest pinned');
      assert.ok(acceptedImages.has(image),'Writer Quadlet image is absent from controller history');
      if(slot===activeSlot)assert.equal(image,state.installed.image,'Committed writer Quadlet image drift');
      await atomicWrite(filename,imageConfig({image,profile:this.runtime.profile},this.authEnvironment,this.runtime).replace('PLACEHOLDER',name(slot)));
    }
    run('systemctl',['--user','daemon-reload']);
    for(const slot of ['blue','green']){
      const filename=path.join(this.config.quadletDirectory,name(slot)+'.container');
      try{await lstat(filename);}catch(error){if(error.code==='ENOENT'&&slot!==activeSlot)continue;throw error;}
      assertRuntimeUnitDropIns(run('systemctl',['--user','show','--property=DropInPaths','--value',activeUnit(slot)]));
    }
  }
  async fetchChannel(){
    const token=(await readFile(this.config.githubTokenFile,'utf8')).trim();
    if(!token)throw Error('GitHub channel read credential unavailable');
    return boundedJson(channelUrl,{Authorization:'Bearer '+token,Accept:'application/vnd.github.raw+json','X-GitHub-Api-Version':'2022-11-28'});
  }
  async frontendIdentity(){
    const headers={};
    if(this.config.accessClientIdFile){
      headers['CF-Access-Client-Id']=(await readFile(this.config.accessClientIdFile,'utf8')).trim();
      headers['CF-Access-Client-Secret']=(await readFile(this.config.accessClientSecretFile,'utf8')).trim();
      assert.ok(headers['CF-Access-Client-Id']&&headers['CF-Access-Client-Secret'],'Missing Access service credentials');
    }
    return validateFrontendIdentity(await boundedJson(this.url,headers,16384));
  }
  async observe(){
    // Legacy single-slot Quadlet must be disabled before this topology is used.
    const legacy=inspect('codexia-api');
    if(legacy?.State.Running)throw Error('Legacy API writer is still running');
    const route=(await readFile(this.config.routeFile,'utf8')).trim();
    assert.ok(['blue','green','blocked'].includes(route),'Invalid proxy route');
    const writers=[];
    for(const slot of ['blue','green']){
      const observed=inspect(name(slot));
      if(observed?.State.Running){
        const configured=observed.ImageName??observed.Config?.Image;
        if(typeof configured!=='string')throw Error('Running writer image unobservable');
        if(this.runtime){
          const image=JSON.parse(run('podman',['image','inspect',configured]))[0];
          const expectedUnit=imageConfig({image:configured,profile:this.runtime.profile},this.authEnvironment,this.runtime).replace('PLACEHOLDER',name(slot));
          assertRuntimeObservation(observed,this.runtime,image.Config?.Env,expectedUnit);
          assertRuntimeUnitDropIns(run('systemctl',['--user','show','--property=DropInPaths','--value',activeUnit(slot)]));
          assertRuntimeUnit(run('systemctl',['--user','cat',activeUnit(slot)]),this.runtime);
          await assertRuntimeSystemdCpuQuota(activeUnit(slot),this.runtime);
        }
        writers.push({slot,image:configured});
      }
    }
    return {route,writers};
  }
  async route(slot){
    assert.ok(['blue','green','blocked'].includes(slot));
    await atomicWrite(this.config.routeFile,slot+'\n');
  }
  async pullAndVerify(value){
    const release=validateUpdateRelease(value);
    const local=spawnSync('podman',['image','exists',release.image],{timeout:15000,stdio:'ignore'});
    if(local.status===1)run('podman',['pull','--arch','amd64',release.image],{timeout:300000});
    else if(local.status!==0)throw Error('Local artifact availability unobservable');
    const image=JSON.parse(run('podman',['image','inspect',release.image]))[0];
    assert.ok(image.RepoDigests?.includes(release.image),'Pulled image digest mismatch');
    assert.equal(image.Os+'/'+image.Architecture,release.platform);
    assert.equal(image.Labels?.['org.opencontainers.image.revision']??image.Config?.Labels?.['org.opencontainers.image.revision'],release.sourceSha);
    const isolated=['run','--rm','--network','none','--read-only','--cap-drop','all','--security-opt','no-new-privileges','--entrypoint'];
    const identity=JSON.parse(run('podman',[...isolated,'cat',release.image,'/app/update-identity.json']));
    assert.equal(identity.format,'codexia-backend-identity/v1');
    for(const field of ['version','sourceSha','platform','profile','migrationFingerprint','persistenceFormat','apiEpoch'])assert.equal(identity[field],release[field],'Artifact '+field+' mismatch');
    assert.equal(run('podman',[...isolated,'node',release.image,'--input-type=module','-e',fingerprintCode]),release.migrationFingerprint);
  }
  async assertLegacyRelease(value){
    const release=validateUpdateRelease(value);
    const legacy=inspect('codexia-api');
    assert.ok(legacy?.State.Running,'Legacy writer must be running the selected release');
    for(const slot of ['blue','green'])assert.ok(!inspect(name(slot))?.State.Running,'Unexpected running slot writer');
    const image=JSON.parse(run('podman',['image','inspect',release.image]))[0];
    const imageId=id=>typeof id==='string'?id.replace(/^sha256:/u,''):'';
    const actual=imageId(legacy.Image);
    assert.match(actual,/^[a-f0-9]{64}$/u,'Legacy image ID is unobservable');
    assert.equal(actual,imageId(image.Id),'Legacy writer image differs from selected immutable release');
    assert.ok(image.RepoDigests?.includes(release.image),'Selected release digest is unobservable');
    const version=JSON.parse(run('podman',['exec','codexia-api','node','--input-type=module','-e',readyCode],{timeout:10000}));
    assertVersion(version,release,this.authEnvironment.CODEXIA_BROWSER_AUTH);
    if(this.runtime){
      const expectedUnit=imageConfig(release,this.authEnvironment,this.runtime).replace('PLACEHOLDER','codexia-api');
      assertRuntimeObservation(legacy,this.runtime,image.Config?.Env,expectedUnit);
      assertRuntimeUnitDropIns(run('systemctl',['--user','show','--property=DropInPaths','--value','codexia-api.service']));
      assertRuntimeUnit(run('systemctl',['--user','cat','codexia-api.service']),this.runtime);
      await assertRuntimeSystemdCpuQuota('codexia-api.service',this.runtime);
    }
    const env=legacy.Config?.Env;
    assert.ok(Array.isArray(env),'Legacy browser auth settings are unobservable');
    for(const [key,value] of Object.entries(this.authEnvironment)){
      const actual=env.find(entry=>entry.startsWith(key+'='))?.slice(key.length+1);
      assert.equal(actual??(key==='CODEXIA_BROWSER_AUTH'?'token':undefined),value,'Legacy browser authentication configuration mismatch: '+key);
    }
  }
  async waitReady(container,release){
    const deadline=Date.now()+90000;
    for(;;){
      try{const version=JSON.parse(run('podman',['exec',container,'node','--input-type=module','-e',readyCode],{timeout:10000}));assertVersion(version,release,this.authEnvironment.CODEXIA_BROWSER_AUTH);return;}catch(error){if(Date.now()>=deadline||!inspect(container)?.State.Running)throw Error('Candidate did not become ready: '+container);}
      await delay(1000);
    }
  }
  async prepare(slot,release){
    validateUpdateRelease(release);
    await this.stopPreflight(slot);
    // Only the preflight password is available; the real writer credential and shared volumes are absent.
    const auth=randomBytes(32).toString('hex');
    const runtimeArgs=this.runtime?runtimeContainerArgs(this.runtime):['--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m'];
    run('podman',['run','--detach','--name',preflight(slot),'--network','codexia-data',
      '--read-only',...runtimeArgs,'--tmpfs','/data:rw,nosuid,nodev,noexec,size=128m,mode=1777',
      '--tmpfs','/history:rw,nosuid,nodev,noexec,size=64m,mode=1777','--cap-drop','all','--security-opt','no-new-privileges',
      '--secret','codexia-postgres-preflight-password,type=mount,target=/run/secrets/app-password',
      '--env','CODEXIA_AUTH_TOKEN','--env','CODEXIA_DATABASE_PASSWORD_FILE=/run/secrets/app-password',
      '--env','CODEXIA_DATABASE_USER=codexia_preflight','--env','CODEXIA_DATABASE_HOST=codexia-db',
      '--env','CODEXIA_DATABASE_NAME=codexia','--env','PGOPTIONS=-c default_transaction_read_only=on',
      '--env','CODEXIA_DATABASE_MIGRATE_ON_START=0','--env','CODEXIA_HOSTED_MODE=0','--env','CODEXIA_PROFILE='+release.profile,
      '--env','CODEXIA_TRUST_PROXY=1',
      ...Object.entries(this.authEnvironment).flatMap(([key,value])=>['--env',key+'='+value]),
      release.image],{env:{...process.env,CODEXIA_AUTH_TOKEN:auth}});
    await this.waitReady(preflight(slot),release);
    const observed=inspect(preflight(slot));
    assert.ok(observed?.State.Running,'Preflight not running');
    assert.equal(observed.ImageName??observed.Config?.Image,release.image);
  }
  async stopPreflight(slot){
    const container=preflight(slot);
    if(exists(container))run('podman',['rm','--force','--volumes',container]);
    if(exists(container))throw Error('Preflight still exists');
  }
  async stopWriter(slot){
    const container=name(slot);
    if(unitStatus(slot)!=='inactive')run('systemctl',['--user','stop',activeUnit(slot)],{timeout:120000});
    const observed=inspect(container);
    if(observed?.State.Running||!['inactive','failed'].includes(unitStatus(slot)))throw Error('Writer fencing not confirmed');
  }
  async startWriter(slot,release){
    validateUpdateRelease(release);
    const obs=await this.observe();assert.equal(obs.writers.length,0,'Refusing second writer');
    await mkdir(this.config.quadletDirectory,{recursive:true,mode:0o700});
    if(this.runtime)assert.equal(this.runtime.profile,release.profile,'Runtime contract release profile mismatch');
    await atomicWrite(path.join(this.config.quadletDirectory,name(slot)+'.container'),imageConfig(release,this.authEnvironment,this.runtime??undefined).replace('PLACEHOLDER',name(slot)));
    run('systemctl',['--user','daemon-reload']);
    assertRuntimeUnitDropIns(run('systemctl',['--user','show','--property=DropInPaths','--value',activeUnit(slot)]));
    run('systemctl',['--user','start',activeUnit(slot)],{timeout:120000});
    await this.waitReady(name(slot),release);
    const after=await this.observe();assert.deepEqual(after.writers,[{slot,image:release.image}]);
  }
  async probe(slot,release){
    const proxyQuadlet=await readFile(path.join(this.config.quadletDirectory,'codexia-api-proxy.container'),'utf8');
    const proxyContainer=inspect('codexia-api-proxy');
    assertRuntimeUnitDropIns(run('systemctl',['--user','show','--property=DropInPaths','--value','codexia-api-proxy.service']));
    const proxyUnitState=run('systemctl',['--user','show','--property=ActiveState','--value','codexia-api-proxy.service']);
    const proxyImage=proxyQuadlet.match(/^Image=(\S+)$/mu)?.[1];
    assert.ok(proxyImage,'Private proxy image is unobservable');
    const proxyImageInfo=JSON.parse(run('podman',['image','inspect',proxyImage]))[0];
    assertProxyRuntimeObservation(proxyQuadlet,proxyContainer,proxyUnitState,proxyImageInfo,{home:path.resolve(path.dirname(this.config.stateFile),'../../..')});
    await this.waitReady(name(slot),release);
    const routed=JSON.parse(run('podman',['exec','codexia-api-proxy','node','--input-type=module','-e',proxyProbeCode],{timeout:10000}));
    assert.equal(routed.slot,slot);assertVersion(routed.version,release,this.authEnvironment.CODEXIA_BROWSER_AUTH);
    run('podman',['exec',name(slot),'node','--input-type=module','-e',authProbeCode],{timeout:10000});
  }
}
