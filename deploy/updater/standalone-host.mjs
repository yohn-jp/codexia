import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, readlink, realpath, rmdir, stat, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, switchLegacyTunnelSource } from '../../scripts/standalone-update-controller.mjs';
import { IDENTITY_PROBE_PATHS, probeScopedIdentityAccess, validateUpdateRelease } from '../../scripts/update-release-policy.mjs';

const SLOT = /^(blue|green)$/u;
const name = slot => {if(!SLOT.test(slot))throw Error('Invalid slot');return 'codexia-slot-'+slot;};
const preflight = slot => {name(slot);return 'codexia-preflight-'+slot;};
const channelUrl='https://api.github.com/repos/yohn-jp/codexia/contents/stable-channel.json?ref=codexia-stable-channel';
const modelCacheRoot='/var/cache/codexia/models';
const fingerprintCode='import { packagedMigrationFingerprint } from "@codexia/api"; console.log(await packagedMigrationFingerprint());';
const initializeSchemaCode=`import {readFileSync} from 'node:fs'; import {inspectFreshPostgresSchema,initializeFreshPostgresSchema,verifyPostgresSchema} from '@codexia/api'; const password=readFileSync('/run/secrets/app-password','utf8').replace(/\\n+$/u,''); if(!/^[a-fA-F0-9]+$/u.test(password))throw Error('Invalid database secret'); const url='postgres://codexia:'+password+'@codexia-db:5432/codexia'; if(process.argv[1]==='inspect'){console.log(JSON.stringify(await inspectFreshPostgresSchema(url)));}else{const applied=await initializeFreshPostgresSchema(url); console.log(JSON.stringify({applied,fingerprint:await verifyPostgresSchema(url)}));}`;
const additiveSchemaCode=`import {readFileSync} from 'node:fs'; import {runPostgresAdditiveMigrations,verifyPostgresSchema} from '@codexia/api'; const password=readFileSync('/run/secrets/app-password','utf8').replace(/\\n+$/u,''); if(!/^[a-fA-F0-9]+$/u.test(password))throw Error('Invalid database secret'); const url='postgres://codexia:'+password+'@codexia-db:5432/codexia'; const applied=await runPostgresAdditiveMigrations({connectionString:url},process.argv[1],process.argv[2]); console.log(JSON.stringify({applied,fingerprint:await verifyPostgresSchema(url)}));`;
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
    assert.ok(value.modelCachePath===modelCacheRoot||value.modelCachePath.startsWith(modelCacheRoot+path.sep),'Model cache path must remain inside the dedicated /var/cache/codexia/models artifact tree');
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
  assert.ok(typeof modelCachePath==='string'&&(modelCachePath===modelCacheRoot||modelCachePath.startsWith(modelCacheRoot+path.sep)),'Model cache path must remain inside the dedicated /var/cache/codexia/models artifact tree');
  assert.ok(path.isAbsolute(modelCachePath)&&path.resolve(modelCachePath)===modelCachePath,'Model cache path must be normalized and absolute');
  for(const mountpoint of volumeMountpoints){
    assert.ok(path.isAbsolute(mountpoint)&&path.resolve(mountpoint)===mountpoint,'Persistent volume mountpoint is unobservable');
    assert.ok(modelCachePath!==mountpoint&&!modelCachePath.startsWith(mountpoint+path.sep)&&!mountpoint.startsWith(modelCachePath+path.sep),'Model cache must be outside persistent Codexia volumes');
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
  const declaredName=unitText.match(/^ContainerName=(\S+)$/mu)?.[1];
  assert.ok(declaredName,label+' Quadlet container name is unobservable');
  const containerName=typeof container?.Name==='string'?container.Name.replace(/^\//u,''):'';
  assert.equal(containerName,declaredName,label+' Podman container name drift');
  assert.match(container?.Id??'',/^[a-f0-9]{64}$/u,label+' Podman container ID is unobservable');
  const generatedHostname=container.Id.slice(0,12);
  assert.equal(container.Config?.Hostname,generatedHostname,label+' Podman-generated hostname drift');
  for(const [key,value] of actual){
    if(expected.has(key))continue;
    if(key==='container'&&value==='podman')continue;
    if(key==='HOSTNAME'&&value===generatedHostname)continue;
    if(key==='HOME'&&value==='/root'&&['','0','root'].includes(container.Config?.User??''))continue;
    assert.fail(label+' contains an unexpected runtime environment setting: '+key);
  }
}

function assertTmpfsOptions(observed,expected,label){
  assert.equal(typeof observed,'string',label+' is unobservable');
  const actualOptions=observed.split(',');
  const expectedOptions=expected.split(',');
  assert.equal(new Set(actualOptions).size,actualOptions.length,label+' contains duplicate options');
  assert.ok(expectedOptions.every(option=>actualOptions.includes(option)),label+' drift');
  const podmanOptions=new Set(['rprivate','tmpcopyup']);
  assert.ok(actualOptions.every(option=>expectedOptions.includes(option)||podmanOptions.has(option)),label+' drift');
}

export function assertRuntimeCapabilitiesDropped(container,status,label='Runtime'){
  // Podman normalizes DropCapability=all in inspect; the live process masks are the security proof.
  const additions=container?.HostConfig?.CapAdd;
  assert.ok(additions===undefined||additions===null||Array.isArray(additions),label+' capability additions are unobservable');
  assert.deepEqual(additions??[],[],label+' has unexpected capability additions');
  assert.equal(typeof status,'string',label+' capability status is unobservable');
  const lines=status.split(/\r?\n/u);
  for(const key of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']){
    const matching=lines.filter(line=>line.startsWith(key+':'));
    assert.equal(matching.length,1,key+' is unobservable');
    const match=new RegExp('^'+key+':\\s*([0-9a-f]+)\\s*$','iu').exec(matching[0]);
    assert.ok(match,key+' is unobservable');
    assert.equal(BigInt('0x'+match[1]),0n,key+' must be zero for '+label);
  }
}

export async function readRuntimeCapabilityStatus(container,label='Runtime'){
  const pid=container?.State?.Pid;
  assert.ok(Number.isSafeInteger(pid)&&pid>1,label+' PID must be numeric and positive');
  return readFile(`/proc/${pid}/status`,'utf8');
}

export function assertRuntimeObservation(container,value,imageEnvironment,unitText,capabilityStatus){
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
  // Podman may omit tmpfs pseudo-mounts from Mounts; HostConfig.Tmpfs is checked below.
  assert.equal(actual.length,persistent.length+tmpfsMounts.length,'Legacy runtime contains an unsupported mount type');
  assert.equal(container.HostConfig?.Memory??0,runtime.resources.memoryMaxBytes??0,'Legacy memory limit drift');
  assert.equal(container.HostConfig?.CpuQuota??0,0,'Legacy writer has an unexpected container CPU quota');
  const tmpfs=container.HostConfig?.Tmpfs;
  assert.ok(tmpfs&&typeof tmpfs==='object','Legacy tmpfs settings are unobservable');
  assert.deepEqual(Object.keys(tmpfs).sort(),['/cache','/tmp'],'Legacy tmpfs mount set drift');
  assertTmpfsOptions(tmpfs['/tmp'],`rw,nosuid,nodev,noexec,size=${runtime.tmpfs.tempSize}`,'Legacy temporary filesystem');
  assertTmpfsOptions(tmpfs['/cache'],`rw,nosuid,nodev,noexec,size=${runtime.tmpfs.moduleCacheSize}`,'Legacy module-cache filesystem');
  const portBindings=container.HostConfig?.PortBindings;
  assert.ok(portBindings===null||portBindings&&typeof portBindings==='object'&&!Array.isArray(portBindings),'Legacy host port bindings are unobservable');
  assert.equal(Object.keys(portBindings??{}).length,0,'Legacy writer exposes a host port');
  const networks=container.NetworkSettings?.Networks;
  assert.ok(networks&&typeof networks==='object'&&!Array.isArray(networks),'Legacy writer networks are unobservable');
  assert.deepEqual(Object.keys(networks).sort(),['codexia','codexia-data'],'Legacy writer network drift');
  assert.equal(container.HostConfig?.ReadonlyRootfs,true,'Legacy writer root filesystem is not read-only');
  assertRuntimeCapabilitiesDropped(container,capabilityStatus,'Legacy writer');
  const securityOptions=container.HostConfig?.SecurityOpt;
  assert.ok(Array.isArray(securityOptions),'Legacy writer security options are unobservable');
  assert.equal(securityOptions.length,1,'Legacy writer security options drift');
  assert.match(securityOptions[0],/^no-new-privileges(?::true)?$/iu,'Legacy writer no-new-privileges setting is missing or has an unexpected override');
}

export function assertProxyRuntimeObservation(quadletText,container,activeState,imageInfo,{home=process.env.HOME,capabilityStatus}={}){
  const images=[...quadletText.matchAll(/^Image=(\S+)$/gmu)].map(match=>match[1]);
  assert.equal(images.length,1,'Proxy Quadlet image identity is unobservable');
  assert.match(images[0],/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u,'Proxy Quadlet image is not digest pinned');
  assert.equal(activeState,'active','Private proxy systemd unit is not active');
  assert.equal(container?.State?.Running,true,'Private proxy container is not running');
  const observed=container.ImageName??container.Config?.Image;
  assert.equal(observed,images[0],'Running private proxy image differs from its pinned Quadlet');
  assert.match(imageId(imageInfo?.Id),/^[a-f0-9]{64}$/u,'Pinned proxy image content identity is unobservable');
  assert.ok(Array.isArray(imageInfo.RepoDigests)&&imageInfo.RepoDigests.includes(images[0]),'Pinned proxy digest is not present in the local image');
  assert.equal(imageId(container.Image),imageId(imageInfo.Id),'Running private proxy container uses different image content');
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
  assertRuntimeCapabilitiesDropped(container,capabilityStatus,'Private proxy');
  assert.ok(Array.isArray(hostConfig?.SecurityOpt),'Private proxy security options are unobservable');
  assert.equal(hostConfig.SecurityOpt.length,1,'Private proxy security options drift');
  assert.match(hostConfig.SecurityOpt[0],/^no-new-privileges(?::true)?$/iu,'Private proxy no-new-privileges setting is missing or has an unexpected override');
  assertTmpfsOptions(hostConfig?.Tmpfs?.['/tmp'],'rw,nosuid,nodev,noexec,size=16m','Private proxy temporary filesystem');
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

export function assertRuntimeProcessCgroup(processCgroupText,controlGroup,label='Runtime'){
  assert.ok(typeof controlGroup==='string'&&controlGroup.startsWith('/')&&controlGroup!=='/'&&path.posix.normalize(controlGroup)===controlGroup,'Systemd control group path is invalid');
  assert.ok(typeof processCgroupText==='string',label+' unified cgroup membership is unobservable');
  const unified=processCgroupText.split(/\r?\n/u).filter(line=>line.startsWith('0::'));
  assert.equal(unified.length,1,label+' unified cgroup membership is unobservable');
  const observed=unified[0].slice(3);
  assert.ok(observed.startsWith('/')&&observed!=='/'&&path.posix.normalize(observed)===observed,label+' process cgroup path is invalid');
  assert.ok(observed===controlGroup||observed.startsWith(controlGroup+'/'),label+' process escaped its systemd service cgroup');
  return observed;
}

export function assertRuntimeMemoryMax(memoryMax,value,label='Runtime'){
  const runtime=validateRuntimeContract(value);
  assert.ok(typeof memoryMax==='string',label+' effective memory.max is unobservable');
  const observed=memoryMax.trim();
  if(runtime.resources.memoryMaxBytes===null){
    assert.equal(observed,'max',label+' effective memory.max drift');
    return;
  }
  assert.equal(observed,String(runtime.resources.memoryMaxBytes),label+' effective memory.max drift');
}

export async function assertRuntimeProcessInSystemdUnit(unitName,container,label='Runtime'){
  const pid=container?.State?.Pid;
  assert.ok(Number.isSafeInteger(pid)&&pid>1,label+' PID must be numeric and positive');
  const controlGroup=run('systemctl',['--user','show','--property=ControlGroup','--value',unitName]).trim();
  const processCgroup=assertRuntimeProcessCgroup(await readFile(`/proc/${pid}/cgroup`,'utf8'),controlGroup,label);
  const cgroupRoot=await realpath('/sys/fs/cgroup');
  const cgroupPrefix=cgroupRoot+path.sep;
  const unitPath=await realpath(path.join(cgroupRoot,controlGroup.slice(1)));
  const processPath=await realpath(path.join(cgroupRoot,processCgroup.slice(1)));
  assert.ok(unitPath.startsWith(cgroupPrefix),label+' systemd service cgroup escapes the cgroup root');
  assert.ok(processPath.startsWith(cgroupPrefix),label+' process cgroup escapes the cgroup root');
  assert.ok(processPath===unitPath||processPath.startsWith(unitPath+path.sep),label+' process escaped its systemd service cgroup');
  return processPath;
}

export async function assertRuntimeProcessMemoryMax(processCgroupPath,value,label='Runtime'){
  const cgroupRoot=await realpath('/sys/fs/cgroup');
  const cgroupPrefix=cgroupRoot+path.sep;
  assert.ok(typeof processCgroupPath==='string'&&path.isAbsolute(processCgroupPath)&&path.resolve(processCgroupPath)===processCgroupPath&&processCgroupPath.startsWith(cgroupPrefix),label+' process cgroup path is invalid');
  const memoryPath=await realpath(path.join(processCgroupPath,'memory.max'));
  assert.ok(memoryPath.startsWith(cgroupPrefix),label+' memory limit path escapes the cgroup root');
  assertRuntimeMemoryMax(await readFile(memoryPath,'utf8'),value,label);
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
export function runWithSensitiveInput(binary,args,input,{timeout=120000,env=process.env}={}){
  assert.ok(typeof binary==='string'&&Array.isArray(args)&&args.every(value=>typeof value==='string'));
  assert.ok(typeof input==='string'||Buffer.isBuffer(input),'Sensitive command input must be bytes');
  const result=spawnSync(binary,args,{encoding:'utf8',input,timeout,maxBuffer:4*1024*1024,env,stdio:['pipe','pipe','pipe']});
  if(result.error||result.status!==0){
    let diagnostic=String(result.stderr??'').slice(0,4096);
    const sensitiveLines=[...new Set(String(input).split(/\r?\n/u).filter(line=>line.length>=8))];
    for(const line of sensitiveLines)diagnostic=diagnostic.replaceAll(line,'[redacted]');
    throw new Error(binary+' '+String(args[0]??'')+' failed (status '+String(result.status??'unknown')+')'+(diagnostic?': '+diagnostic.trim() : ''));
  }
  return result.stdout;
}
export function validatePostgresAppPassword(content){
  assert.ok(typeof content==='string'&&Buffer.byteLength(content)<=8192&&/^[a-fA-F0-9]{64}(?:\n)?$/u.test(content),
    'Invalid protected app password');
  return content;
}
export function postgresAppPasswordChangeInput(content){
  const password=validatePostgresAppPassword(content).replace(/\n$/u,'');
  return '\\password codexia\n'+password+'\n'+password+'\n';
}
const appSecret='codexia-postgres-app-password';
const rotationLabel='io.codexia.app-password-rotation';
const authTokenSecret='codexia-auth-token';
const authTokenRotationLabel='io.codexia.auth-token-rotation';
const tunnelTokenSecret='codexia-tunnel-token';
const tunnelTokenRotationLabel='io.codexia.tunnel-token-rotation';
const databaseUnit='codexia-db.service';
export function validateStandaloneTunnelToken(content){
  assert.ok(typeof content==='string'&&Buffer.byteLength(content)<=8192&&/^[!-~]+(?:\n)?$/u.test(content),
    'Invalid protected Tunnel token');
  return content;
}
function readTunnelTokenSecret(){
  const result=spawnSync('podman',['secret','exists',tunnelTokenSecret],{stdio:'ignore',timeout:15000});
  if(result.status===1)return null;
  assert.equal(result.status,0,'Podman Tunnel secret existence is unobservable');
  try{
    const [secret]=JSON.parse(runWithSensitiveInput('podman',['secret','inspect','--showsecret',tunnelTokenSecret],''));
    assert.ok(secret.Spec.Name===tunnelTokenSecret&&typeof secret.ID==='string'&&secret.ID);
    return {id:secret.ID,owner:secret.Spec.Labels?.[tunnelTokenRotationLabel],token:validateStandaloneTunnelToken(secret.SecretData)};
  }catch{throw Error('Canonical Tunnel secret is unobservable');}
}
function assertKnownTunnelTokenSecret(secret,snapshot){
  if(!secret)return;
  const digest=sha256(secret.token);
  assert.ok((secret.id===snapshot.originalSecretId&&digest===snapshot.previousDigest)||
    (secret.owner===snapshot.operationId&&[snapshot.previousDigest,snapshot.replacementDigest].includes(digest)),
    'Unrecognized canonical Tunnel secret prevents recovery');
}
function readRotationSecret(secretName){
  const result=spawnSync('podman',['secret','exists',secretName],{stdio:'ignore',timeout:15000});
  if(result.status===1)return null;
  assert.equal(result.status,0,'Podman secret existence is unobservable');
  try{
    const [secret]=JSON.parse(runWithSensitiveInput('podman',['secret','inspect','--showsecret',secretName],''));
    assert.ok(secret.Spec.Name===secretName&&typeof secret.ID==='string'&&secret.ID);
    return {id:secret.ID,owner:secret.Spec.Labels?.[rotationLabel],password:validatePostgresAppPassword(secret.SecretData)};
  }catch{throw Error('Canonical PostgreSQL secret is unobservable');}
}
export function validateStandaloneAuthToken(content){
  assert.ok(typeof content==='string'&&Buffer.byteLength(content)<=8192&&/^[!-~]{32,8192}(?:\n)?$/u.test(content),
    'Invalid protected standalone API token');
  return content;
}
function readAuthTokenSecret(){
  const result=spawnSync('podman',['secret','exists',authTokenSecret],{stdio:'ignore',timeout:15000});
  if(result.status===1)return null;
  assert.equal(result.status,0,'Podman API token secret existence is unobservable');
  try{
    const [secret]=JSON.parse(runWithSensitiveInput('podman',['secret','inspect','--showsecret',authTokenSecret],''));
    assert.ok(secret.Spec.Name===authTokenSecret&&typeof secret.ID==='string'&&secret.ID);
    return {id:secret.ID,owner:secret.Spec.Labels?.[authTokenRotationLabel],token:validateStandaloneAuthToken(secret.SecretData)};
  }catch{throw Error('Canonical API token secret is unobservable');}
}
function assertKnownAuthTokenSecret(secret,snapshot){
  if(!secret)return;
  const digest=sha256(secret.token);
  assert.ok((secret.id===snapshot.originalSecretId&&digest===snapshot.previousDigest)||
    (secret.owner===snapshot.operationId&&[snapshot.previousDigest,snapshot.replacementDigest].includes(digest)),
    'Unrecognized canonical API token prevents recovery');
}
export function assertApiAuthTokenSecretIdentity(secret,snapshot,expectedDigest=null){
  assert.ok(secret,'Canonical API token secret is missing');
  assertKnownAuthTokenSecret(secret,snapshot);
  if(expectedDigest===null)return;
  const digest=sha256(secret.token);
  const matchesPrevious=expectedDigest===snapshot.previousDigest&&digest===snapshot.previousDigest&&
    (secret.id===snapshot.originalSecretId||secret.owner===snapshot.operationId);
  const matchesReplacement=expectedDigest===snapshot.replacementDigest&&digest===snapshot.replacementDigest&&
    secret.owner===snapshot.operationId;
  assert.ok(matchesPrevious||matchesReplacement,'Canonical API token secret does not match the committed rotation');
}
function assertKnownRotationSecret(secret,snapshot){
  if(!secret)return;
  const digest=sha256(secret.password);
  assert.ok((secret.id===snapshot.originalSecretId&&digest===snapshot.previousDigest)||
    (secret.owner===snapshot.operationId&&[snapshot.previousDigest,snapshot.replacementDigest].includes(digest)),
    'Unrecognized canonical app secret prevents recovery');
}
async function prepareRotationSecretInput(config,snapshot,password,inputName='postgres-app-password-input'){
  assert.ok(['postgres-app-password-input','api-auth-token-input','tunnel-token-input'].includes(inputName),'Unsupported maintenance secret input');
  assert.match(snapshot.operationId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    'Rotation secret input operation identity is invalid');
  const root=path.join(path.dirname(config.publicKeyFile),'maintenance-snapshots',snapshot.operationId);
  const directory=await lstat(root);
  assert.ok(directory.isDirectory()&&!directory.isSymbolicLink(),'Rotation secret input directory is not a private directory');
  assert.equal(directory.mode&0o777,0o700,'Rotation secret input directory permissions drift');
  if(typeof process.getuid==='function')assert.equal(directory.uid,process.getuid(),'Rotation secret input directory owner drift');
  assert.equal(await realpath(root),path.resolve(root),'Rotation secret input directory cannot traverse a symlink');
  assert.ok([snapshot.previousDigest,snapshot.replacementDigest].includes(sha256(password)),
    'Rotation secret input is not bound to the recovery snapshot');
  const filename=path.join(root,inputName);
  let info;
  try{info=await lstat(filename);}catch(error){if(error.code!=='ENOENT')throw error;}
  let handle;
  if(info){
    assert.ok(info.isFile()&&!info.isSymbolicLink(),'Unexpected existing rotation secret input');
    assert.equal(info.mode&0o777,0o600,'Existing rotation secret input permissions drift');
    if(typeof process.getuid==='function')assert.equal(info.uid,process.getuid(),'Existing rotation secret input owner drift');
    // This fixed temporary path is never an authority for credentials. A
    // power loss can leave a partial file, so overwrite it only after proving
    // its private directory, owner, mode and inode.
    handle=await open(filename,'r+');
    const opened=await handle.stat();
    assert.ok(opened.isFile()&&opened.dev===info.dev&&opened.ino===info.ino,'Rotation secret input changed while opening');
    await handle.truncate(0);
  }else handle=await open(filename,'wx',0o600);
  try{await handle.writeFile(password);await handle.sync();}
  finally{await handle.close();}
  const written=await lstat(filename);
  assert.ok(written.isFile()&&!written.isSymbolicLink()&&(written.mode&0o777)===0o600,
    'Rotation secret input was not written as a protected regular file');
  return filename;
}
async function removeRotationSecretInput(filename){
  let info;
  try{info=await lstat(filename);}catch(error){if(error.code==='ENOENT')return;throw error;}
  assert.ok(info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o777)===0o600,
    'Refusing to remove a changed rotation secret input');
  if(typeof process.getuid==='function')assert.equal(info.uid,process.getuid(),'Rotation secret input owner changed');
  assert.equal(await realpath(path.dirname(filename)),path.dirname(filename),'Rotation secret input parent changed');
  await unlink(filename);
}
export function assertPasswordRotationDbUnit({properties,sourcePath,runtimeDir,source,reviewed}){
  assert.equal(properties.LoadState,'loaded','Database service is not loaded');
  assert.equal(properties.NeedDaemonReload,'no','Database unit requires reload');
  for(const field of ['RequiredBy','BoundBy','ConsistsOf','PropagatesStopTo']){
    assert.equal(typeof properties[field],'string','Database unit stop dependencies are unobservable');
    assert.ok(properties[field].split(/\s+/u).filter(Boolean).every(unit=>/^codexia-slot-(blue|green)\.service$/u.test(unit)),
      'Stopping database would affect an unreviewed service');
  }
  assert.equal(properties.SourcePath,sourcePath,'Database source path drift');
  assert.ok(path.isAbsolute(runtimeDir??''),'Rootless runtime directory unavailable');
  assert.equal(properties.FragmentPath,path.join(runtimeDir,'systemd','generator',databaseUnit),'Database is not the generated Quadlet');
  assertRuntimeUnitDropIns(properties.DropInPaths);
  assert.ok(source===reviewed,'Database Quadlet differs from the reviewed content');
  assert.equal(quadletField(source,'ContainerName'),'codexia-db');
  assert.match(quadletField(source,'Image'),/^docker\.io\/library\/postgres:17-bookworm@sha256:[0-9a-f]{64}$/u);
  assert.ok(source.split('\n').includes('Volume=codexia-postgres.volume:/var/lib/postgresql/data'));
}
export function assertPasswordRotationDatabaseRuntime({container,image,volumePath,networkId}){
  assert.ok(container.State.Running&&container.HostConfig.ReadonlyRootfs,'Database container is not the running read-only runtime');
  assert.ok([image,image.replace(':17-bookworm@','@')].includes(container.Config.Image),'Database runtime image drift');
  assert.deepEqual(Object.keys(container.HostConfig.PortBindings??{}),[],'Database publishes a host port');
  const networks=container.NetworkSettings.Networks;
  assert.deepEqual(Object.keys(networks),['codexia-data'],'Database network drift');
  assert.equal(networks['codexia-data'].NetworkID,networkId,'Database network identity changed');
  const mounts=container.Mounts.filter(m=>m.Type!=='tmpfs');
  assert.ok(container.Mounts.filter(m=>m.Type==='tmpfs').every(m=>m.RW===true&&['/tmp','/var/run/postgresql'].includes(m.Destination)),
    'Unexpected database tmpfs mount');
  assert.equal(mounts.length,2,'Unexpected database mount');
  assert.ok(mounts.some(m=>m.Type==='volume'&&m.Name==='codexia-postgres'&&m.Source===volumePath&&m.RW===true&&m.Destination==='/var/lib/postgresql/data'));
  assert.ok(mounts.some(m=>m.Type==='bind'&&!m.RW&&m.Source==='/etc/codexia/postgres/010-create-app-role.sh'&&m.Destination==='/docker-entrypoint-initdb.d/010-create-app-role.sh'));
  for(const value of ['PGDATA=/var/lib/postgresql/data/pgdata','POSTGRES_DB=codexia','POSTGRES_USER=codexia_admin','POSTGRES_PASSWORD_FILE=/run/secrets/admin-password']){
    assert.ok(container.Config.Env.includes(value),'Database bootstrap environment changed');
  }
}
function passwordRotationPsql(role,input){
  const admin=role==='codexia_admin';
  const credential=admin?'admin-password':'app-password';
  const command='export PGPASSWORD="$(cat /run/secrets/'+credential+')"; exec psql -X -w -qAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U '+role+' -d codexia';
  return runWithSensitiveInput('podman',['exec','-i','codexia-db','sh','-ec',command],input);
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
export function assertLegacyApiStoppedState(result,container){
  if(result?.stdout?.trim()!=='failed')return false;
  assert.notEqual(result.status,0,'Failed legacy API unit unexpectedly reported success');
  assert.equal(container,null,'Failed legacy API unit still has a Podman container');
  return true;
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
export function assertLegacyBackupIdentity({legacy,image,version},release,authEnvironment,{requireRunning=true}={}){
  assert.ok(legacy?.State&&typeof legacy.State.Running==='boolean','Legacy writer state is unobservable');
  if(requireRunning)assert.ok(legacy.State.Running,'Legacy writer must be running the selected release');
  const imageId=id=>typeof id==='string'?id.replace(/^sha256:/u,''):'';
  const actual=imageId(legacy.Image);
  assert.match(actual,/^[a-f0-9]{64}$/u,'Legacy image ID is unobservable');
  assert.equal(actual,imageId(image?.Id),'Legacy writer image differs from selected immutable release');
  assert.ok(image?.RepoDigests?.includes(release.image),'Selected release digest is unobservable');
  assert.equal(image.Os+'/'+image.Architecture,release.platform,'Legacy image platform differs from selected release');
  assert.equal(image.Labels?.['org.opencontainers.image.revision']??image.Config?.Labels?.['org.opencontainers.image.revision'],release.sourceSha,'Legacy image source differs from selected release');
  if(legacy.State.Running){
    assert.ok(version&&typeof version==='object','Running legacy API identity is unobservable');
    // Only the absent epoch is tolerated for an old legacy runtime. If it advertises
    // an epoch, all ordinary version/profile/auth checks remain exact.
    const observedVersion=version.apiEpoch===undefined?{...version,apiEpoch:release.apiEpoch}:version;
    assertVersion(observedVersion,release,authEnvironment.CODEXIA_BROWSER_AUTH);
  }else assert.ok(!requireRunning,'Stopped legacy writer cannot prove its running API identity');
  const env=legacy.Config?.Env;
  assert.ok(Array.isArray(env),'Legacy browser auth settings are unobservable');
  for(const [key,value] of Object.entries(authEnvironment)){
    const actual=env.find(entry=>entry.startsWith(key+'='))?.slice(key.length+1);
    assert.equal(actual??(key==='CODEXIA_BROWSER_AUTH'?'token':undefined),value,'Legacy browser authentication configuration mismatch: '+key);
  }
}
function sha256(value){return createHash('sha256').update(value).digest('hex');}
export function normalizePostgresRotationNetworks(networks,containerId,generatedHostname){
  assert.ok(Array.isArray(networks),'PostgreSQL runtime networks are unobservable');
  assert.match(containerId,/^[a-f0-9]{64}$/u,'PostgreSQL runtime container ID is invalid');
  assert.match(generatedHostname,/^[a-f0-9]{12}$/u,'PostgreSQL runtime hostname is invalid');
  return networks.map(network=>({...network,Aliases:[...(network.Aliases??[])].filter(alias=>alias!==containerId&&alias!==generatedHostname).sort()}));
}
export function postgresRotationRuntimeFingerprint(projection){
  assert.ok(projection&&typeof projection==='object'&&!Array.isArray(projection),'PostgreSQL runtime fingerprint projection is invalid');
  const components=Object.fromEntries(Object.entries(projection).map(([name,value])=>[name,sha256(JSON.stringify(value))]));
  if(Array.isArray(projection.Networks))for(const network of projection.Networks){
    assert.match(network?.name??'',/^[A-Za-z0-9_.-]+$/u,'PostgreSQL runtime network name is invalid');
    for(const field of ['NetworkID','Aliases','Links','DriverOpts'])if(Object.hasOwn(network,field)){
      components[`Networks.${network.name}.${field}`]=sha256(JSON.stringify(network[field]));
    }
  }
  return {digest:sha256(JSON.stringify(projection)),components};
}
export function assertPostgresRotationRuntimeFingerprint(snapshot,projection){
  const actual=postgresRotationRuntimeFingerprint(projection);
  assert.ok(snapshot.runtimeComponents&&typeof snapshot.runtimeComponents==='object'&&!Array.isArray(snapshot.runtimeComponents),
    'PostgreSQL runtime recovery components are unobservable');
  const changed=[...new Set([...Object.keys(snapshot.runtimeComponents),...Object.keys(actual.components)])]
    .filter(name=>snapshot.runtimeComponents[name]!==actual.components[name]).sort();
  assert.equal(actual.digest,snapshot.runtimeDigest,'Database runtime ownership changed'+(changed.length?' (components: '+changed.join(', ')+')':''));
  assert.deepEqual(changed,[],'PostgreSQL runtime recovery components changed');
  return actual.digest;
}
function imageId(value){return typeof value==='string'?value.replace(/^sha256:/u,''):'';}
function imageRepository(reference){const name=reference.split('@',1)[0];const slash=name.lastIndexOf('/');return name.slice(0,slash+1)+name.slice(slash+1).split(':',1)[0];}
function imageHasDigest(image,reference){
  const digest=reference.match(/@sha256:([a-f0-9]{64})$/u)?.[1];
  return Boolean(digest&&image?.RepoDigests?.some(actual=>actual.endsWith('@sha256:'+digest)&&imageRepository(actual)===imageRepository(reference)));
}
function systemdProperties(text){
  return Object.fromEntries(text.split(/\r?\n/u).filter(Boolean).map(line=>{
    const split=line.indexOf('=');assert.ok(split>0,'Systemd unit property output is malformed');
    return [line.slice(0,split),line.slice(split+1)];
  }));
}
async function syncDirectory(directory){const handle=await open(directory,'r');try{await handle.sync();}finally{await handle.close();}}
export async function ensureDirectoryTreeDurable(directory){
  const absolute=path.resolve(directory),root=path.parse(absolute).root;
  let current=root;
  for(const part of absolute.slice(root.length).split(path.sep).filter(Boolean)){
    const next=path.join(current,part);
    let created=false;
    try{await lstat(next);}catch(error){
      if(error.code!=='ENOENT')throw error;
      await mkdir(next,{mode:0o700});created=true;
    }
    const metadata=await lstat(next);
    assert.ok(metadata.isDirectory()&&!metadata.isSymbolicLink(),'Backup recovery fence path must contain only real directories');
    if(created){await syncDirectory(current);await syncDirectory(next);}
    current=next;
  }
  const metadata=await lstat(absolute);
  if(typeof process.getuid==='function')assert.equal(metadata.uid,process.getuid(),'Backup recovery fence directory owner differs from service user');
  assert.equal(metadata.mode&0o022,0,'Backup recovery fence directory is group/world writable');
}
async function regularPrivateText(filename,{privateOnly=false}={}){
  const metadata=await lstat(filename);
  assert.ok(metadata.isFile()&&!metadata.isSymbolicLink(),'Legacy systemd/Quadlet source must be a regular file');
  if(typeof process.getuid==='function')assert.equal(metadata.uid,process.getuid(),'Legacy systemd/Quadlet source owner differs from service user');
  if(privateOnly)assert.equal(metadata.mode&0o077,0,'Backup recovery fence permissions must be private');
  else assert.equal(metadata.mode&0o022,0,'Legacy systemd/Quadlet source must not be group/world writable');
  return readFile(filename,'utf8');
}
function quadletField(text,name){
  const values=text.split(/\r?\n/u).filter(line=>line.startsWith(name+'=')).map(line=>line.slice(name.length+1));
  assert.equal(values.length,1,'Legacy Quadlet must declare exactly one '+name);
  assert.ok(values[0]&&!/[\r\n\s]/u.test(values[0]),'Legacy Quadlet '+name+' is malformed');
  return values[0];
}
export function assertLegacyBackupUnitIdentity({source,fragment,sourcePath,fragmentPath,quadletImage,selectedImage,secretIdentities=[]},release){
  release=validateUpdateRelease(release);
  assert.equal(quadletField(source,'ContainerName'),'codexia-api');
  const sourceImage=quadletField(source,'Image');
  assert.ok(fragment.split(/\r?\n/u).some(line=>line.startsWith('ExecStart=')&&line.includes(sourceImage)),'Generated API unit does not start the image declared by its Quadlet');
  assert.equal(imageId(quadletImage?.Id),imageId(selectedImage?.Id),'Legacy Quadlet image does not resolve to the signed release image');
  assert.ok(selectedImage?.RepoDigests?.includes(release.image),'Signed legacy release digest is unavailable locally');
  assert.equal(selectedImage.Os+'/'+selectedImage.Architecture,release.platform,'Signed legacy release platform differs from its image');
  assert.equal(selectedImage.Labels?.['org.opencontainers.image.revision']??selectedImage.Config?.Labels?.['org.opencontainers.image.revision'],release.sourceSha,'Signed legacy release source differs from its image');
  return sha256(JSON.stringify(canonical({sourcePath,source,fragmentPath,fragment,sourceImage,secretIdentities:safeSecretIdentities(secretIdentities)})));
}
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])]));
  return value;
}
function safeEnvironment(values){
  assert.ok(Array.isArray(values),'Container environment is unobservable');
  return values.map(entry=>{
    assert.equal(typeof entry,'string','Container environment entry is malformed');
    const split=entry.indexOf('=');assert.ok(split>0,'Container environment entry is malformed');
    const key=entry.slice(0,split);
    if(/(?:TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|PRIVATE.?KEY|API.?KEY)/iu.test(key)&&!/_FILE$/iu.test(key)){
      throw Error('Plaintext secret environment prevents safe backup identity capture: '+key);
    }
    return entry;
  });
}
function assertNoSecretNamedFields(value,location='runtime'){
  if(Array.isArray(value)){for(const entry of value)assertNoSecretNamedFields(entry,location);return;}
  if(!value||typeof value!=='object')return;
  for(const [key,entry] of Object.entries(value)){
    const podmanPasswdFlag=location==='Config'&&key==='Passwd';
    if(podmanPasswdFlag)assert.equal(typeof entry,'boolean','Podman Config.Passwd must be a boolean');
    assert.ok(podmanPasswdFlag||!/(?:TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|PRIVATE.?KEY|API.?KEY)/iu.test(key)||/_FILE$/iu.test(key),
      'Potential plaintext secret in '+location+' property: '+key);
    assertNoSecretNamedFields(entry,location+'.'+key);
  }
}
function safeSecretIdentities(secretIdentities){
  assert.ok(Array.isArray(secretIdentities),'Podman secret identities are unobservable');
  return secretIdentities.map(secret=>{
    assert.deepEqual(Object.keys(secret??{}).sort(),['id','name'],'Podman secret identity contains unsupported fields');
    assert.ok(typeof secret.name==='string'&&secret.name,'Podman secret name is unobservable');
    assert.ok(typeof secret.id==='string'&&secret.id,'Podman secret ID is unobservable');
    return {name:secret.name,id:secret.id};
  }).sort((left,right)=>left.name.localeCompare(right.name));
}
function runtimeSecretIdentities(container,secretIdentities){
  const configured=container.Config?.Secrets??[];
  assert.ok(Array.isArray(configured),'Podman container secret identities are unobservable');
  const observed=safeSecretIdentities(configured.map(secret=>({name:secret?.Name??secret?.name,id:secret?.ID??secret?.Id??secret?.id})));
  const expected=safeSecretIdentities(secretIdentities);
  assert.deepEqual(observed,expected,'Podman runtime secret IDs differ from the current named secret objects');
  assert.equal(new Set(observed.map(secret=>secret.name)).size,observed.length,'Podman runtime contains a duplicate secret name');
  return observed;
}
function configuredRuntimeHostname(container){
  const command=container.Config?.CreateCommand;
  assert.ok(Array.isArray(command)&&command.every(argument=>typeof argument==='string'),'Podman container create arguments are unobservable');
  const values=[];
  for(let index=0;index<command.length;index++){
    const argument=command[index];
    if(argument==='--')break;
    if(argument==='--hostname'||argument==='-h'){
      const value=command[++index];
      assert.ok(typeof value==='string'&&value,'Podman hostname create argument is malformed');
      values.push(value);
    }else if(argument.startsWith('--hostname=')){
      const value=argument.slice('--hostname='.length);
      assert.ok(value,'Podman hostname create argument is malformed');
      values.push(value);
    }else if(argument.startsWith('-h=')){
      const value=argument.slice(3);
      assert.ok(value,'Podman hostname create argument is malformed');
      values.push(value);
    }
  }
  assert.ok(values.length<=1,'Podman hostname create argument is duplicated');
  if(values.length===0)return null;
  const hostname=values[0];
  assert.ok(hostname.length<=253&&/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(hostname),'Podman hostname create argument is malformed');
  assert.equal(container.Config.Hostname,hostname,'Podman explicit hostname differs from its inspected value');
  return hostname;
}
function configuredRuntimeEnvironment(container){
  const command=container.Config?.CreateCommand;
  assert.ok(Array.isArray(command)&&command.every(argument=>typeof argument==='string'),'Podman container create arguments are unobservable');
  const names=new Set();
  for(let index=0;index<command.length;index++){
    const argument=command[index];
    if(argument==='--')break;
    let declaration;
    if(argument==='--env'||argument==='-e'){
      declaration=command[++index];
      assert.ok(typeof declaration==='string'&&declaration.length>0,'Podman environment create argument is malformed');
    }else if(argument.startsWith('--env='))declaration=argument.slice('--env='.length);
    else if(argument.startsWith('-e='))declaration=argument.slice(3);
    else if(argument.startsWith('-e')&&argument.length>2)declaration=argument.slice(2);
    else continue;
    const name=declaration.split('=',1)[0];
    assert.match(name,/^[A-Za-z_][A-Za-z0-9_]*$/u,'Podman environment create argument is malformed');
    names.add(name);
  }
  return names;
}
function fingerprintEnvironment(container){
  const values=safeEnvironment(container.Config.Env??[]);
  const configuredHostname=configuredRuntimeHostname(container);
  const configuredEnvironment=configuredRuntimeEnvironment(container);
  if(configuredHostname===null&&!configuredEnvironment.has('HOSTNAME')){
    const hostnameEntries=values.map((entry,index)=>({entry,index})).filter(({entry})=>entry.startsWith('HOSTNAME='));
    assert.ok(hostnameEntries.length<=1,'Podman-generated HOSTNAME is ambiguous');
    if(hostnameEntries.length===1){
      const {entry,index}=hostnameEntries[0];
      const observed=entry.slice('HOSTNAME='.length);
      const inspected=container.Config.Hostname;
      const id=String(container.Id??container.ID??'').replace(/^sha256:/u,'');
      const matchesInspectedHostname=typeof inspected==='string'&&observed===inspected;
      const matchesContainerId=/^[a-f0-9]{12,64}$/u.test(id)&&observed.length>=12&&id.startsWith(observed);
      assert.ok(matchesInspectedHostname||matchesContainerId,'Podman-generated HOSTNAME does not match the inspected hostname or container ID');
      values[index]='HOSTNAME=<podman-generated>';
    }
  }
  const names=values.map(entry=>entry.slice(0,entry.indexOf('=')));
  if(new Set(names).size===names.length)values.sort((left,right)=>{
    const leftName=left.slice(0,left.indexOf('=')),rightName=right.slice(0,right.indexOf('='));
    return leftName<rightName?-1:leftName>rightName?1:0;
  });
  return values;
}
function runtimeSecretMounts(container,secretIdentities){
  const command=container.Config?.CreateCommand;
  assert.ok(Array.isArray(command)&&command.every(argument=>typeof argument==='string'),'Podman container create arguments are unobservable');
  const identities=safeSecretIdentities(secretIdentities);
  const byName=new Map(identities.map(identity=>[identity.name,identity]));
  const byId=new Map(identities.map(identity=>[identity.id,identity]));
  const mounts=[];
  for(let index=0;index<command.length;index++){
    const argument=command[index];
    if(argument==='--')break;
    let declaration;
    if(argument==='--secret'){
      declaration=command[++index];
      assert.ok(typeof declaration==='string'&&declaration.length>0,'Podman secret create argument is malformed');
    }else if(argument.startsWith('--secret=')){
      declaration=argument.slice('--secret='.length);
      assert.ok(declaration.length>0,'Podman secret create argument is malformed');
    }else continue;
    const [reference,...pairs]=declaration.split(',');
    assert.ok(reference&&!/[\r\n\0]/u.test(reference),'Podman secret reference is malformed');
    const identity=byName.get(reference)??byId.get(reference);
    assert.ok(identity,'Podman create arguments reference an unobserved secret');
    const options={};
    for(const pair of pairs){
      const separator=pair.indexOf('=');
      assert.ok(separator>0&&separator<pair.length-1,'Podman secret mount option is malformed');
      const key=pair.slice(0,separator),value=pair.slice(separator+1);
      assert.ok(['type','target','uid','gid','mode'].includes(key),'Podman secret mount option is unsupported');
      assert.ok(!Object.hasOwn(options,key),'Podman secret mount option is duplicated');
      assert.ok(!/[\r\n\0]/u.test(value),'Podman secret mount option is malformed');
      options[key]=value;
    }
    const type=options.type??'mount';
    assert.ok(type==='mount'||type==='env','Podman secret exposure type is unsupported');
    const target=options.target??identity.name;
    const normalizedTarget=type==='mount'
      ? path.posix.normalize(target.startsWith('/')?target:path.posix.join('/run/secrets',target))
      : target;
    const mount={name:identity.name,id:identity.id,type,target:normalizedTarget};
    if(type==='mount'){
      const uid=options.uid??'0',gid=options.gid??'0',mode=options.mode??'0444';
      assert.match(uid,/^\d+$/u,'Podman secret UID is malformed');
      assert.match(gid,/^\d+$/u,'Podman secret GID is malformed');
      assert.match(mode,/^(?:0?[0-7]{3,4}|\d+)$/u,'Podman secret mode is malformed');
      Object.assign(mount,{uid,gid,mode});
    }else{
      assert.ok(options.uid===undefined&&options.gid===undefined&&options.mode===undefined,'Podman env secret has mount-only options');
    }
    mounts.push(mount);
  }
  const expected=identities.map(identity=>identity.name).sort();
  const observed=mounts.map(mount=>mount.name).sort();
  assert.deepEqual(observed,expected,'Podman secret create arguments differ from the captured secret identities');
  assert.equal(new Set(observed).size,observed.length,'Podman create arguments declare a secret more than once');
  return mounts.sort((left,right)=>left.name.localeCompare(right.name));
}
export function containerRuntimeFingerprintProjection(container,secretIdentities=[]){
  assert.ok(container?.Config&&container?.HostConfig&&container?.NetworkSettings,'Container runtime configuration is unobservable');
  assert.ok(Array.isArray(container.Mounts),'Container mounts are unobservable');
  const config=container.Config,host=container.HostConfig;
  const mounts=container.Mounts.map(mount=>({
    Type:mount.Type,Name:mount.Name,Driver:mount.Driver,Destination:mount.Destination,Mode:mount.Mode,
    RW:mount.RW,Propagation:mount.Propagation,Options:mount.Options,
    ...(mount.Type==='bind'?{Source:mount.Source}:{}),
  })).sort((left,right)=>String(left.Destination).localeCompare(String(right.Destination)));
  const networks=Object.entries(container.NetworkSettings.Networks??{}).map(([name,network])=>{
    const id=network.NetworkID??network.NetworkId;
    assert.ok(typeof id==='string'&&id,'Attached Podman network identity is unobservable');
    return {name,NetworkID:id,Aliases:[...(network.Aliases??[])].sort(),Links:[...(network.Links??[])].sort(),DriverOpts:network.DriverOpts??{}};
  }).sort((left,right)=>left.name.localeCompare(right.name));
  const currentSecretIdentities=runtimeSecretIdentities(container,secretIdentities);
  const secretMounts=runtimeSecretMounts(container,currentSecretIdentities);
  const {CreateCommand:_createCommand,Secrets:_secrets,Env:_environment,Hostname:_hostname,...configSettings}=config;
  const sanitizedConfig={...configSettings,Env:fingerprintEnvironment(container),Hostname:configuredRuntimeHostname(container)};
  assertNoSecretNamedFields(sanitizedConfig,'Config');
  assertNoSecretNamedFields(host,'HostConfig');
  return canonical({
    Image:imageId(container.Image),ImageName:container.ImageName??config.Image,
    Config:sanitizedConfig,
    HostConfig:host,
    Mounts:mounts,Networks:networks,SecretMounts:secretMounts,
  });
}
export function containerRuntimeFingerprint(container,secretIdentities=[]){
  return sha256(JSON.stringify(containerRuntimeFingerprintProjection(container,secretIdentities)));
}
export function assertLegacyBackupTunnelUnitIdentity({source,fragment,sourcePath,fragmentPath,image,secretIdentities=[]}){
  assert.equal(quadletField(source,'ContainerName'),'codexia-tunnel');
  const sourceImage=quadletField(source,'Image');
  assert.match(sourceImage,/^.+@sha256:[a-f0-9]{64}$/u,'Legacy Tunnel image must be digest pinned');
  assert.ok(fragment.split(/\r?\n/u).some(line=>line.startsWith('ExecStart=')&&line.includes(sourceImage)),'Generated Tunnel unit does not start its declared image');
  assert.match(imageId(image?.Id),/^[a-f0-9]{64}$/u,'Pinned Tunnel image ID is unobservable');
  assert.ok(imageHasDigest(image,sourceImage),'Pinned Tunnel image digest is unavailable locally');
  return sha256(JSON.stringify(canonical({sourcePath,source,fragmentPath,fragment,sourceImage,imageId:imageId(image.Id),secretIdentities:safeSecretIdentities(secretIdentities)})));
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
    assert.equal(url.protocol,'https:');assert.equal(url.pathname,IDENTITY_PROBE_PATHS.frontend);
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
  async probeAccessCredentials(release,{fetchImpl=fetch}={}){
    const clientId=(await readFile(this.config.accessClientIdFile,'utf8')).trim();
    const clientSecret=(await readFile(this.config.accessClientSecretFile,'utf8')).trim();
    assert.ok(clientId&&clientSecret,'Missing Access service credentials');
    return probeScopedIdentityAccess({
      origin:new URL(this.url),credentials:{clientId,clientSecret},fetchImpl,checkBoundary:true,
      validateBackend:value=>{assertVersion(value,release,this.authEnvironment.CODEXIA_BROWSER_AUTH);return value;},
      validateFrontend:value=>{const identity=validateFrontendIdentity(value);assert.equal(identity.profile,release.profile);assert.equal(identity.apiEpoch,release.apiEpoch);return identity;},
    });
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
          const capabilityStatus=await readRuntimeCapabilityStatus(observed,'Legacy writer');
          assertRuntimeObservation(observed,this.runtime,image.Config?.Env,expectedUnit,capabilityStatus);
          assertRuntimeUnitDropIns(run('systemctl',['--user','show','--property=DropInPaths','--value',activeUnit(slot)]));
          assertRuntimeUnit(run('systemctl',['--user','cat',activeUnit(slot)]),this.runtime);
          const processCgroupPath=await assertRuntimeProcessInSystemdUnit(activeUnit(slot),observed,'Legacy writer');
          await assertRuntimeProcessMemoryMax(processCgroupPath,this.runtime,'Legacy writer');
          await assertRuntimeSystemdCpuQuota(activeUnit(slot),this.runtime);
        }
        writers.push({slot,image:configured});
      }
    }
    return {route,writers};
  }
  async assertNoPreflight(){
    for(const slot of ['blue','green'])assert.ok(!exists(preflight(slot)),'Unexpected preflight container prevents exclusive maintenance');
  }
  async routeState(){
    const route=(await readFile(this.config.routeFile,'utf8')).trim();
    assert.ok(['blue','green','blocked'].includes(route),'Invalid proxy route');
    return route;
  }
  async unitActive(unit){
    const loaded=spawnSync('systemctl',['--user','show','--property=LoadState','--value',unit],{encoding:'utf8',timeout:15000});
    if(loaded.status===0&&loaded.stdout.trim()==='not-found')return false;
    if(loaded.status!==0){
      const missing=spawnSync('systemctl',['--user','is-active',unit],{encoding:'utf8',timeout:15000});
      if(missing.status===4&&['unknown','inactive'].includes(missing.stdout.trim()))return false;
      throw Error('Systemd service state is unobservable: '+unit);
    }
    const result=spawnSync('systemctl',['--user','is-active',unit],{encoding:'utf8',timeout:15000});
    if(result.status===0&&result.stdout.trim()==='active')return true;
    if(result.status===3&&result.stdout.trim()==='inactive')return false;
    if(result.status===4&&['unknown','inactive'].includes(result.stdout.trim()))return false;
    throw Error('Systemd service state is unobservable or failed: '+unit);
  }
  async resetAbsentFailedLegacyApi(){
    const status=spawnSync('systemctl',['--user','is-active','codexia-api.service'],{encoding:'utf8',timeout:15000});
    if(assertLegacyApiStoppedState(status,inspect('codexia-api'))){
      run('systemctl',['--user','reset-failed','codexia-api.service']);
    }
  }
  async legacyServiceActive({recoverStopped=false}={}){
    if(recoverStopped)await this.resetAbsentFailedLegacyApi();
    const active=await this.unitActive('codexia-api.service');
    const running=Boolean(inspect('codexia-api')?.State.Running);
    assert.equal(active,running,'Legacy API service and container state disagree');
    return active;
  }
  async tunnelServiceActive(){
    const active=await this.unitActive('codexia-tunnel.service');
    const running=Boolean(inspect('codexia-tunnel')?.State.Running);
    assert.equal(active,running,'Tunnel service and container state disagree');
    return active;
  }
  async tunnelRotationServiceActive(){
    const properties=systemdProperties(run('systemctl',['--user','show','--property=ActiveState,SubState','codexia-tunnel.service']));
    const container=inspect('codexia-tunnel');
    if(properties.ActiveState==='active'){
      assert.ok(container?.State.Running,'Active Tunnel service has no running owned container');
      return true;
    }
    assert.ok(['inactive','failed'].includes(properties.ActiveState),'Tunnel rotation service state is not safely observable');
    assert.equal(container,null,'Inactive Tunnel service retains an unverified container');
    if(properties.ActiveState==='failed'){
      run('systemctl',['--user','reset-failed','codexia-tunnel.service']);
      assert.equal(run('systemctl',['--user','show','--property=ActiveState','--value','codexia-tunnel.service']),'inactive',
        'Failed Tunnel service could not be reset after proving container absence');
    }
    return false;
  }
  async generatedWantTarget(entry){
    const runtime=process.env.XDG_RUNTIME_DIR??'';
    assert.ok(path.isAbsolute(runtime),'Rootless systemd runtime directory is unavailable');
    const generator=path.resolve(runtime,'systemd','generator');
    const link=path.join(generator,'default.target.wants',entry.unit);
    let metadata;
    try{metadata=await lstat(link);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    assert.ok(metadata.isSymbolicLink(),'Quadlet default.target dependency is not a generated symlink: '+entry.unit);
    const target=await readlink(link);
    assert.equal(path.resolve(path.dirname(link),target),path.join(generator,entry.unit),'Quadlet default.target dependency points at an unexpected unit: '+entry.unit);
    return target;
  }
  async defaultTargetWants(entry){
    const properties=systemdProperties(run('systemctl',['--user','show','--property=Wants','default.target']));
    return new Set((properties.Wants??'').trim().split(/\s+/u).filter(Boolean)).has(entry.unit);
  }
  async captureBackupAutostart(){
    const entries=this.backupStartupFencePaths();
    const [apiGenerator,tunnelGenerator,apiWanted,tunnelWanted]=await Promise.all([
      this.generatedWantTarget(entries.api),this.generatedWantTarget(entries.tunnel),this.defaultTargetWants(entries.api),this.defaultTargetWants(entries.tunnel),
    ]);
    return {
      apiWasEnabled:apiWanted,tunnelWasEnabled:tunnelWanted,
      autostartLinks:{
        api:{generatorTarget:apiGenerator,defaultTargetWants:apiWanted},
        tunnel:{generatorTarget:tunnelGenerator,defaultTargetWants:tunnelWanted},
      },
    };
  }
  async assertBackupAutostartGated(intent){
    await this.assertBackupStartupFence();
    const current=await this.captureBackupAutostart();
    assert.deepEqual(current.autostartLinks,intent.autostartLinks,'Quadlet default.target autostart links drifted during backup recovery');
    assert.equal(current.apiWasEnabled,intent.apiWasEnabled,'API default.target autostart state changed during backup recovery');
    assert.equal(current.tunnelWasEnabled,intent.tunnelWasEnabled,'Tunnel default.target autostart state changed during backup recovery');
  }
  async restoreBackupAutostart(intent){
    await this.assertBackupAutostartGated(intent);
  }
  async stopLegacyWriter(){
    run('systemctl',['--user','stop','codexia-api.service'],{timeout:120000});
    assert.equal(await this.legacyServiceActive({recoverStopped:true}),false,'Legacy API writer did not stop');
  }
  backupStartupFencePaths(){
    const quadletDirectory=path.resolve(this.config.quadletDirectory);
    const serviceHome=path.resolve(quadletDirectory,'../../..');
    assert.equal(quadletDirectory,path.join(serviceHome,'.config','containers','systemd'),'Legacy Quadlet directory is outside the service home');
    const directory=path.join(serviceHome,'.config','systemd','user');
    const intent=path.join(path.dirname(this.config.stateFile),'backup-recovery.json');
    const runtime=process.env.XDG_RUNTIME_DIR??'';
    assert.ok(path.isAbsolute(runtime),'Rootless systemd runtime directory is unavailable');
    const condition=(permit)=>`[Unit]\nConditionPathExists=|!${intent}\nConditionPathExists=|${permit}\n`;
    return {
      api:{unit:'codexia-api.service',permit:path.join(runtime,'codexia-backup-recovery-api.permit'),directory:path.join(directory,'codexia-api.service.d'),file:path.join(directory,'codexia-api.service.d','90-codexia-backup-recovery.conf'),content:condition(path.join(runtime,'codexia-backup-recovery-api.permit'))},
      tunnel:{unit:'codexia-tunnel.service',permit:path.join(runtime,'codexia-backup-recovery-tunnel.permit'),directory:path.join(directory,'codexia-tunnel.service.d'),file:path.join(directory,'codexia-tunnel.service.d','90-codexia-backup-recovery.conf'),content:condition(path.join(runtime,'codexia-backup-recovery-tunnel.permit'))},
    };
  }
  async ensureBackupStartupFenceFile(entry){
    await ensureDirectoryTreeDurable(entry.directory);
    const directoryMetadata=await lstat(entry.directory);
    assert.ok(directoryMetadata.isDirectory()&&!directoryMetadata.isSymbolicLink(),'Backup recovery fence directory must be a real directory');
    if(typeof process.getuid==='function')assert.equal(directoryMetadata.uid,process.getuid(),'Backup recovery fence directory owner differs from service user');
    assert.equal(directoryMetadata.mode&0o022,0,'Backup recovery fence directory is group/world writable');
    try{
      const handle=await open(entry.file,'wx',0o600);
      try{await handle.writeFile(entry.content,'utf8');await handle.sync();}finally{await handle.close();}
      await syncDirectory(entry.directory);
    }catch(error){
      if(error.code!=='EEXIST')throw error;
      assert.equal(await regularPrivateText(entry.file,{privateOnly:true}),entry.content,'Backup recovery fence differs from the expected unit condition');
    }
  }
  async removeBackupStartupFenceFile(entry){
    let content;
    try{content=await regularPrivateText(entry.file,{privateOnly:true});}
    catch(error){if(error.code==='ENOENT')return false;throw error;}
    assert.equal(content,entry.content,'Refusing to remove an unrecognized systemd drop-in');
    await unlink(entry.file);
    await syncDirectory(entry.directory);
    try{await rmdir(entry.directory);await syncDirectory(path.dirname(entry.directory));}catch(error){if(!['ENOTEMPTY','EEXIST'].includes(error.code))throw error;}
    return true;
  }
  async assertBackupStartupFence(){
    const entries=this.backupStartupFencePaths();
    for(const entry of Object.values(entries)){
      assert.equal(await regularPrivateText(entry.file,{privateOnly:true}),entry.content,'Legacy service startup fence differs from the reviewed condition: '+entry.unit);
      const properties=systemdProperties(run('systemctl',['--user','show','--property=LoadState,DropInPaths',entry.unit]));
      assert.equal(properties.LoadState,'loaded','Legacy service unit is not loaded with its startup fence: '+entry.unit);
      const paths=(properties.DropInPaths??'').trim().split(/\s+/u).filter(Boolean);
      assert.deepEqual(paths,[entry.file],'Legacy service startup fence is overridden by an unreviewed drop-in or was not loaded: '+entry.unit);
    }
  }
  async installBackupStartupFence(){
    const entries=this.backupStartupFencePaths();
    await this.ensureBackupStartupFenceFile(entries.api);
    await this.ensureBackupStartupFenceFile(entries.tunnel);
    run('systemctl',['--user','daemon-reload']);
    await this.assertBackupStartupFence();
  }
  tunnelRotationStartupFence(){
    const entries=this.backupStartupFencePaths();
    const runtime=process.env.XDG_RUNTIME_DIR??'';
    const stateDir=path.dirname(this.config.stateFile);
    const marker=path.join(stateDir,'maintenance','in-progress.json');
    const permit=path.join(runtime,'codexia-tunnel-token-rotation.permit');
    assert.ok(path.isAbsolute(runtime),'Rootless systemd runtime directory is unavailable');
    return {unit:'codexia-tunnel.service',permit,marker,directory:entries.tunnel.directory,
      file:path.join(entries.tunnel.directory,'91-codexia-tunnel-token-rotation.conf'),
      content:`[Unit]\nConditionPathExists=|!${marker}\nConditionPathExists=|${permit}\n`};
  }
  async assertTunnelRotationStartupFence(){
    const entry=this.tunnelRotationStartupFence();
    assert.equal(await regularPrivateText(entry.file,{privateOnly:true}),entry.content,'Tunnel rotation startup fence differs from the reviewed condition');
    const properties=systemdProperties(run('systemctl',['--user','show','--property=LoadState,DropInPaths',entry.unit]));
    assert.equal(properties.LoadState,'loaded','Tunnel service is not loaded with its rotation startup fence');
    assert.deepEqual((properties.DropInPaths??'').trim().split(/\s+/u).filter(Boolean),[entry.file],
      'Tunnel rotation fence is overridden by another systemd drop-in');
  }
  async installTunnelRotationStartupFence(){
    const entry=this.tunnelRotationStartupFence();
    await this.ensureBackupStartupFenceFile(entry);
    run('systemctl',['--user','daemon-reload']);
    await this.assertTunnelRotationStartupFence();
  }
  async removeTunnelRotationStartupFence(){
    const entry=this.tunnelRotationStartupFence();
    let marker=null,metadata;
    try{metadata=await lstat(entry.marker);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(metadata){
      assert.ok(metadata.isFile()&&!metadata.isSymbolicLink(),'Tunnel rotation marker must be a regular file before fence removal');
      assert.equal(metadata.mode&0o777,0o600,'Tunnel rotation marker permissions drift before fence removal');
      if(typeof process.getuid==='function')assert.equal(metadata.uid,process.getuid(),'Tunnel rotation marker owner drift before fence removal');
      marker=JSON.parse(await readFile(entry.marker,'utf8'));
    }
    if(marker)assert.ok(marker.format==='codexia-maintenance-tunnel-token/v1'&&['completed','rolled-back'].includes(marker.phase),
      'Cannot remove the Tunnel startup fence while rotation recovery is pending');
    const removed=await this.removeBackupStartupFenceFile(entry);
    if(removed)run('systemctl',['--user','daemon-reload']);
  }
  async withTunnelRotationPermit(operation){
    const entry=this.tunnelRotationStartupFence();
    await this.assertTunnelRotationStartupFence();
    const markerInfo=await lstat(entry.marker);
    assert.ok(markerInfo.isFile()&&!markerInfo.isSymbolicLink(),'Tunnel permit marker must be a regular file');
    assert.equal(markerInfo.mode&0o777,0o600,'Tunnel permit marker permissions drift');
    if(typeof process.getuid==='function')assert.equal(markerInfo.uid,process.getuid(),'Tunnel permit marker owner drift');
    const marker=JSON.parse(await readFile(entry.marker,'utf8'));
    assert.equal(marker.format,'codexia-maintenance-tunnel-token/v1','Tunnel permit requires its durable rotation marker');
    await ensureDirectoryTreeDurable(path.dirname(entry.permit));
    const temporary=path.join(path.dirname(entry.permit),'.'+path.basename(entry.permit)+'.'+process.pid+'.'+randomBytes(8).toString('hex')+'.tmp');
    const handle=await open(temporary,'wx',0o600);
    const target=`/proc/${process.pid}/fd/${handle.fd}`;
    let installed=false;
    try{
      await handle.writeFile('codexia-tunnel-token-rotation-permit/v1\n','utf8');
      await handle.sync();
      await unlink(temporary);
      await symlink(target,entry.permit);
      installed=true;
      await syncDirectory(path.dirname(entry.permit));
      await this.assertTunnelRotationStartupFence();
      return await operation();
    }finally{
      if(installed){
        try{
          assert.equal(await readlink(entry.permit),target,'Tunnel rotation permit changed while a service was starting');
          await unlink(entry.permit);
          await syncDirectory(path.dirname(entry.permit));
        }finally{await handle.close();}
      }else{
        await unlink(temporary).catch(()=>undefined);
        await handle.close();
      }
    }
  }
  async startTunnelForRotation(snapshot){
    await this.assertTunnelTokenRotationSources(snapshot);
    await this.assertTunnelRotationStartupFence();
    await this.withTunnelRotationPermit(async()=>run('systemctl',['--user','start','codexia-tunnel.service'],{timeout:120000}));
    assert.equal(await this.tunnelServiceActive(),true,'Tunnel token rotation did not start the reviewed service');
  }
  async removeBackupStartupFence(){
    const entries=this.backupStartupFencePaths();
    const api=await this.removeBackupStartupFenceFile(entries.api);
    const tunnel=await this.removeBackupStartupFenceFile(entries.tunnel);
    if(api||tunnel)run('systemctl',['--user','daemon-reload']);
  }
  async removeBackupStartupPermits(){
    for(const entry of Object.values(this.backupStartupFencePaths())){
      let metadata;
      try{metadata=await lstat(entry.permit);}
      catch(error){if(error.code==='ENOENT')continue;throw error;}
      assert.ok(metadata.isSymbolicLink(),'Legacy recovery permit is not a process-bound descriptor link');
      const target=await readlink(entry.permit);
      assert.match(target,/^\/proc\/\d+\/fd\/\d+$/u,'Legacy recovery permit target is malformed');
      try{
        await stat(target);
        throw Error('Legacy recovery permit is still held by a live process');
      }catch(error){if(error.code!=='ENOENT')throw error;}
      await unlink(entry.permit);
      await syncDirectory(path.dirname(entry.permit));
    }
  }
  async withBackupStartupPermit(key,operation){
    const entry=this.backupStartupFencePaths()[key];
    assert.ok(entry,'Unsupported legacy recovery permit');
    await this.assertBackupStartupFence();
    await ensureDirectoryTreeDurable(path.dirname(entry.permit));
    const temporary=path.join(path.dirname(entry.permit),'.'+path.basename(entry.permit)+'.'+process.pid+'.'+randomBytes(8).toString('hex')+'.tmp');
    const handle=await open(temporary,'wx',0o600);
    const target=`/proc/${process.pid}/fd/${handle.fd}`;
    let installed=false;
    try{
      await handle.writeFile('codexia-backup-recovery-permit/v1\n','utf8');
      await handle.sync();
      await unlink(temporary);
      await symlink(target,entry.permit);
      installed=true;
      await syncDirectory(path.dirname(entry.permit));
      return await operation();
    }finally{
      if(installed){
        try{
          assert.equal(await readlink(entry.permit),target,'Legacy recovery permit changed while a service was starting');
          await unlink(entry.permit);
          await syncDirectory(path.dirname(entry.permit));
        }finally{await handle.close();}
      }else{
        await unlink(temporary).catch(()=>undefined);
        await handle.close();
      }
    }
  }
  async readBackupQuadletUnit(unit,sourceName){
    const entries=this.backupStartupFencePaths();
    const entry=Object.values(entries).find(candidate=>candidate.unit===unit);
    assert.ok(entry,'Unsupported legacy backup unit');
    const sourcePath=path.join(this.config.quadletDirectory,sourceName);
    const properties=systemdProperties(run('systemctl',['--user','show','--property=LoadState,FragmentPath,SourcePath,DropInPaths',unit]));
    assert.equal(properties.LoadState,'loaded','Legacy systemd unit is not loaded: '+unit);
    assert.equal(path.resolve(properties.SourcePath??''),sourcePath,'Legacy systemd unit does not reference the expected Quadlet source: '+unit);
    const dropIns=(properties.DropInPaths??'').trim().split(/\s+/u).filter(Boolean);
    for(const dropIn of dropIns){
      const rotationFence=unit==='codexia-tunnel.service'?this.tunnelRotationStartupFence():null;
      if(rotationFence&&dropIn===rotationFence.file){
        assert.equal(await regularPrivateText(dropIn,{privateOnly:true}),rotationFence.content,'Tunnel rotation startup fence differs from the reviewed condition');
      }else{
        assert.equal(dropIn,entry.file,'Legacy service has an unreviewed systemd drop-in: '+unit);
        assert.equal(await regularPrivateText(dropIn,{privateOnly:true}),entry.content,'Legacy service backup fence differs from the reviewed condition: '+unit);
      }
    }
    assert.ok(path.isAbsolute(process.env.XDG_RUNTIME_DIR??''),'Rootless systemd runtime directory is unavailable');
    const fragmentRoot=path.resolve(process.env.XDG_RUNTIME_DIR,'systemd','generator');
    const fragmentPath=path.resolve(properties.FragmentPath??'');
    assert.equal(path.dirname(fragmentPath),fragmentRoot,'Legacy service is not a generated Quadlet unit: '+unit);
    assert.equal(path.basename(fragmentPath),unit);
    const [source,fragment]=await Promise.all([regularPrivateText(sourcePath),regularPrivateText(fragmentPath)]);
    return {source,fragment,sourcePath,fragmentPath};
  }
  async quadletSecretIdentities(source){
    const names=source.split(/\r?\n/u).filter(line=>line.startsWith('Secret=')).map(line=>line.slice('Secret='.length).split(',',1)[0]);
    assert.equal(new Set(names).size,names.length,'Quadlet declares a duplicate Podman secret');
    return Promise.all(names.sort().map(async name=>{
      assert.match(name,/^[A-Za-z0-9_.-]+$/u,'Quadlet secret name is malformed');
      const secret=JSON.parse(run('podman',['secret','inspect',name]))[0];
      const id=secret?.ID??secret?.Id;
      assert.ok(typeof id==='string'&&id,'Podman secret identity is unobservable: '+name);
      return {name,id};
    }));
  }
  async legacyBackupUnitSnapshot(release){
    const {source,fragment,sourcePath,fragmentPath}=await this.readBackupQuadletUnit('codexia-api.service','codexia-api.container');
    const sourceImage=quadletField(source,'Image');
    const selectedImage=JSON.parse(run('podman',['image','inspect',release.image]))[0];
    const quadletImage=JSON.parse(run('podman',['image','inspect',sourceImage]))[0];
    const secretIdentities=await this.quadletSecretIdentities(source);
    const unitFingerprint=assertLegacyBackupUnitIdentity({source,fragment,sourcePath,fragmentPath,quadletImage,selectedImage,secretIdentities},release);
    return {unitFingerprint,source,secretIdentities};
  }
  async legacyBackupTunnelSnapshot(){
    const {source,fragment,sourcePath,fragmentPath}=await this.readBackupQuadletUnit('codexia-tunnel.service','codexia-tunnel.container');
    const sourceImage=quadletField(source,'Image');
    const image=JSON.parse(run('podman',['image','inspect',sourceImage]))[0];
    const secretIdentities=await this.quadletSecretIdentities(source);
    const unitFingerprint=assertLegacyBackupTunnelUnitIdentity({source,fragment,sourcePath,fragmentPath,image,secretIdentities});
    return {unitFingerprint,source,secretIdentities,imageId:imageId(image.Id)};
  }
  async legacyBackupUnitFingerprint(release){return (await this.legacyBackupUnitSnapshot(release)).unitFingerprint;}
  async legacyBackupTunnelUnitFingerprint(){return (await this.legacyBackupTunnelSnapshot()).unitFingerprint;}
  async legacyRuntimeFingerprint(containerName,source,secretIdentities){
    const container=inspect(containerName);
    if(!container)return null;
    return containerRuntimeFingerprint(container,secretIdentities??await this.quadletSecretIdentities(source));
  }
  async startLegacyWriter(){
    await this.withBackupStartupPermit('api',async()=>{
      run('systemctl',['--user','start','codexia-api.service'],{timeout:120000});
      assert.equal(await this.legacyServiceActive(),true,'Legacy API writer did not resume');
    });
  }
  async stopTunnel(){
    run('systemctl',['--user','stop','codexia-tunnel.service'],{timeout:120000});
    assert.equal(await this.tunnelServiceActive(),false,'Tunnel did not stop');
  }
  async startTunnel(){
    await this.withBackupStartupPermit('tunnel',async()=>{
      run('systemctl',['--user','start','codexia-tunnel.service'],{timeout:120000});
      assert.equal(await this.tunnelServiceActive(),true,'Tunnel did not resume');
    });
  }
  async pollingTimerActive(){
    const loadState=run('systemctl',['--user','show','--property=LoadState','--value','codexia-updater.timer']);
    if(loadState==='not-found')return false;
    const result=spawnSync('systemctl',['--user','is-active','codexia-updater.timer'],{encoding:'utf8',timeout:15000});
    if(result.status===0&&result.stdout.trim()==='active')return true;
    if(result.status===3&&result.stdout.trim()==='inactive')return false;
    throw Error('Updater timer state is unobservable or failed');
  }
  async stopPollingTimer(){
    run('systemctl',['--user','stop','codexia-updater.timer']);
    assert.equal(await this.pollingTimerActive(),false,'Updater timer did not stop');
  }
  async startPollingTimer(){
    run('systemctl',['--user','start','codexia-updater.timer']);
    assert.equal(await this.pollingTimerActive(),true,'Updater timer did not resume');
  }
  async backup(destination,recipient){
    const script=fileURLToPath(new URL('./standalone-backup.sh',import.meta.url));
    const lockFd=Number(process.env.CODEXIA_UPDATER_LOCK_FD);
    assert.ok(Number.isSafeInteger(lockFd)&&lockFd>=3,'Updater lock descriptor is unavailable to the controller');
    const stdio=['ignore','pipe','pipe'];
    while(stdio.length<lockFd)stdio.push('ignore');
    stdio[lockFd]=lockFd;
    const result=spawnSync('bash',[script,'backup-locked',destination,recipient],{
      encoding:'utf8',timeout:6*60*60*1000,maxBuffer:1024*1024,
      env:{...process.env,CODEXIA_UPDATER_LOCK_HELD:'1',CODEXIA_UPDATER_LOCK_FD:String(lockFd)},
      stdio,
    });
    if(result.error||result.status!==0){
      const status=result.status??'unknown';
      const message=(result.stderr??'').trim().slice(0,500);
      throw Error('Encrypted backup command failed (status '+status+')'+(message?': '+message:''));
    }
    return (result.stdout??'').trim();
  }
  async backupArtifactIdentity(directory){
    const script=fileURLToPath(new URL('./standalone-backup.sh',import.meta.url));
    const value=run('bash',[script,'validate-artifact',directory],{timeout:6*60*60*1000});
    assert.match(value,/^[a-f0-9]{64}$/u,'Backup artifact checksum manifest identity is unobservable');
    return value;
  }
  async validateBackupDestination(destination){
    const script=fileURLToPath(new URL('./standalone-backup.sh',import.meta.url));
    const result=spawnSync('bash',[script,'validate-destination',destination],{
      encoding:'utf8',timeout:15000,maxBuffer:65536,env:process.env,
    });
    if(result.error||result.status!==0){
      const status=result.status??'unknown';
      const message=(result.stderr??'').trim().slice(0,500);
      throw Error('Backup destination preflight failed (status '+status+')'+(message?': '+message:''));
    }
    return (result.stdout??'').trim();
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
  async assertNoWriterContainers(allowedRunningSlot=null){
    assert.ok(allowedRunningSlot===null||SLOT.test(allowedRunningSlot),'Invalid allowed writer slot');
    for(const slot of ['blue','green'])if(slot!==allowedRunningSlot)assert.ok(!exists(name(slot)),'Unexpected stopped or running slot container prevents writer recovery');
  }
  async assertCommittedWriterUnitSource(slot){
    const unit=activeUnit(slot);
    const source=path.join(this.config.quadletDirectory,name(slot)+'.container');
    const properties=systemdProperties(run('systemctl',['--user','show','--property=LoadState,FragmentPath,SourcePath,DropInPaths',unit]));
    assert.equal(properties.LoadState,'loaded','Committed writer unit is not loaded');
    assert.equal(properties.SourcePath,source,'Committed writer unit does not reference its reviewed Quadlet');
    assert.ok(path.isAbsolute(process.env.XDG_RUNTIME_DIR??''),'Rootless systemd runtime directory is unavailable');
    assert.equal(properties.FragmentPath,path.join(process.env.XDG_RUNTIME_DIR,'systemd','generator',unit),'Committed writer unit is not a generated Quadlet');
    assertRuntimeUnitDropIns(properties.DropInPaths??'');
  }
  async assertNoSlotSources(){
    for(const slot of ['blue','green']){
      const container=name(slot);
      assert.ok(!exists(container),'Unexpected slot container prevents legacy cutover');
      const filename=path.join(this.config.quadletDirectory,container+'.container');
      const present=await lstat(filename).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
      assert.equal(present,false,'Unexpected slot source prevents legacy cutover');
      assert.equal(run('systemctl',['--user','show','--property=LoadState','--value',activeUnit(slot)]),'not-found','Unexpected slot service prevents legacy cutover');
    }
  }
  async captureCutoverSources(release){
    const api=await this.legacyBackupUnitSnapshot(release);
    const tunnel=await this.legacyBackupTunnelSnapshot();
    switchLegacyTunnelSource(tunnel.source);
    return {apiSource:api.source,tunnelSource:tunnel.source,apiFingerprint:api.unitFingerprint,tunnelFingerprint:tunnel.unitFingerprint};
  }
  async readCutoverSources(){
    const apiPath=path.join(this.config.quadletDirectory,'codexia-api.container');
    const tunnelPath=path.join(this.config.quadletDirectory,'codexia-tunnel.container');
    const api=await regularPrivateText(apiPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    const tunnel=await regularPrivateText(tunnelPath);
    return {apiPath,tunnelPath,api,tunnel};
  }
  async applyCutoverSources(intent){
    const {apiPath,tunnelPath,api,tunnel}=await this.readCutoverSources();
    assert.equal(api,intent.apiSource,'Legacy API source changed before cutover');
    assert.equal(tunnel,intent.tunnelSource,'Legacy Tunnel source changed before cutover');
    assert.equal(await this.legacyServiceActive({recoverStopped:true}),false);
    assert.equal(await this.tunnelServiceActive(),false);
    assert.ok(!exists('codexia-api'),'Legacy container remains after stopping its service');
    await this.assertNoSlotSources();
    await unlink(apiPath);
    await syncDirectory(path.dirname(apiPath));
    await atomicWrite(tunnelPath,switchLegacyTunnelSource(tunnel));
    // The legacy API is gone; its drop-in must not create a phantom unit.
    // Keep the Tunnel fence until private serving is proven.
    await this.removeBackupStartupFenceFile(this.backupStartupFencePaths().api);
    run('systemctl',['--user','daemon-reload']);
    await this.assertCutoverSources(intent);
  }
  async assertCutoverOriginalSources(intent){
    const {api,tunnel}=await this.readCutoverSources();
    assert.equal(api,intent.apiSource,'Original API source drift');
    assert.equal(tunnel,intent.tunnelSource,'Original Tunnel source drift');
  }
  async assertCutoverSources(intent){
    const {api,tunnel}=await this.readCutoverSources();
    assert.equal(api,null,'Legacy API source reappeared');
    assert.equal(tunnel,switchLegacyTunnelSource(intent.tunnelSource),'Cutover Tunnel source drift');
    await this.assertInitialLegacyAbsent();
  }
  async restoreCutoverSources(intent){
    const {apiPath,tunnelPath,api,tunnel}=await this.readCutoverSources();
    assert.ok(api===null||api===intent.apiSource,'Unknown API source prevents recovery');
    assert.ok(tunnel===intent.tunnelSource||tunnel===switchLegacyTunnelSource(intent.tunnelSource),'Unknown Tunnel source prevents recovery');
    await this.assertNoSlotSources();
    if(tunnel!==intent.tunnelSource){
      if(await this.tunnelServiceActive())await this.stopTunnel();
      await atomicWrite(tunnelPath,intent.tunnelSource);
    }
    if(api===null)await atomicWrite(apiPath,intent.apiSource);
    run('systemctl',['--user','daemon-reload']);
  }
  async startCutoverTunnel(intent){
    await this.assertCutoverSources(intent);
    const unit='codexia-tunnel.service';
    assertRuntimeUnitDropIns(run('systemctl',['--user','show','--property=DropInPaths','--value',unit]));
    assert.equal(run('systemctl',['--user','show','--property=SourcePath','--value',unit]),path.join(this.config.quadletDirectory,'codexia-tunnel.container'));
    run('systemctl',['--user','start',unit],{timeout:120000});
    assert.equal(await this.tunnelServiceActive(),true);
    const identity=await this.assertLegacyBackupTunnel();
    assert.equal(identity.runtimeFingerprint,intent.backupIntent.identity.tunnel.runtimeFingerprint,'Tunnel runtime drift after private handoff');
  }
  async assertInitialLegacyAbsent(){
    assert.ok(!exists('codexia-api'),'Initial activation refuses an existing legacy container');
    const filename=path.join(this.config.quadletDirectory,'codexia-api.container');
    const present=await lstat(filename).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
    assert.equal(present,false,'Initial activation refuses an existing legacy Quadlet');
    assert.equal(run('systemctl',['--user','show','--property=LoadState','--value','codexia-api.service']),'not-found','Initial activation refuses a loaded legacy unit');
  }
  async assertFreshTunnelInactive(){
    // A legacy-dependent Tunnel Quadlet may have failed dependency activation
    // during boot. This is safe only with the legacy source absent, no
    // container, an exact legacy dependency pair and no unit overrides.
    const {tunnel,tunnelPath}=await this.readCutoverSources();
    switchLegacyTunnelSource(tunnel);
    assert.ok(!exists('codexia-tunnel'),'Fresh activation refuses an existing Tunnel container');
    const unit='codexia-tunnel.service';
    const properties=systemdProperties(run('systemctl',['--user','show','--property=LoadState,ActiveState,SourcePath,DropInPaths',unit]));
    if(properties.LoadState==='not-found')return;
    assert.equal(properties.LoadState,'loaded');
    assert.equal(properties.SourcePath,tunnelPath,'Fresh Tunnel source drift');
    assertRuntimeUnitDropIns(properties.DropInPaths??'');
    assert.ok(['inactive','failed'].includes(properties.ActiveState),'Fresh activation must precede public Tunnel handoff');
  }
  async assertFreshSchemaHost(){
    await this.assertInitialLegacyAbsent();
    assert.equal(this.config.enabled,false,'Fresh schema initialization requires disabled polling');
    assert.equal(await this.routeState(),'blocked','Fresh schema requires a blocked private route');
    assert.equal(await this.pollingTimerActive(),false,'Fresh schema requires polling stopped');
    await this.assertNoPreflight();
    for(const container of [name('blue'),name('green'),'codexia-schema-initializer']){
      assert.ok(!exists(container),'Fresh schema requires no existing writer or initializer container: '+container);
    }
    for(const container of [name('blue'),name('green')]){
      const filename=path.join(this.config.quadletDirectory,container+'.container');
      const present=await lstat(filename).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
      assert.equal(present,false,'Fresh schema refuses existing writer Quadlet: '+container);
      assert.equal(run('systemctl',['--user','show','--property=LoadState','--value',container+'.service']),'not-found','Fresh schema refuses a loaded writer unit: '+container);
    }
    await this.assertFreshTunnelInactive();
    assert.equal(await this.unitActive('codexia-db.service'),true,'Fresh schema requires the canonical database service');
  }
  async rotationResources(databaseId){
    const volumes={};
    for(const name of ['codexia-postgres','codexia-data','codexia-history']){
      const [volume]=JSON.parse(run('podman',['volume','inspect',name]));
      assert.ok(volume.Name===name&&volume.Driver==='local'&&path.isAbsolute(volume.Mountpoint)&&volume.CreatedAt,
        'Canonical persistent volume is unobservable');
      assert.equal(await realpath(volume.Mountpoint),volume.Mountpoint,'Persistent volume path is not canonical');
      const identity=run('podman',['unshare','stat','-c','%d:%i',volume.Mountpoint]);
      assert.match(identity,/^\d+:\d+$/u);
      volumes[name]={path:volume.Mountpoint,created:volume.CreatedAt,identity};
    }
    const networks={};
    for(const name of ['codexia','codexia-data']){
      const [network]=JSON.parse(run('podman',['network','inspect',name]));
      assert.ok(network.name===name&&network.driver==='bridge'&&network.internal===(name==='codexia-data')&&network.id,
        'Canonical Podman network is unobservable');
      networks[name]=network.id;
    }
    // PostgreSQL places its native-endian uint64 system identifier first in
    // global/pg_control. Refuse to run the image entrypoint on an empty mount.
    const [systemId,oid]=databaseId.split(':');
    const pgdata=path.join(volumes['codexia-postgres'].path,'pgdata');
    for(const file of ['PG_VERSION','global/pg_control','base/'+oid]){
      const absolute=path.join(pgdata,file);
      assert.equal(run('podman',['unshare','realpath','-e',absolute]),absolute,'Database files must remain on the original volume');
    }
    assert.equal(run('podman',['unshare','cat',path.join(pgdata,'PG_VERSION')]),'17','Database volume version changed');
    assert.equal(run('podman',['unshare','od','-An','-tu8','-N8',path.join(pgdata,'global/pg_control')]),systemId,'Physical database identity changed');
    return {volumes,networks};
  }
  async passwordRotationUnit(reviewed){
    const sourcePath=path.join(this.config.quadletDirectory,'codexia-db.container');
    assert.equal(await realpath(sourcePath),sourcePath,'Database source cannot traverse a symlink');
    const source=await regularPrivateText(sourcePath,{privateOnly:true});
    const properties=systemdProperties(run('systemctl',['--user','show','--all','--property=LoadState,NeedDaemonReload,SourcePath,FragmentPath,DropInPaths,RequiredBy,BoundBy,ConsistsOf,PropagatesStopTo',databaseUnit]));
    assertPasswordRotationDbUnit({properties,sourcePath,runtimeDir:process.env.XDG_RUNTIME_DIR,source,reviewed});
    const fragment=await regularPrivateText(properties.FragmentPath);
    assert.ok(fragment.split('\n').some(line=>line.startsWith('ExecStart=')&&line.includes(quadletField(source,'Image'))),'Database fragment image drift');
    return sha256(fragment);
  }
  async capturePasswordRotation(reviewed,replacement,operationId){
    const fragmentDigest=await this.passwordRotationUnit(reviewed);
    const original=readRotationSecret(appSecret);
    const admin=readRotationSecret('codexia-postgres-admin-password');
    const preflight=readRotationSecret('codexia-postgres-preflight-password');
    assert.ok(original&&admin&&preflight,'Database secret identity cannot be proven');
    assert.ok([original,admin,preflight].every(secret=>secret.password.trimEnd()!==replacement.trimEnd()),
      'Replacement must be independent of the existing database credentials');
    const databaseId=await this.passwordRotationDatabaseId();
    const resources=await this.rotationResources(databaseId);
    const snapshot={databaseQuadlet:reviewed,fragmentDigest,operationId,databaseId,resources,adminSecretId:admin.id,
      originalSecretId:original.id,previousDigest:sha256(original.password),replacementDigest:sha256(replacement)};
    snapshot.runtimeDigest=await this.rotationDatabaseRuntime(snapshot);
    assert.ok(snapshot.runtimeDigest,'Rotation requires the canonical running database');
    await this.verifyPostgresAppPassword(original.password);
    return {snapshot,previousPassword:original.password};
  }
  async assertPasswordRotationSources(snapshot){
    assert.equal(await this.passwordRotationUnit(snapshot.databaseQuadlet),snapshot.fragmentDigest,'Database generated unit changed');
    assert.deepEqual(await this.rotationResources(snapshot.databaseId),snapshot.resources,'Database resources changed');
    assert.equal(readRotationSecret('codexia-postgres-admin-password')?.id,snapshot.adminSecretId,'Database administrator credential identity changed');
    assertKnownRotationSecret(readRotationSecret(appSecret),snapshot);
  }
  async rotationDatabaseRuntime(snapshot){
    const db=inspect('codexia-db');
    const properties=systemdProperties(run('systemctl',['--user','show','--property=ActiveState,SubState',databaseUnit]));
    if(!db){
      assert.ok(['inactive','failed'].includes(properties.ActiveState)||
        (properties.ActiveState==='activating'&&properties.SubState==='auto-restart'),'Absent DB container disagrees with systemd');
      return null;
    }
    assert.equal(properties.ActiveState,'active','Canonical database service is not active');
    await assertRuntimeProcessInSystemdUnit(databaseUnit,db,'PostgreSQL');
    assertPasswordRotationDatabaseRuntime({container:db,image:quadletField(snapshot.databaseQuadlet,'Image'),
      volumePath:snapshot.resources.volumes['codexia-postgres'].path,networkId:snapshot.resources.networks['codexia-data']});
    const secrets=await this.quadletSecretIdentities(snapshot.databaseQuadlet);
    const projection=containerRuntimeFingerprintProjection(db,secrets);
    projection.Networks=normalizePostgresRotationNetworks(projection.Networks,db.Id,db.Config.Hostname);
    const mount=projection.SecretMounts.find(secret=>secret.name===appSecret);
    assert.ok(mount?.type==='mount'&&mount.target==='/run/secrets/app-password','Unexpected PostgreSQL app secret mount');
    mount.id='rotating';
    const fingerprint=postgresRotationRuntimeFingerprint(projection);
    if(snapshot.runtimeComponents===undefined)snapshot.runtimeComponents=fingerprint.components;
    else assertPostgresRotationRuntimeFingerprint(snapshot,projection);
    return fingerprint.digest;
  }
  async passwordRotationDatabase(snapshot){
    const observed=await this.rotationDatabaseRuntime(snapshot);
    if(observed===null)return false;
    assert.equal(observed,snapshot.runtimeDigest,'Database runtime ownership changed');
    return true;
  }
  async stopPasswordRotationDatabase(snapshot){
    await this.assertPasswordRotationSources(snapshot);
    await this.passwordRotationDatabase(snapshot);
    run('systemctl',['--user','stop',databaseUnit]);
    assert.ok(!exists('codexia-db'),'Database was not cleanly stopped');
  }
  async startPasswordRotationDatabase(snapshot){
    await this.assertPasswordRotationSources(snapshot);
    assert.ok(!exists('codexia-db'),'Unknown DB container prevents startup');
    run('systemctl',['--user','start',databaseUnit]);
    assert.ok(await this.passwordRotationDatabase(snapshot),'Database startup unverified');
    const deadline=Date.now()+90000;
    while(true){
      try{await this.passwordRotationDatabaseId();break;}catch(error){if(Date.now()>=deadline)throw error;await delay(500);}
    }
  }
  async passwordRotationDatabaseId(){
    const id=passwordRotationPsql('codexia_admin','SELECT system_identifier::text || chr(58) || oid::text FROM pg_control_system(), pg_database WHERE datname=current_database();\n').trim();
    assert.match(id,/^[1-9]\d{0,19}:[1-9]\d{0,9}$/u,'Canonical database identity is unobservable');
    return id;
  }
  async verifyPostgresAppPassword(password){
    assert.ok(readRotationSecret(appSecret)?.password===password,'Canonical secret bytes changed');
    assert.equal(passwordRotationPsql('codexia','SELECT current_user;\n').trim(),'codexia','Database app authentication failed');
  }
  async tunnelTokenRuntimeDigest(source,tunnel){
    const projection=containerRuntimeFingerprintProjection(tunnel,await this.quadletSecretIdentities(source));
    const mount=projection.SecretMounts.find(secret=>secret.name===tunnelTokenSecret);
    assert.ok(mount?.type==='mount'&&mount.target==='/run/secrets/token','Tunnel token mount differs from the reviewed Quadlet');
    mount.id='rotating';
    const containerId=String(tunnel.Id??tunnel.ID??'').replace(/^sha256:/u,'');
    const generatedHostname=tunnel.Config?.Hostname;
    assert.match(containerId,/^[a-f0-9]{64}$/u,'Tunnel runtime container identity is invalid');
    assert.match(generatedHostname??'',/^[a-f0-9]{12}$/u,'Tunnel runtime hostname is invalid');
    projection.Networks=projection.Networks.map(network=>({...network,
      Aliases:[...(network.Aliases??[])].filter(alias=>alias!==containerId&&alias!==generatedHostname).sort()}));
    return sha256(JSON.stringify(canonical(projection)));
  }
  async captureTunnelTokenRotation(replacement,operationId,state){
    const candidate=validateStandaloneTunnelToken(replacement);
    const current=readTunnelTokenSecret();
    assert.ok(current,'Canonical Tunnel token secret is missing');
    assert.ok(current.token.replace(/\n$/u,'')!==candidate.replace(/\n$/u,''),'Replacement Tunnel token must differ from the current token');
    assert.equal(await this.tunnelServiceActive(),true,'Tunnel token rotation requires the exact active Tunnel service');
    const unit=await this.legacyBackupTunnelSnapshot();
    assert.equal(quadletField(unit.source,'ContainerName'),'codexia-tunnel');
    assert.equal(quadletField(unit.source,'Secret'),`${tunnelTokenSecret},type=mount,target=/run/secrets/token`,
      'Tunnel Quadlet secret mount differs from the reviewed token mount');
    assert.equal(quadletField(unit.source,'Exec'),'tunnel --no-autoupdate --metrics 0.0.0.0:2000 run --token-file /run/secrets/token',
      'Tunnel Quadlet command differs from the reviewed token-file command');
    assert.deepEqual(unit.secretIdentities.map(secret=>secret.name),[tunnelTokenSecret],'Tunnel Quadlet contains an unexpected secret');
    assert.ok(unit.source.split(/\r?\n/u).includes('Requires=codexia-api-proxy.service')&&
      unit.source.split(/\r?\n/u).includes('After=network-online.target codexia-api-proxy.service'),
      'Tunnel must use the reviewed private proxy dependency');
    const observed=inspect('codexia-tunnel');
    assert.ok(observed?.State.Running,'Tunnel token rotation requires its running container');
    assert.ok(unit.secretIdentities.some(secret=>secret.name===tunnelTokenSecret&&secret.id===current.id),
      'Tunnel Quadlet does not reference the canonical token secret');
    const projection=containerRuntimeFingerprintProjection(observed,unit.secretIdentities);
    const tokenMount=projection.SecretMounts.find(secret=>secret.name===tunnelTokenSecret);
    assert.ok(tokenMount?.type==='mount'&&tokenMount.target==='/run/secrets/token'&&tokenMount.id===current.id,
      'Running Tunnel does not use its exact canonical token secret');
    const controllerObservation=await this.observe();
    assert.deepEqual(controllerObservation,{route:state.journal.active.slot,writers:[{slot:state.journal.active.slot,image:state.installed.image}]},
      'Tunnel token rotation requires the committed writer serving its route');
    return {operationId,originalSecretId:current.id,previousDigest:sha256(current.token),replacementDigest:sha256(candidate),
      sourceDigest:sha256(unit.source),fragmentDigest:sha256((await this.readBackupQuadletUnit('codexia-tunnel.service','codexia-tunnel.container')).fragment),
      imageId:unit.imageId,runtimeDigest:await this.tunnelTokenRuntimeDigest(unit.source,observed)};
  }
  async assertTunnelTokenRotationSources(snapshot){
    const unit=await this.readBackupQuadletUnit('codexia-tunnel.service','codexia-tunnel.container');
    assert.equal(quadletField(unit.source,'ContainerName'),'codexia-tunnel');
    assert.equal(quadletField(unit.source,'Secret'),`${tunnelTokenSecret},type=mount,target=/run/secrets/token`);
    assert.equal(quadletField(unit.source,'Exec'),'tunnel --no-autoupdate --metrics 0.0.0.0:2000 run --token-file /run/secrets/token');
    assert.ok(unit.source.split(/\r?\n/u).includes('Requires=codexia-api-proxy.service')&&
      unit.source.split(/\r?\n/u).includes('After=network-online.target codexia-api-proxy.service'));
    assert.equal(sha256(unit.source),snapshot.sourceDigest,'Tunnel Quadlet source changed during token rotation');
    assert.equal(sha256(unit.fragment),snapshot.fragmentDigest,'Generated Tunnel unit changed during token rotation');
    const image=JSON.parse(run('podman',['image','inspect',quadletField(unit.source,'Image')]))[0];
    assertLegacyBackupTunnelUnitIdentity({...unit,image,secretIdentities:[]});
    assert.equal(imageId(image.Id),snapshot.imageId,'Tunnel image identity changed during token rotation');
    const secret=readTunnelTokenSecret();
    assertKnownTunnelTokenSecret(secret,snapshot);
    return secret;
  }
  async verifyTunnelTokenRotation(snapshot,expectedDigest){
    const secret=await this.assertTunnelTokenRotationSources(snapshot);
    assert.ok(secret&&sha256(secret.token)===expectedDigest,'Canonical Tunnel token bytes differ from the expected rotation state');
    assert.equal(await this.tunnelServiceActive(),true,'Tunnel service did not become active');
    const observed=inspect('codexia-tunnel');
    assert.ok(observed?.State.Running,'Tunnel container is not running');
    assert.equal(await this.tunnelTokenRuntimeDigest((await this.legacyBackupTunnelSnapshot()).source,observed),snapshot.runtimeDigest,
      'Tunnel runtime changed during token rotation');
  }
  async assertTunnelStoppedForRotation(snapshot){
    await this.assertTunnelTokenRotationSources(snapshot);
    assert.equal(await this.tunnelRotationServiceActive(),false,'Tunnel service is not stopped for secret replacement');
    assert.equal(inspect('codexia-tunnel'),null,'Stopped Tunnel container remains during secret replacement');
  }
  async replaceTunnelToken(token,snapshot){
    const target=validateStandaloneTunnelToken(token);
    const existing=readTunnelTokenSecret();
    assertKnownTunnelTokenSecret(existing,snapshot);
    if(existing?.token!==target){
      if(existing)run('podman',['secret','rm',existing.id]);
      const inputFile=await prepareRotationSecretInput(this.config,snapshot,target,'tunnel-token-input');
      try{run('podman',['secret','create','--label',tunnelTokenRotationLabel+'='+snapshot.operationId,tunnelTokenSecret,inputFile]);}
      finally{await removeRotationSecretInput(inputFile);}
    }
    const after=readTunnelTokenSecret();
    assertKnownTunnelTokenSecret(after,snapshot);
    assert.ok(after?.token===target,'Canonical Tunnel secret replacement is unverified');
  }
  async verifyBlockedPasswordRotation(slot,release){
    assert.deepEqual(await this.observe(),{route:'blocked',writers:[{slot,image:release.image}]},'Exclusive writer or blocked route changed');
    await this.assertProxyRuntime();
    await this.waitReady(name(slot),release);
    run('podman',['exec',name(slot),'node','--input-type=module','-e',authProbeCode.replace('codexia-api-proxy:3000','127.0.0.1:3000')]);
    const check='const r=await fetch("http://127.0.0.1:3000/api/version",{signal:AbortSignal.timeout(3000)});if(r.status!==503)process.exit(1);';
    run('podman',['exec','codexia-api-proxy','node','--input-type=module','-e',check]);
  }
  async changePostgresAppPassword(password){
    passwordRotationPsql('codexia_admin',postgresAppPasswordChangeInput(password));
  }
  async replacePostgresAppSecret(password,snapshot){
    const target=validatePostgresAppPassword(password);
    const existing=readRotationSecret(appSecret);
    assertKnownRotationSecret(existing,snapshot);
    if(existing?.password!==target){
      if(existing)run('podman',['secret','rm',existing.id]);
      const inputFile=await prepareRotationSecretInput(this.config,snapshot,target);
      try{run('podman',['secret','create','--label',rotationLabel+'='+snapshot.operationId,appSecret,inputFile]);}
      finally{await removeRotationSecretInput(inputFile);}
    }
    const after=readRotationSecret(appSecret);
    assertKnownRotationSecret(after,snapshot);
    assert.ok(after?.password===target,'Canonical app secret replacement is unverified');
  }
  async captureApiAuthTokenRotation(replacement,operationId,state){
    const candidate=validateStandaloneAuthToken(replacement);
    const current=readAuthTokenSecret();
    assert.ok(current,'Canonical API token secret is missing');
    assert.ok(current.token.replace(/\n$/u,'')!==candidate.replace(/\n$/u,''),'Replacement API token must differ from the current token');
    const observation=await this.observe();
    assert.deepEqual(observation,{route:state.journal.active.slot,writers:[{slot:state.journal.active.slot,image:state.installed.image}]},
      'API token rotation requires the exact committed writer serving its route');
    return {operationId,originalSecretId:current.id,previousDigest:sha256(current.token),replacementDigest:sha256(candidate),token:current.token};
  }
  assertApiAuthTokenSecret(snapshot,expectedDigest=null){
    const secret=readAuthTokenSecret();
    assertApiAuthTokenSecretIdentity(secret,snapshot,expectedDigest);
  }
  async verifyMountedApiAuthToken(slot){
    const secret=readAuthTokenSecret();
    assert.ok(secret,'Canonical API token secret is missing');
    await this.verifyApiAuthToken(slot,secret.token,200);
  }
  async replaceApiAuthToken(token,snapshot){
    const target=validateStandaloneAuthToken(token);
    const existing=readAuthTokenSecret();
    assertKnownAuthTokenSecret(existing,snapshot);
    if(existing?.token!==target){
      if(existing)run('podman',['secret','rm',existing.id]);
      const inputFile=await prepareRotationSecretInput(this.config,snapshot,target,'api-auth-token-input');
      try{run('podman',['secret','create','--label',authTokenRotationLabel+'='+snapshot.operationId,authTokenSecret,inputFile]);}
      finally{await removeRotationSecretInput(inputFile);}
    }
    const after=readAuthTokenSecret();
    assertKnownAuthTokenSecret(after,snapshot);
    assert.ok(after?.token===target,'Canonical API token replacement is unverified');
  }
  async verifyApiAuthToken(slot,token,expectedStatus){
    assert.ok(['blue','green'].includes(slot));
    assert.ok([200,401].includes(expectedStatus));
    const script=`let value='';for await(const chunk of process.stdin)value+=chunk;const token=value.replace(/\\n$/u,'');const r=await fetch('http://127.0.0.1:3000/api/v1/persistence/status',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});if(r.status!==${expectedStatus})process.exit(1);if(${expectedStatus}===200){const body=await r.json();if(body.available!==true)process.exit(1)}else{const body=await r.json();if(body.code!=='UNAUTHORIZED')process.exit(1)}`;
    runWithSensitiveInput('podman',['exec','-i',name(slot),'node','--input-type=module','-e',script],validateStandaloneAuthToken(token),{timeout:15000});
  }
  async freshDatabaseIdentity(){
    const identity=run('podman',['exec','codexia-db','sh','-ec',
      'export PGPASSWORD="$(cat /run/secrets/admin-password)"; exec psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "SELECT system_identifier::text || chr(58) || oid::text FROM pg_control_system(), pg_database WHERE datname=current_database()"']);
    assert.match(identity,/^[1-9]\d{0,19}:[1-9]\d{0,9}$/u,'Canonical database identity is unobservable');
    return identity;
  }
  async inspectFreshSchema(release){
    const result=await this.initializeFreshSchema(release,{inspectOnly:true});
    assert.equal(typeof result.pristine,'boolean','Fresh database observation is invalid');
    return result;
  }
  async initializeFreshSchema(release,{inspectOnly=false}={}){
    assert.equal(release.profile,this.runtime?.profile,'Fresh schema release profile differs from runtime contract');
    // Run only the packaged migration authority, not the API entrypoint. No
    // persistent manuscript/history mount, API auth credential or public port.
    const result=JSON.parse(run('podman',['run','--rm','--name','codexia-schema-initializer','--network','codexia-data',
      '--read-only','--image-volume=ignore','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m',
      '--cap-drop','all','--security-opt','no-new-privileges',
      '--secret','codexia-postgres-app-password,type=mount,target=/run/secrets/app-password',
      '--entrypoint','node',release.image,'--input-type=module','-e',initializeSchemaCode,inspectOnly?'inspect':'initialize'],{timeout:300000}));
    if(inspectOnly)return result;
    assert.ok(Array.isArray(result.applied)&&result.applied.every(item=>typeof item==='string'),'Invalid migration result');
    return result;
  }
  async applyAdditiveSchema(release,expectedPriorFingerprint,expectedTargetFingerprint){
    assert.equal(release.migrationFingerprint,expectedTargetFingerprint,'Additive schema target fingerprint differs from release');
    const result=JSON.parse(run('podman',['run','--rm','--name','codexia-schema-maintainer','--network','codexia-data',
      '--read-only','--image-volume=ignore','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m',
      '--cap-drop','all','--security-opt','no-new-privileges',
      '--secret','codexia-postgres-app-password,type=mount,target=/run/secrets/app-password',
      '--entrypoint','node',release.image,'--input-type=module','-e',additiveSchemaCode,
      expectedPriorFingerprint,expectedTargetFingerprint],{timeout:300000}));
    assert.ok(Array.isArray(result.applied)&&result.applied.every(item=>typeof item==='string'),'Invalid additive migration result');
    assert.equal(result.fingerprint,expectedTargetFingerprint,'Additive migration fingerprint mismatch');
    return result;
  }
  async schemaFingerprint(release){
    assert.equal(release.profile,this.runtime?.profile,'Schema verification release profile differs from runtime contract');
    const result=run('podman',['run','--rm','--name','codexia-schema-verifier','--network','codexia-data',
      '--read-only','--image-volume=ignore','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m',
      '--cap-drop','all','--security-opt','no-new-privileges',
      '--secret','codexia-postgres-app-password,type=mount,target=/run/secrets/app-password',
      '--entrypoint','node',release.image,'--input-type=module','-e',
      "import {readFileSync} from 'node:fs'; import {verifyPostgresSchema} from '@codexia/api'; const password=readFileSync('/run/secrets/app-password','utf8').replace(/\\n+$/u,''); console.log(await verifyPostgresSchema('postgres://codexia:'+password+'@codexia-db:5432/codexia'));"],{timeout:300000});
    assert.match(result,/^sha256:[a-f0-9]{64}$/u,'Schema fingerprint is unobservable');
    return result;
  }
  async assertLegacyRelease(value,{allowUnadvertisedEpoch=false}={}){
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
    // The exceptional legacy observation is permitted only after the exact
    // old image, platform, source and runtime identity have been established.
    // The signed candidate must independently advertise its actual epoch.
    if(allowUnadvertisedEpoch&&version.apiEpoch===undefined){
      assertLegacyBackupIdentity({legacy,image,version},release,this.authEnvironment);
    }else{
      assertVersion(version,release,this.authEnvironment.CODEXIA_BROWSER_AUTH);
      assert.equal(image.Os+'/'+image.Architecture,release.platform,'Legacy image platform differs from selected release');
      assert.equal(image.Labels?.['org.opencontainers.image.revision']??image.Config?.Labels?.['org.opencontainers.image.revision'],release.sourceSha,'Legacy image source differs from selected release');
    }
    if(this.runtime){
      const expectedUnit=imageConfig(release,this.authEnvironment,this.runtime).replace('PLACEHOLDER','codexia-api');
      const capabilityStatus=await readRuntimeCapabilityStatus(legacy,'Legacy writer');
      assertRuntimeObservation(legacy,this.runtime,image.Config?.Env,expectedUnit,capabilityStatus);
      assertRuntimeUnitDropIns(run('systemctl',['--user','show','--property=DropInPaths','--value','codexia-api.service']));
      assertRuntimeUnit(run('systemctl',['--user','cat','codexia-api.service']),this.runtime);
      const processCgroupPath=await assertRuntimeProcessInSystemdUnit('codexia-api.service',legacy,'Legacy writer');
      await assertRuntimeProcessMemoryMax(processCgroupPath,this.runtime,'Legacy writer');
      await assertRuntimeSystemdCpuQuota('codexia-api.service',this.runtime);
    }
    const env=legacy.Config?.Env;
    assert.ok(Array.isArray(env),'Legacy browser auth settings are unobservable');
    for(const [key,value] of Object.entries(this.authEnvironment)){
      const actual=env.find(entry=>entry.startsWith(key+'='))?.slice(key.length+1);
      assert.equal(actual??(key==='CODEXIA_BROWSER_AUTH'?'token':undefined),value,'Legacy browser authentication configuration mismatch: '+key);
    }
    return {apiEpoch:version.apiEpoch??null};
  }
  async assertLegacyBackupRelease(value,{allowStopped=false,expectedIdentity}={}){
    const release=validateUpdateRelease(value);
    const snapshot=await this.legacyBackupUnitSnapshot(release);
    if(expectedIdentity!==undefined)assert.equal(snapshot.unitFingerprint,expectedIdentity.unitFingerprint,'Legacy API Quadlet/systemd source drifted during backup recovery');
    const legacy=inspect('codexia-api');
    for(const slot of ['blue','green'])assert.ok(!inspect(name(slot))?.State.Running,'Unexpected running slot writer');
    const image=JSON.parse(run('podman',['image','inspect',release.image]))[0];
    if(!legacy){
      assert.ok(allowStopped,'Legacy writer container is missing');
      return {unitFingerprint:snapshot.unitFingerprint,runtimeFingerprint:null};
    }
    const runtimeFingerprint=containerRuntimeFingerprint(legacy,snapshot.secretIdentities);
    if(expectedIdentity?.runtimeFingerprint)assert.equal(runtimeFingerprint,expectedIdentity.runtimeFingerprint,'Legacy API runtime drifted during backup recovery');
    const version=legacy.State.Running
      ? JSON.parse(run('podman',['exec','codexia-api','node','--input-type=module','-e',readyCode],{timeout:10000}))
      : null;
    assertLegacyBackupIdentity({legacy,image,version},release,this.authEnvironment,{requireRunning:!allowStopped});
    return {unitFingerprint:snapshot.unitFingerprint,runtimeFingerprint};
  }
  async assertLegacyBackupTunnel({allowStopped=false,expectedIdentity}={}){
    const snapshot=await this.legacyBackupTunnelSnapshot();
    if(expectedIdentity!==undefined)assert.equal(snapshot.unitFingerprint,expectedIdentity.unitFingerprint,'Legacy Tunnel Quadlet/systemd source drifted during backup recovery');
    const tunnel=inspect('codexia-tunnel');
    if(!tunnel){
      assert.ok(allowStopped,'Legacy Tunnel container is missing');
      return {unitFingerprint:snapshot.unitFingerprint,runtimeFingerprint:null};
    }
    assert.equal(imageId(tunnel.Image),snapshot.imageId,'Legacy Tunnel runtime image differs from its pinned Quadlet image');
    const runtimeFingerprint=containerRuntimeFingerprint(tunnel,snapshot.secretIdentities);
    if(expectedIdentity?.runtimeFingerprint)assert.equal(runtimeFingerprint,expectedIdentity.runtimeFingerprint,'Legacy Tunnel runtime drifted during backup recovery');
    if(allowStopped)assert.equal(tunnel.State.Running,false,'Legacy Tunnel unexpectedly resumed during backup recovery');
    else assert.equal(tunnel.State.Running,true,'Legacy Tunnel is not running during backup identity capture');
    return {unitFingerprint:snapshot.unitFingerprint,runtimeFingerprint};
  }
  async waitReady(container,release){
    const deadline=Date.now()+90000;
    for(;;){
      try{const version=JSON.parse(run('podman',['exec',container,'node','--input-type=module','-e',readyCode],{timeout:10000}));assertVersion(version,release,this.authEnvironment.CODEXIA_BROWSER_AUTH);return;}catch(error){if(Date.now()>=deadline||!inspect(container)?.State.Running)throw Error('Candidate did not become ready: '+container);}
      await delay(1000);
    }
  }
  async prepare(slot,release,owner){
    validateUpdateRelease(release);
    if(owner){
      assert.deepEqual(owner.release,release,'Initial preflight release differs from operation owner');
      await this.stopInitialPreflight(slot,owner);
    }else await this.stopPreflight(slot,release.image);
    // Only the preflight password is available; the real writer credential and shared volumes are absent.
    const auth=randomBytes(32).toString('hex');
    const runtimeArgs=this.runtime?runtimeContainerArgs(this.runtime):['--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m'];
    run('podman',['run','--detach','--name',preflight(slot),
      ...(owner?['--label','io.codexia.initial-activation='+owner.operationId]:['--label','io.codexia.preflight-image='+release.image]),'--network','codexia-data',
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
  async stopInitialPreflight(slot,{operationId,release}){
    assert.match(operationId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    const observed=inspect(preflight(slot));
    if(!observed)return;
    await this.removeOwnedPreflight(slot,observed,'io.codexia.initial-activation',operationId,release.image);
  }
  async stopPreflight(slot,expectedImage){
    assert.match(expectedImage,/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u,'Preflight cleanup requires a journal-owned image');
    const observed=inspect(preflight(slot));
    if(!observed)return;
    await this.removeOwnedPreflight(slot,observed,'io.codexia.preflight-image',expectedImage,expectedImage);
  }
  async removeOwnedPreflight(slot,observed,label,value,expectedImage){
    assert.equal(observed.Config?.Labels?.[label],value,label==='io.codexia.initial-activation'?'Initial preflight ownership is unverified':'Preflight ownership is unverified');
    assert.equal(observed.ImageName??observed.Config?.Image,expectedImage,'Preflight image drift');
    assert.match(observed.Id,/^[a-f0-9]{64}$/u,'Preflight container ID is unobservable');
    assert.ok(Array.isArray(observed.Mounts),'Preflight mounts are unobservable');
    assert.ok(observed.Mounts.every(mount=>mount.Type==='tmpfs'||(mount.Type==='bind'&&mount.RW===false&&
      this.runtime?.modelCachePath&&mount.Destination==='/models'&&mount.Source===this.runtime.modelCachePath)),
      'Preflight contains an unexpected persistent mount');
    // Remove only the admitted container ID. Do not remove attached volumes.
    run('podman',['rm','--force',observed.Id]);
    assert.ok(!exists(preflight(slot)),'Preflight absence is unverified');
  }
  async stopWriter(slot){
    const container=name(slot),unit=activeUnit(slot);
    let state=unitStatus(slot);
    if(!['inactive','failed'].includes(state)){
      run('systemctl',['--user','stop',unit],{timeout:120000});
      state=unitStatus(slot);
    }
    const observed=inspect(container);
    if(observed?.State.Running)throw Error('Writer fencing not confirmed');
    if(state==='failed'){
      if(observed!==null)throw Error('Failed writer unit still has its Podman container');
      run('systemctl',['--user','reset-failed',unit]);
      state=unitStatus(slot);
    }
    if(state!=='inactive')throw Error('Writer fencing not confirmed');
  }
  async startWriter(slot,release){
    validateUpdateRelease(release);
    const obs=await this.observe();assert.equal(obs.writers.length,0,'Refusing second writer');
    await this.assertNoWriterContainers();
    await this.assertNoPreflight();
    await mkdir(this.config.quadletDirectory,{recursive:true,mode:0o700});
    if(this.runtime)assert.equal(this.runtime.profile,release.profile,'Runtime contract release profile mismatch');
    await atomicWrite(path.join(this.config.quadletDirectory,name(slot)+'.container'),imageConfig(release,this.authEnvironment,this.runtime??undefined).replace('PLACEHOLDER',name(slot)));
    run('systemctl',['--user','daemon-reload']);
    await this.assertCommittedWriterUnitSource(slot);
    run('systemctl',['--user','start',activeUnit(slot)],{timeout:120000});
    await this.waitReady(name(slot),release);
    const after=await this.observe();assert.deepEqual(after.writers,[{slot,image:release.image}]);
  }
  async assertProxyRuntime(){
    const proxyQuadlet=await regularPrivateText(path.join(this.config.quadletDirectory,'codexia-api-proxy.container'),{privateOnly:true});
    const proxyContainer=inspect('codexia-api-proxy');
    assertRuntimeUnitDropIns(run('systemctl',['--user','show','--property=DropInPaths','--value','codexia-api-proxy.service']));
    const proxyUnitState=run('systemctl',['--user','show','--property=ActiveState','--value','codexia-api-proxy.service']);
    const proxyImage=proxyQuadlet.match(/^Image=(\S+)$/mu)?.[1];
    assert.ok(proxyImage,'Private proxy image is unobservable');
    const proxyImageInfo=JSON.parse(run('podman',['image','inspect',proxyImage]))[0];
    const capabilityStatus=await readRuntimeCapabilityStatus(proxyContainer,'Private proxy');
    assertProxyRuntimeObservation(proxyQuadlet,proxyContainer,proxyUnitState,proxyImageInfo,{home:path.resolve(path.dirname(this.config.stateFile),'../../..'),capabilityStatus});
  }
  async startInitialProxy(){
    assert.equal(await this.routeState(),'blocked','Private proxy must start with admission blocked');
    const filename=path.join(this.config.quadletDirectory,'codexia-api-proxy.container');
    await regularPrivateText(filename,{privateOnly:true});
    run('systemctl',['--user','daemon-reload']);
    assertRuntimeUnitDropIns(run('systemctl',['--user','show','--property=DropInPaths','--value','codexia-api-proxy.service']));
    assert.equal(run('systemctl',['--user','show','--property=SourcePath','--value','codexia-api-proxy.service']),filename,'Private proxy unit source drift');
    run('systemctl',['--user','start','codexia-api-proxy.service'],{timeout:120000});
    await this.assertProxyRuntime();
    const deadline=Date.now()+15000;
    for(;;){
      try{
        const status=run('podman',['exec','codexia-api-proxy','node','--input-type=module','-e',
          'const r=await fetch("http://127.0.0.1:3000/api/version",{signal:AbortSignal.timeout(3000)});console.log(r.status);'],{timeout:5000});
        assert.equal(status,'503','Blocked proxy unexpectedly admitted traffic');
        break;
      }catch(error){if(Date.now()>=deadline)throw error;await delay(250);}
    }
  }
  async probe(slot,release){
    await this.assertNoWriterContainers(slot);
    await this.assertProxyRuntime();
    await this.waitReady(name(slot),release);
    const routed=JSON.parse(run('podman',['exec','codexia-api-proxy','node','--input-type=module','-e',proxyProbeCode],{timeout:10000}));
    assert.equal(routed.slot,slot);assertVersion(routed.version,release,this.authEnvironment.CODEXIA_BROWSER_AUTH);
    run('podman',['exec',name(slot),'node','--input-type=module','-e',authProbeCode],{timeout:10000});
  }
}
