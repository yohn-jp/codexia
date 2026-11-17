import assert from 'node:assert/strict';
import test from 'node:test';
import {probeCredentialFiles,validateProbeCredential,assertProbeCredentialAccess,assertNoDropInPaths,assertProxyImageStable,timerActivationCommand,validateMaintenanceConfig} from '../deploy/updater/standalone-maintenance.mjs';
import {assertProxyRuntimeObservation} from '../deploy/updater/standalone-host.mjs';

const runtime={
  format:'codexia-runtime/v1',profile:'core',modelCachePath:null,
  tmpfs:{tempSize:'64m',moduleCacheSize:'1g'},
  resources:{memoryMaxBytes:null,cpuQuotaPercent:null},
};
const current={
  format:'codexia-standalone-updater/v1',enabled:true,
  stateFile:'/home/codexia/.local/state/codexia-updater/controller.json',
  routeFile:'/home/codexia/.local/state/codexia-updater/route',
  quadletDirectory:'/home/codexia/.config/containers/systemd',
  publicKeyFile:'/home/codexia/.config/codexia-updater/channel-public.pem',
  githubTokenFile:'/home/codexia/.config/codexia-updater/github-read-token',
  frontendIdentityUrl:'https://codexia.example.invalid/desktop/update-identity.json',
  accessClientIdFile:'/home/codexia/.config/codexia-updater/access-client-id',
  accessClientSecretFile:'/home/codexia/.config/codexia-updater/access-client-secret',
  observeMilliseconds:300000,initialSlot:'blue',
  browserAuth:{mode:'token'},runtime,
};
const release={image:'ghcr.io/yohn-jp/codexia-backend@sha256:'+'b'.repeat(64),profile:'core'};

test('maintenance preserves enabled state and immutable release and auth inputs',()=>{
  const candidate={...current,enabled:false,observeMilliseconds:600000};
  assert.deepEqual(validateMaintenanceConfig(current,candidate),{...candidate,enabled:true});
  for(const patch of [
    {browserAuth:{mode:'cloudflare-access',issuer:'https://example.cloudflareaccess.com',audience:'a'.repeat(64),origin:'https://codexia.example.invalid',ownerEmail:'owner@example.invalid'}},
    {publicKeyFile:'/home/codexia/other-key.pem'},
    {frontendIdentityUrl:'https://other.example.invalid/desktop/update-identity.json'},
    {initialSlot:'green'},
    {observeMilliseconds:1000},
    {observeMilliseconds:4000000},
  ])assert.throws(()=>validateMaintenanceConfig(current,{...candidate,...patch}));
});

test('approved locked maintenance accepts only a valid same-profile runtime contract change',()=>{
  const changedRuntime={...runtime,resources:{...runtime.resources,cpuQuotaPercent:200}};
  const candidate={...current,enabled:false,observeMilliseconds:600000,runtime:changedRuntime};
  assert.deepEqual(validateMaintenanceConfig(current,candidate),{...candidate,enabled:true});
  assert.throws(()=>validateMaintenanceConfig(current,{...candidate,runtime:{...changedRuntime,resources:{...changedRuntime.resources,cpuQuotaPercent:0}}}),/CPU quota/);
  assert.throws(()=>validateMaintenanceConfig(current,{...candidate,runtime:{...changedRuntime,profile:'full',modelCachePath:'/var/cache/codexia/models'}}),/profile/);
});

test('first runtime adoption observes the live writer against the candidate contract before mutation',async()=>{
  const {preflightMaintenanceRuntime}=await import('../deploy/updater/standalone-maintenance.mjs');
  assert.equal(typeof preflightMaintenanceRuntime,'function');
  const events=[];
  const currentHost={async verifyWriterUnits(){events.push('current-units');}};
  const candidateHost={async verifyWriterUnits(){events.push('candidate-units');}};
  const currentController={async assertServing(){events.push('current-serving');}};
  const candidateController={async assertServing(){events.push('candidate-serving');throw Error('legacy runtime environment drift');}};
  await assert.rejects(preflightMaintenanceRuntime({currentConfig:{},nextConfig:{runtime},currentHost,candidateHost,currentController,candidateController,state:{},activeSlot:'blue'}),/legacy runtime environment drift/);
  assert.deepEqual(events,['candidate-units','candidate-serving']);
});

test('runtime maintenance blocks the route and fences the old writer before starting the replacement',async()=>{
  const {transitionRuntimeWriter}=await import('../deploy/updater/standalone-maintenance.mjs');
  assert.equal(typeof transitionRuntimeWriter,'function');
  const events=[];
  const topology={route:'blue',writer:'blue'};
  const host=name=>({
    async route(value){events.push(name+':route:'+value);topology.route=value;},
    async stopWriter(slot){events.push(name+':stop:'+slot);if(topology.writer===slot)topology.writer=null;},
    async convergeWriterUnits(){events.push(name+':converge');},
    async startWriter(slot){events.push(name+':start:'+slot);assert.equal(topology.writer,null,'Refused overlapping writers');topology.writer=slot;},
  });
  const oldHost=host('old');
  const nextHost=host('next');
  await transitionRuntimeWriter({currentHost:oldHost,targetHost:nextHost,slot:'blue',release, state:{journal:{active:{slot:'blue'}}},verify:async()=>events.push('verify')});
  assert.deepEqual(events,['next:route:blocked','old:stop:blue','next:converge','next:start:blue','next:route:blue','verify']);
  assert.deepEqual(topology,{route:'blue',writer:'blue'});
});

test('failed runtime replacement can restore the prior writer while keeping the route fenced',async()=>{
  const {transitionRuntimeWriter}=await import('../deploy/updater/standalone-maintenance.mjs');
  assert.equal(typeof transitionRuntimeWriter,'function');
  const events=[];
  const topology={route:'blue',writer:'blue'};
  const host=(name,failStart=false)=>({
    async route(value){events.push(name+':route:'+value);topology.route=value;},
    async stopWriter(slot){events.push(name+':stop:'+slot);if(topology.writer===slot)topology.writer=null;},
    async convergeWriterUnits(){events.push(name+':converge');},
    async startWriter(slot){events.push(name+':start:'+slot);if(failStart)throw Error('candidate start failed');assert.equal(topology.writer,null);topology.writer=slot;},
  });
  const oldHost=host('old');
  const candidateHost=host('candidate',true);
  await assert.rejects(transitionRuntimeWriter({currentHost:oldHost,targetHost:candidateHost,slot:'blue',release,state:{journal:{active:{slot:'blue'}}},verify:async()=>{}}),/candidate start failed/);
  assert.equal(topology.route,'blocked');
  await transitionRuntimeWriter({currentHost:candidateHost,targetHost:oldHost,slot:'blue',release,state:{journal:{active:{slot:'blue'}}},verify:async()=>events.push('old-verify')});
  assert.deepEqual(topology,{route:'blue',writer:'blue'});
  assert.deepEqual(events.slice(-6),['old:route:blocked','candidate:stop:blue','old:converge','old:start:blue','old:route:blue','old-verify']);
});

test('maintenance refuses to change the private proxy image identity',()=>{
  const pinned='ghcr.io/yohn-jp/codexia-backend@sha256:'+'a'.repeat(64);
  const other='ghcr.io/yohn-jp/codexia-backend@sha256:'+'b'.repeat(64);
  assert.doesNotThrow(()=>assertProxyImageStable('[Container]\nImage='+pinned+'\nReadOnly=true\n','[Container]\nImage='+pinned+'\nReadOnly=true\n'));
  assert.throws(()=>assertProxyImageStable('[Container]\nImage='+pinned+'\n','[Container]\nImage='+other+'\n'),/proxy image change requires its own reviewed transition/);
  assert.throws(()=>assertProxyImageStable('[Container]\nReadOnly=true\n','[Container]\nReadOnly=true\n'),/proxy image identity is unobservable/);
});

test('maintenance suspends and restores the recorded updater timer state',()=>{
  assert.equal(timerActivationCommand({active:'active',enabled:'enabled'}),'start');
  assert.equal(timerActivationCommand({active:'inactive',enabled:'disabled'}),'stop');
  assert.throws(()=>timerActivationCommand({active:'unknown',enabled:'enabled'}),/active state is invalid/u);
});

test('maintenance refuses systemd unit drop-ins',()=>{
  assertNoDropInPaths('');
  assertNoDropInPaths('   ');
  assert.throws(()=>assertNoDropInPaths('/home/codexia/.config/systemd/user/codexia-updater.service.d/override.conf'),/drop-ins/u);
});

test('maintenance activates changed proxy source and verifies the replacement before completing',async()=>{
  const {activateProxyRevision}=await import('../deploy/updater/standalone-maintenance.mjs');
  assert.equal(typeof activateProxyRevision,'function');
  const events=[];
  assert.equal(await activateProxyRevision({changed:false,restart:async()=>events.push('restart'),verify:async()=>events.push('verify')}),false);
  assert.deepEqual(events,[]);
  assert.equal(await activateProxyRevision({changed:true,restart:async()=>events.push('restart'),verify:async()=>events.push('verify')}),true);
  assert.deepEqual(events,['restart','verify']);
});

test('maintenance requires the running proxy to match its private digest-pinned runtime contract',()=>{
  const digest='a'.repeat(64);
  const home='/home/codexia';
  const quadlet='[Container]\nImage=ghcr.io/yohn-jp/codexia-backend@sha256:'+digest+'\nContainerName=codexia-api-proxy\nNetwork=codexia.network\nVolume=/opt/codexia-updater/deploy/updater/proxy.mjs:/config/proxy.mjs:ro,Z\nVolume=%h/.local/state/codexia-updater:/config/state:ro,Z\nUser=0\nEntrypoint=node\nExec=/config/proxy.mjs\nReadOnly=true\nNoNewPrivileges=true\nDropCapability=all\nTmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m\n';
  const proxyImageEnvironment=['PATH=/usr/bin','NODE_ENV=production'];
  const imageInfo={Id:'sha256:'+'c'.repeat(64),RepoDigests:['ghcr.io/yohn-jp/codexia-backend@sha256:'+digest],Config:{Env:proxyImageEnvironment}};
  const containerId='e'.repeat(64);
  const capabilityStatus=['CapInh:\t0000000000000000','CapPrm:\t0000000000000000','CapEff:\t0000000000000000','CapBnd:\t0000000000000000','CapAmb:\t0000000000000000'].join('\n');
  const proxyOptions={home,capabilityStatus};
  const container={
    Id:containerId,Name:'/codexia-api-proxy',State:{Running:true,Pid:123},Image:'sha256:'+'c'.repeat(64),ImageName:'ghcr.io/yohn-jp/codexia-backend@sha256:'+digest,
    Config:{Hostname:containerId.slice(0,12),User:'0',Env:[...proxyImageEnvironment,'HOSTNAME='+containerId.slice(0,12)],Entrypoint:['node'],Cmd:['/config/proxy.mjs']},
    HostConfig:{PortBindings:{},ReadonlyRootfs:true,CapDrop:['CAP_CHOWN','CAP_DAC_OVERRIDE','CAP_FOWNER','CAP_FSETID','CAP_KILL','CAP_NET_BIND_SERVICE','CAP_SETFCAP','CAP_SETGID','CAP_SETPCAP','CAP_SETUID','CAP_SYS_CHROOT'],CapAdd:[],SecurityOpt:['no-new-privileges:true'],Tmpfs:{'/tmp':'rw,nosuid,nodev,noexec,size=16m,rprivate,tmpcopyup'}},
    NetworkSettings:{Networks:{codexia:{}}},
    Mounts:[
      {Type:'bind',Source:'/opt/codexia-updater/deploy/updater/proxy.mjs',Destination:'/config/proxy.mjs',RW:false},
      {Type:'bind',Source:home+'/.local/state/codexia-updater',Destination:'/config/state',RW:false},
    ],
  };
  assertProxyRuntimeObservation(quadlet,container,'active',imageInfo,proxyOptions);
  assert.throws(()=>assertProxyRuntimeObservation(quadlet,container,'active',imageInfo,{...proxyOptions,capabilityStatus:capabilityStatus.replace('CapEff:\t0000000000000000','CapEff:\t0000000000000001')}),/CapEff must be zero/u);
  assert.throws(()=>assertProxyRuntimeObservation(quadlet,{...container,HostConfig:{...container.HostConfig,CapAdd:['CAP_SYS_ADMIN']}},'active',imageInfo,proxyOptions),/unexpected capability additions/u);
  assert.throws(()=>assertProxyRuntimeObservation(quadlet,{...container,Image:'sha256:'+'d'.repeat(64)},'active',imageInfo,proxyOptions),/different image content/u);
  assert.throws(()=>assertProxyRuntimeObservation(quadlet,{...container,State:{Running:false,Pid:123}},'active',imageInfo,proxyOptions),/not running/u);
  assert.throws(()=>assertProxyRuntimeObservation(quadlet,{...container,HostConfig:{...container.HostConfig,PortBindings:{'3000/tcp':[{HostIp:'0.0.0.0',HostPort:'3000'}] } }},'active',imageInfo,proxyOptions),/host port/u);
  assert.throws(()=>assertProxyRuntimeObservation(quadlet,{...container,NetworkSettings:{Networks:{codexia:{},host:{}}}},'active',imageInfo,proxyOptions),/network/u);
  assert.throws(()=>assertProxyRuntimeObservation(quadlet,{...container,Mounts:container.Mounts.map(mount=>mount.Destination==='/config/state'?{...mount,RW:true}:mount)},'active',imageInfo,proxyOptions),/mount/u);
  assert.throws(()=>assertProxyRuntimeObservation(quadlet,{...container,HostConfig:{...container.HostConfig,ReadonlyRootfs:false}},'active',imageInfo,proxyOptions),/root filesystem is not read-only/u);
  assert.throws(()=>assertProxyRuntimeObservation(quadlet.replace('ReadOnly=true','ReadOnly=false'),container,'active',imageInfo,proxyOptions),/Quadlet ReadOnly contract drift/u);
  assert.throws(()=>assertProxyRuntimeObservation(quadlet, {...container,HostConfig:{...container.HostConfig,SecurityOpt:['no-new-privileges:true','seccomp=unconfined']}},'active',imageInfo,proxyOptions),/security options/u);
  assert.throws(()=>assertProxyRuntimeObservation(quadlet,{...container,Config:{...container.Config,Entrypoint:['sh']}},'active',imageInfo,proxyOptions),/entrypoint/u);
  assert.throws(()=>assertProxyRuntimeObservation(quadlet,{...container,Config:{...container.Config,Env:[...proxyImageEnvironment,'NODE_OPTIONS=--require=/tmp/inject.js']}},'active',imageInfo,proxyOptions),/unexpected runtime environment/u);
});


test('probe rotation targets only three canonical private credential files and rejects unsafe values',()=>{
  const targets=probeCredentialFiles(current,'/home/codexia/.config/codexia-updater/config.json');
  assert.deepEqual(targets.map(x=>x.target),[current.githubTokenFile,current.accessClientIdFile,current.accessClientSecretFile]);
  assert.throws(()=>probeCredentialFiles({...current,githubTokenFile:current.publicKeyFile},'/home/codexia/.config/codexia-updater/config.json'),/canonical private path/);
  assert.throws(()=>probeCredentialFiles({...current,accessClientSecretFile:undefined},'/home/codexia/.config/codexia-updater/config.json'),/canonical private path/);
  for(const bad of ['', 'with space','two\nlines','abc\r\n','x'.repeat(8193)])assert.throws(()=>validateProbeCredential(bad),/Invalid protected probe credential/);
  validateProbeCredential('valid-token\n');
});
test('probe credential admission requires a fresh signed channel and compatible real frontend',async()=>{
  const {generateKeyPairSync}=await import('node:crypto');
  const {signUpdateChannel,verifyUpdateChannel}=await import('./update-channel.mjs');
  const key=generateKeyPairSync('ed25519');
  const pub=key.publicKey.export({type:'spki',format:'pem'});
  const priv=key.privateKey.export({type:'pkcs8',format:'pem'});
  const now=Date.now();
  const installed={format:'codexia-update-release/v1',channel:'stable',state:'published',version:'0.1.0',sourceSha:'a'.repeat(40),image:release.image,platform:'linux/amd64',profile:'core',migrationFingerprint:'sha256:'+'c'.repeat(64),persistenceFormat:1,apiEpoch:1};
  const signed=signUpdateChannel({format:'codexia-update-channel/v1',sequence:1,issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString(),releases:[installed]},priv,now);
  const state={installed,journal:{checkpoint:verifyUpdateChannel(signed,pub,null,now).checkpoint}};
  const host={fetchChannel:async()=>signed,probeAccessCredentials:async release=>{assert.deepEqual(release,installed);}};
  await assertProbeCredentialAccess(host,state,pub);
  await assert.rejects(assertProbeCredentialAccess({...host,fetchChannel:async()=>{throw Error('secret-value');}},state,pub),error=>error.message==='Probe credentials did not verify the signed channel and scoped live identity access');
  await assert.rejects(assertProbeCredentialAccess({...host,probeAccessCredentials:async()=>{throw Error('ACCESS_BOUNDARY');}},state,pub),/Probe credentials did not verify/);
  await assert.rejects(assertProbeCredentialAccess(host,{...state,installed:{...installed,apiEpoch:2}},pub),/Probe credentials did not verify/);
});
