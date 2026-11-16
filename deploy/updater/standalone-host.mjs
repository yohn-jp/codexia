import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
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
  async stopLegacyWriter(){
    run('systemctl',['--user','stop','codexia-api.service'],{timeout:120000});
    assert.equal(await this.legacyServiceActive(),false,'Legacy API writer did not stop');
  }
  async startLegacyWriter(){
    run('systemctl',['--user','start','codexia-api.service'],{timeout:120000});
    assert.equal(await this.legacyServiceActive(),true,'Legacy API writer did not resume');
  }
  async stopTunnel(){
    run('systemctl',['--user','stop','codexia-tunnel.service'],{timeout:120000});
    assert.equal(await this.tunnelServiceActive(),false,'Tunnel did not stop');
  }
  async startTunnel(){
    run('systemctl',['--user','start','codexia-tunnel.service'],{timeout:120000});
    assert.equal(await this.tunnelServiceActive(),true,'Tunnel did not resume');
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
    const result=spawnSync('bash',[script,'backup-locked',destination,recipient],{
      encoding:'utf8',timeout:6*60*60*1000,maxBuffer:1024*1024,
      env:{...process.env,CODEXIA_UPDATER_LOCK_HELD:'1'},
    });
    if(result.error||result.status!==0){
      const status=result.status??'unknown';
      const message=(result.stderr??'').trim().slice(0,500);
      throw Error('Encrypted backup command failed (status '+status+')'+(message?': '+message:''));
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
