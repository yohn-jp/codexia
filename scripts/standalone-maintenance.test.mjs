import assert from 'node:assert/strict';
import test from 'node:test';
import {probeCredentialFiles,validateProbeCredential,validatePostgresAppPassword,validateAppPasswordRotationManifest,validatePostgresAppPasswordRotation,assertProbeCredentialAccess,recoverProbeCredentialWriter,assertNoDropInPaths,assertProxyImageStable,timerActivationCommand,validateMaintenanceConfig} from '../deploy/updater/standalone-maintenance.mjs';
import {assertProxyRuntimeObservation,PodmanStandaloneHost} from '../deploy/updater/standalone-host.mjs';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

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
test('app-password rotation accepts only a fixed private candidate and matching receipt path',()=>{
  const root='/home/codexia/.config/codexia-updater/maintenance/candidates/test';
  const manifest={format:'codexia-updater-maintenance/v1',candidateRoot:root,
    configPath:'/home/codexia/.config/codexia-updater/config.json',sourceDir:'/opt/codexia-updater',
    unitDir:'/home/codexia/.config/systemd/user',rotatePostgresAppPassword:true,
    appPasswordFile:root+'/credentials/postgres-app-password',restoreReceiptFile:root+'/restore-receipt.json',databaseQuadletFile:root+'/quadlet/codexia-db.container'};
  assert.deepEqual(validateAppPasswordRotationManifest(manifest,root+'/manifest.json','/home/codexia'),
    {appPasswordFile:manifest.appPasswordFile,restoreReceiptFile:manifest.restoreReceiptFile,databaseQuadletFile:manifest.databaseQuadletFile});
  assert.throws(()=>validateAppPasswordRotationManifest({...manifest,databaseQuadletFile:'/tmp/db.container'},root+'/manifest.json','/home/codexia'));
  assert.throws(()=>validateAppPasswordRotationManifest({...manifest,arbitraryTarget:'/etc/passwd'},root+'/manifest.json','/home/codexia'));
  assert.throws(()=>validateAppPasswordRotationManifest({...manifest,appPasswordFile:'/tmp/password'},root+'/manifest.json','/home/codexia'));
  assert.throws(()=>validateAppPasswordRotationManifest({...manifest,restoreReceiptFile:'/tmp/receipt.json'},root+'/manifest.json','/home/codexia'));
  assert.throws(()=>validateAppPasswordRotationManifest(manifest,root+'/elsewhere.json','/home/codexia'));
  const mounted='/home/codexia/.local/state/codexia-updater/maintenance/candidates/test';
  const visible={...manifest,candidateRoot:mounted,appPasswordFile:mounted+'/credentials/postgres-app-password',
    restoreReceiptFile:mounted+'/restore-receipt.json',databaseQuadletFile:mounted+'/quadlet/codexia-db.container'};
  assert.throws(()=>validateAppPasswordRotationManifest(visible,mounted+'/manifest.json','/home/codexia'),/private staging root/);

});
test('app-password validation accepts exactly 32-byte hexadecimal values without echoing invalid input',()=>{
  const password='a'.repeat(64);
  assert.equal(validatePostgresAppPassword(password),password);
  assert.equal(validatePostgresAppPassword(password+'\n'),password+'\n');
  for(const candidate of ['short','g'.repeat(64),password+'\n\n','s'.repeat(8193)]){
    assert.throws(()=>validatePostgresAppPassword(candidate),error=>
      error instanceof Error&&error.message==='Invalid protected app password'&&!error.message.includes(candidate));
  }
});
test('app-password recovery marker binds only the canonical secret, database and previous password snapshot',()=>{
  const snapshotRoot='/home/codexia/.local/state/codexia-updater/maintenance/snapshots/operation';
  const marker={format:'codexia-postgres-app-password-rotation/v1',secretName:'codexia-postgres-app-password',
    previousPasswordFile:snapshotRoot+'/postgres-app-password',databaseId:'123456789:12345',slot:'blue',releaseImage:release.image};
  assert.deepEqual(validatePostgresAppPasswordRotation(marker,snapshotRoot),marker);
  assert.throws(()=>validatePostgresAppPasswordRotation({...marker,secretName:'codexia-auth-token'},snapshotRoot));
  assert.throws(()=>validatePostgresAppPasswordRotation({...marker,previousPasswordFile:'/tmp/secret'},snapshotRoot));
  assert.throws(()=>validatePostgresAppPasswordRotation({...marker,databaseId:'unknown'},snapshotRoot));
  assert.throws(()=>validatePostgresAppPasswordRotation({...marker,newPassword:'a'.repeat(64)},snapshotRoot));
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

test('VM probe credentials use the canonical live identity and denial paths',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'codexia-probe-'));
 try{
  const id=path.join(dir,'id'),secret=path.join(dir,'secret');
  await writeFile(id,'test-client-id\n',{mode:0o600});await writeFile(secret,'test-client-secret\n',{mode:0o600});
  const host=new PodmanStandaloneHost({...current,accessClientIdFile:id,accessClientSecretFile:secret});
  const installed={...release,version:'0.1.0',apiEpoch:1};
  const frontend={format:'codexia-frontend-identity/v1',sourceSha:'a'.repeat(40),version:'0.1.0',profile:'core',apiEpoch:1};
  const backend={name:'codexia',version:'0.1.0',hosted:false,profile:'core',apiEpoch:1,browserAuth:'token'};
  const calls=[];
  function fetcher(failure){
    return async(url,options)=>{
      const endpoint=new URL(url).pathname,authenticated=Boolean(options.headers['CF-Access-Client-Id']);
      assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');
      calls.push([endpoint,authenticated]);
      if(authenticated){
        assert.equal(options.headers['CF-Access-Client-Id'],'test-client-id');
        assert.equal(options.headers['CF-Access-Client-Secret'],'test-client-secret');
      }
      if(!authenticated)return new Response(null,{status:failure==='anonymous'&&endpoint==='/api/version'?200:403});
      if(endpoint==='/api/version')return failure==='backend-denied'?new Response(null,{status:403}):Response.json(failure==='wrong-backend'?{...backend,apiEpoch:2}:backend);
      if(endpoint==='/desktop/update-identity.json')return Response.json(frontend);
      return new Response(null,{status:failure==='overbroad'?200:403});
    };
  }
  const observed=await host.probeAccessCredentials(installed,{fetchImpl:fetcher(null)});
  assert.deepEqual(observed,{backend,deployed:frontend});
  assert.deepEqual(calls.map(item=>JSON.stringify(item)).sort(),[
    ['/api/version',true],['/desktop/update-identity.json',true],['/api/version',false],
    ['/desktop/update-identity.json',false],['/',true],['/api/ready',true],
  ].map(item=>JSON.stringify(item)).sort());
  for(const failure of ['anonymous','backend-denied','wrong-backend','overbroad']){
    await assert.rejects(host.probeAccessCredentials(installed,{fetchImpl:fetcher(failure)}),/Production deployment preflight failed/);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('credential recovery restarts only the absent committed writer behind blocked admission',async()=>{
 const installed={...release};
 const state={installed,journal:{phase:'idle',active:{slot:'blue',image:installed.image}},lastError:null};
 for(const kind of ['absent','present','present-with-stopped-foreign','foreign','stopped-foreign','foreign-preflight','source-drift','shadow-unit']){
   let writers=['present','present-with-stopped-foreign'].includes(kind)?[{slot:'blue',image:installed.image}]:kind==='foreign'?[{slot:'green',image:installed.image}]:[];
   const trace=[];
   const host={runtime:current.runtime,
     assertRuntimeSources:async()=>{},assertInitialLegacyAbsent:async()=>{},
     assertNoPreflight:async()=>{if(kind==='foreign-preflight')throw Error('foreign preflight');},
     verifyWriterUnits:async()=>{if(kind==='source-drift')throw Error('source drift');},
     assertCommittedWriterUnitSource:async()=>{if(kind==='shadow-unit')throw Error('not a generated Quadlet');},
     observe:async()=>({route:'blocked',writers}),
     assertNoWriterContainers:async(allowedSlot)=>{
       assert.equal(allowedSlot,writers.length?'blue':undefined);
       if(['stopped-foreign','present-with-stopped-foreign'].includes(kind))throw Error('stopped foreign container');
     },
     startWriter:async(slot,r)=>{trace.push(slot);assert.equal(r,installed);writers=[{slot,image:r.image}];}
   };
   if(['absent','present'].includes(kind))await recoverProbeCredentialWriter({host,state});
   else await assert.rejects(recoverProbeCredentialWriter({host,state}));
   assert.deepEqual(trace,kind==='absent'?['blue']:[]);
 }
});

test('boot recovery runs when the database failed or needs to be explicitly stopped',async()=>{
  const unit=await readFile(new URL('../deploy/updater/codexia-updater-boot.service.example',import.meta.url),'utf8');
  assert.match(unit,/^Wants=codexia-db\.service$/mu);
  assert.match(unit,/^Requires=codexia-api-proxy\.service$/mu);
  assert.match(unit,/^After=codexia-db\.service codexia-api-proxy\.service$/mu);
  const boot=await readFile(new URL('../deploy/updater/standalone-updater.mjs',import.meta.url),'utf8');
  assert.ok(boot.indexOf('await recoverInterruptedMaintenance')<boot.indexOf("await host.unitActive('codexia-db.service')"));
});

test('interrupted password rotation restores old SQL and mounted credentials at each disruption boundary',async()=>{
  const {applyPostgresAppPassword}=await import('../deploy/updater/standalone-maintenance.mjs');
  assert.equal(typeof applyPostgresAppPassword,'function');
  const old='a'.repeat(64),candidate='b'.repeat(64);
  const state={journal:{phase:'committed',active:{slot:'blue',image:release.image}},installed:release,paused:true,lastError:null};
  const expected={databaseId:'123:42',databaseQuadlet:'reviewed',identity:{volume:'original'},originalSecretId:'old',operationId:'transaction',replacementDigest:'digest'};
  for(const crash of ['block','stop-writer','sql','stop-db','delete','create','start-db','start-writer','serve']){
    let secret=old,role=old,database=true,writer=true,route='blue',fault=crash;
    const done=where=>{if(where===fault){fault=null;throw Error('simulated interruption');}};
    const host={
      route:async slot=>{route=slot;done('block');},
      assertPasswordRotationSources:async()=>{},
      passwordRotationDatabase:async()=>{assert.equal(route,'blocked');return database;},
      verifyWriterUnits:async()=>{},assertCommittedWriterUnitSource:async()=>{},assertRuntimeSources:async()=>{},
      assertInitialLegacyAbsent:async()=>{},assertNoPreflight:async()=>{},assertNoWriterContainers:async()=>{},
      observe:async()=>({writers:writer?[state.journal.active]:[],route}),
      stopWriter:async()=>{writer=false;done('stop-writer');},
      passwordRotationDatabaseId:async()=>{assert.ok(database);return '123:42';},
      changePostgresAppPassword:async value=>{assert.ok(database&&!writer);role=value;done('sql');},
      stopPasswordRotationDatabase:async()=>{assert.ok(!writer);database=false;done('stop-db');},
      replacePostgresAppSecret:async value=>{assert.ok(!database&&!writer);secret=null;done('delete');secret=value;done('create');},
      startPasswordRotationDatabase:async()=>{assert.ok(secret);database=true;done('start-db');},
      verifyPostgresAppPassword:async value=>{assert.equal(role,value);assert.equal(secret,value);},
      startWriter:async()=>{assert.equal(role,secret);writer=true;done('start-writer');},
      verifyBlockedPasswordRotation:async()=>{assert.ok(writer&&database);assert.equal(route,'blocked');},
    };
    const verify=async()=>{assert.equal(route,'blue');done('serve');};
    const args={state,host,snapshot:expected,verify};
    await assert.rejects(applyPostgresAppPassword({...args,password:candidate,recovering:false}),/simulated interruption/);
    await applyPostgresAppPassword({...args,password:old,recovering:true});
    await applyPostgresAppPassword({...args,password:old,recovering:true});
    assert.deepEqual({secret,role,database,writer,route},{secret:old,role:old,database:true,writer:true,route:'blue'});
  }
});

test('rotation refuses an unpaused controller and unexpected runtime identities before stopping a writer',async()=>{
  const {applyPostgresAppPassword}=await import('../deploy/updater/standalone-maintenance.mjs');
  assert.equal(typeof applyPostgresAppPassword,'function');
  const state={journal:{phase:'committed',active:{slot:'blue',image:release.image}},installed:release,paused:true,lastError:null};
  const host={route:async()=>{},assertPasswordRotationSources:async()=>{throw Error('Quadlet drift');}};
  const args={host,state,snapshot:{},password:'a'.repeat(64),recovering:true};
  await assert.rejects(applyPostgresAppPassword({...args,state:{...state,paused:false}}),/paused/);
  await assert.rejects(applyPostgresAppPassword(args),/Quadlet drift/);
});

test('locked rotation checks current publication, private receipt and paused journal before capturing a rollback token',async()=>{
  const {checkRotationBackup}=await import('../deploy/updater/standalone-maintenance.mjs');
  assert.equal(typeof checkRotationBackup,'function');
  const {initialControllerState}=await import('./standalone-update-controller.mjs');
  const full={...release,format:'codexia-update-release/v1',channel:'stable',state:'published',version:'1.2.3',sourceSha:'c'.repeat(40),
    platform:'linux/amd64',migrationFingerprint:'sha256:'+'a'.repeat(64),persistenceFormat:1,apiEpoch:1};
  const state=initialControllerState(full,'blue',null);
  const root=await mkdtemp(path.join(tmpdir(),'rotation-proof-'));
  try{
    const hash='f'.repeat(64),databaseId='123:42',receiptFile=path.join(root,'receipt.json');
    const source={format:'codexia-controller-backup-proof/v1',release:full,databaseId,journalGeneration:state.journal.generation,
      artifactDirectory:'/mnt/backups/codexia-20261117T000000Z-12345678-1234-1234-1234-123456789abc',checksumManifestSha256:hash};
    await writeFile(path.join(root,'controller-backup-proof.json'),JSON.stringify(source),{mode:0o600});
    const receipt={format:'codexia-restore-receipt/v1',checksumManifestSha256:hash};
    await writeFile(receiptFile,JSON.stringify(receipt),{mode:0o600});
    const host={backupArtifactIdentity:async directory=>{assert.equal(directory,source.artifactDirectory);return hash;}};
    const args={state,stateDir:root,receiptFile,host,databaseId};
    assert.deepEqual(await checkRotationBackup(args),source);
    await assert.rejects(checkRotationBackup({...args,databaseId:'111:22'}));
    await assert.rejects(checkRotationBackup({...args,state:{...state,paused:false}}));
    await assert.rejects(checkRotationBackup({...args,host:{backupArtifactIdentity:async()=>'e'.repeat(64)}}));
    await writeFile(receiptFile,JSON.stringify({...receipt,checksumManifestSha256:'e'.repeat(64)}));
    await assert.rejects(checkRotationBackup(args));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('private rollback snapshots survive process death and cannot trust a changed controller or corrupt previous password',async()=>{
  const {savePasswordRotationSnapshot,loadPasswordRotationSnapshot}=await import('../deploy/updater/standalone-maintenance.mjs');
  assert.equal(typeof savePasswordRotationSnapshot,'function');
  const {createHash,randomUUID}=await import('node:crypto');
  const root=await mkdtemp(path.join(tmpdir(),'rotation-snapshot-'));
  const password='f'.repeat(64),operationId=randomUUID();
  const config={...current,stateFile:path.join(root,'state','controller.json'),publicKeyFile:path.join(root,'private','channel.pem')};
  const state={installed:release,journal:{phase:'committed',active:{slot:'blue',image:release.image}},paused:true,lastError:null};
  const snapshot={operationId,databaseId:'123:42',databaseQuadlet:'exact\n',previousDigest:createHash('sha256').update(password).digest('hex')};
  try{
    const marker=await savePasswordRotationSnapshot({config,state,snapshot,previousPassword:password,timer:{active:'inactive',enabled:'disabled'}});
    assert.ok(!JSON.stringify(marker).includes(password));
    assert.ok(!marker.rotation.previousPasswordFile.startsWith(path.dirname(config.stateFile)+'/'));
    const contents=await loadPasswordRotationSnapshot({config,state,marker});
    assert.deepEqual(contents.snapshot,snapshot);
    assert.equal(contents.password,password);
    await assert.rejects(loadPasswordRotationSnapshot({config,state:{...state,lastError:'drift'},marker}));
    await writeFile(marker.rotation.previousPasswordFile,'e'.repeat(64));
    await assert.rejects(loadPasswordRotationSnapshot({config,state,marker}),/snapshot/i);
    await assert.rejects(loadPasswordRotationSnapshot({config,state,marker:{...marker,operationId:'../../arbitrary'}}));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('maintain routes a staged PostgreSQL request through the paused admission gate',async()=>{
  const {maintainStandaloneUpdater}=await import('../deploy/updater/standalone-maintenance.mjs');
  const {mkdir}=await import('node:fs/promises');
  const root=await mkdtemp(path.join(tmpdir(),'rotation-entry-')),before=process.env.CODEXIA_UPDATER_LOCK_DIRECTORY;
  const stateDir=path.join(root,'.local/state/codexia-updater'),candidateRoot=path.join(root,'.config/codexia-updater/maintenance/candidates/operation');
  const config={...current,stateFile:path.join(stateDir,'controller.json'),quadletDirectory:path.join(root,'.config/containers/systemd'),publicKeyFile:path.join(root,'.config/codexia-updater/channel.pem')};
  const manifestPath=path.join(candidateRoot,'manifest.json');
  try{
    process.env.CODEXIA_UPDATER_LOCK_DIRECTORY=stateDir;
    await mkdir(candidateRoot,{recursive:true,mode:0o700});
    await writeFile(manifestPath,JSON.stringify({format:'codexia-updater-maintenance/v1',candidateRoot,sourceDir:'/opt/codexia-updater',
      configPath:path.join(root,'.config/codexia-updater/config.json'),unitDir:path.join(root,'.config/systemd/user'),rotatePostgresAppPassword:true,
      appPasswordFile:path.join(candidateRoot,'credentials/postgres-app-password'),restoreReceiptFile:path.join(candidateRoot,'restore-receipt.json'),
      databaseQuadletFile:path.join(candidateRoot,'quadlet/codexia-db.container')}),{mode:0o600});
    await assert.rejects(maintainStandaloneUpdater({config,manifestPath,state:{paused:false,journal:{phase:'idle'},lastError:null}}),/paused/);
  }finally{
    if(before===undefined)delete process.env.CODEXIA_UPDATER_LOCK_DIRECTORY;else process.env.CODEXIA_UPDATER_LOCK_DIRECTORY=before;
    await rm(root,{recursive:true,force:true});
  }
});

test('boot retains the durable rotation marker, paused journal and stopped timer on snapshot identity drift',async()=>{
  const {recoverInterruptedMaintenance,savePasswordRotationSnapshot}=await import('../deploy/updater/standalone-maintenance.mjs');
  const {initialControllerState,atomicWrite}=await import('./standalone-update-controller.mjs');
  const {createHash,randomUUID}=await import('node:crypto');
  const root=await mkdtemp(path.join(tmpdir(),'codexia-boot-rotation-'));
  const stateDir=path.join(root,'state'),oldPath=process.env.PATH,oldLock=process.env.CODEXIA_UPDATER_LOCK_DIRECTORY;
  const config={...current,publicKeyFile:path.join(root,'private','channel.pem'),stateFile:path.join(stateDir,'controller.json'),routeFile:path.join(stateDir,'route')};
  const full={...release,format:'codexia-update-release/v1',channel:'stable',state:'published',version:'1.2.3',sourceSha:'c'.repeat(40),
    platform:'linux/amd64',migrationFingerprint:'sha256:'+'a'.repeat(64),persistenceFormat:1,apiEpoch:1};
  const state=initialControllerState(full,'blue',null),password='a'.repeat(64);
  const snapshot={databaseId:'123:42',databaseQuadlet:'reviewed',operationId:randomUUID(),previousDigest:createHash('sha256').update(password).digest('hex')};
  try{
    process.env.PATH=root+path.delimiter+oldPath;process.env.CODEXIA_UPDATER_LOCK_DIRECTORY=stateDir;
    await writeFile(path.join(root,'systemctl'),'#!/bin/sh\ncase "$2" in\nstop) echo stopped > "$(dirname "$0")/timer" ;;\nis-enabled) echo disabled; exit 1 ;;\nis-active) echo inactive; exit 3 ;;\n*) exit 99 ;;\nesac\n',{mode:0o700});
    await atomicWrite(config.stateFile,JSON.stringify(state));
    await atomicWrite(config.routeFile,'blue\n');
    const marker=await savePasswordRotationSnapshot({config,state,snapshot,previousPassword:password,timer:{active:'active',enabled:'enabled'}});
    const markerPath=path.join(stateDir,'maintenance/in-progress.json');
    await atomicWrite(markerPath,JSON.stringify(marker));
    await writeFile(marker.rotation.previousPasswordFile,'b'.repeat(64));
    await assert.rejects(recoverInterruptedMaintenance({config,store:{},publicKey:''}),/rotation recovery is unverified/);
    assert.deepEqual(JSON.parse(await readFile(markerPath,'utf8')),marker);
    assert.equal(await readFile(config.routeFile,'utf8'),'blocked\n');
    assert.equal(await readFile(path.join(root,'timer'),'utf8'),'stopped\n');
    assert.equal(JSON.parse(await readFile(config.stateFile,'utf8')).paused,true);
  }finally{
    process.env.PATH=oldPath;
    if(oldLock===undefined)delete process.env.CODEXIA_UPDATER_LOCK_DIRECTORY;else process.env.CODEXIA_UPDATER_LOCK_DIRECTORY=oldLock;
    await rm(root,{recursive:true,force:true});
  }
});
