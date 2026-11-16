import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdir, open, readFile, readlink, rmdir, stat, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
async function ensureDirectoryTreeDurable(directory){
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
  const {CreateCommand:_createCommand,Secrets:_secrets,Env,Hostname:_hostname,...configSettings}=config;
  const sanitizedConfig={...configSettings,Env:safeEnvironment(Env??[]),Hostname:configuredRuntimeHostname(container)};
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
export function imageConfig(release,authEnvironment){
  return `[Unit]
Description=Codexia exclusive writer
Requires=codexia-db.service
After=codexia-db.service
[Container]
Image=${release.image}
ContainerName=PLACEHOLDER
Network=codexia.network
Network=codexia-data.network
Volume=codexia-data.volume:/data
Volume=codexia-history.volume:/history
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
ReadOnly=true
Tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m
NoNewPrivileges=true
DropCapability=all
StopTimeout=60
[Service]
Restart=on-failure
RestartSec=10
TimeoutStartSec=120
TimeoutStopSec=90
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
    this.config=config;this.url=url.href;
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
        writers.push({slot,image:configured});
      }
    }
    return {route,writers};
  }
  async assertNoPreflight(){
    for(const slot of ['blue','green'])assert.ok(!exists(preflight(slot)),'Unexpected preflight container prevents backup');
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
  async legacyServiceActive(){
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
    assert.equal(await this.legacyServiceActive(),false,'Legacy API writer did not stop');
  }
  backupStartupFencePaths(){
    const quadletDirectory=path.resolve(this.config.quadletDirectory);
    const serviceHome=path.resolve(quadletDirectory,'../../..');
    assert.equal(quadletDirectory,path.join(serviceHome,'.config','containers','systemd'),'Legacy Quadlet directory is outside the service home');
    const directory=path.join(serviceHome,'.config','systemd','user');
    const intent=path.join(path.dirname(this.config.stateFile),'backup-intent.json');
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
      assert.equal(dropIn,entry.file,'Legacy service has an unreviewed systemd drop-in: '+unit);
      assert.equal(await regularPrivateText(dropIn,{privateOnly:true}),entry.content,'Legacy service backup fence differs from the reviewed condition: '+unit);
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
    const env=legacy.Config?.Env;
    assert.ok(Array.isArray(env),'Legacy browser auth settings are unobservable');
    for(const [key,value] of Object.entries(this.authEnvironment)){
      const actual=env.find(entry=>entry.startsWith(key+'='))?.slice(key.length+1);
      assert.equal(actual??(key==='CODEXIA_BROWSER_AUTH'?'token':undefined),value,'Legacy browser authentication configuration mismatch: '+key);
    }
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
  async prepare(slot,release){
    validateUpdateRelease(release);
    await this.stopPreflight(slot);
    // Only the preflight password is available; the real writer credential and shared volumes are absent.
    const auth=randomBytes(32).toString('hex');
    run('podman',['run','--detach','--name',preflight(slot),'--network','codexia-data',
      '--read-only','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m','--tmpfs','/data:rw,nosuid,nodev,noexec,size=128m,mode=1777',
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
    await atomicWrite(path.join(this.config.quadletDirectory,name(slot)+'.container'),imageConfig(release,this.authEnvironment).replace('PLACEHOLDER',name(slot)));
    run('systemctl',['--user','daemon-reload']);
    run('systemctl',['--user','start',activeUnit(slot)],{timeout:120000});
    await this.waitReady(name(slot),release);
    const after=await this.observe();assert.deepEqual(after.writers,[{slot,image:release.image}]);
  }
  async probe(slot,release){
    await this.waitReady(name(slot),release);
    const routed=JSON.parse(run('podman',['exec','codexia-api-proxy','node','--input-type=module','-e',proxyProbeCode],{timeout:10000}));
    assert.equal(routed.slot,slot);assertVersion(routed.version,release,this.authEnvironment.CODEXIA_BROWSER_AUTH);
    run('podman',['exec',name(slot),'node','--input-type=module','-e',authProbeCode],{timeout:10000});
  }
}
