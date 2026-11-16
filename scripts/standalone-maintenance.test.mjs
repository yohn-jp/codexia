import assert from 'node:assert/strict';
import test from 'node:test';
import {assertNoDropInPaths,assertProxyImageStable,timerActivationCommand,validateMaintenanceConfig} from '../deploy/updater/standalone-maintenance.mjs';
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

test('maintenance preserves enabled state and immutable release, auth, and runtime inputs',()=>{
  const candidate={...current,enabled:false,observeMilliseconds:600000};
  assert.deepEqual(validateMaintenanceConfig(current,candidate),{...candidate,enabled:true});
  for(const patch of [
    {runtime:{...runtime,profile:'full',modelCachePath:'/var/cache/codexia/models'}},
    {browserAuth:{mode:'cloudflare-access',issuer:'https://example.cloudflareaccess.com',audience:'a'.repeat(64),origin:'https://codexia.example.invalid',ownerEmail:'owner@example.invalid'}},
    {publicKeyFile:'/home/codexia/other-key.pem'},
    {frontendIdentityUrl:'https://other.example.invalid/desktop/update-identity.json'},
    {initialSlot:'green'},
    {observeMilliseconds:1000},
    {observeMilliseconds:4000000},
  ])assert.throws(()=>validateMaintenanceConfig(current,{...candidate,...patch}));
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

test('maintenance requires the running proxy image to match its digest-pinned Quadlet',()=>{
  const digest='a'.repeat(64);
  const quadlet=`[Container]\nImage=ghcr.io/yohn-jp/codexia-backend@sha256:${digest}\n`;
  const imageInfo={Id:'sha256:'+'c'.repeat(64),RepoDigests:[`ghcr.io/yohn-jp/codexia-backend@sha256:${digest}`]};
  assertProxyRuntimeObservation(quadlet,{State:{Running:true},Image:`sha256:${'c'.repeat(64)}`,ImageName:`ghcr.io/yohn-jp/codexia-backend@sha256:${digest}`},'active',imageInfo);
  assert.throws(()=>assertProxyRuntimeObservation(quadlet,{State:{Running:true},Image:`sha256:${'d'.repeat(64)}`,ImageName:`ghcr.io/yohn-jp/codexia-backend@sha256:${digest}`},'active',imageInfo),/different image content/u);
  assert.throws(()=>assertProxyRuntimeObservation(quadlet,{State:{Running:false},Image:`sha256:${'c'.repeat(64)}`,ImageName:`ghcr.io/yohn-jp/codexia-backend@sha256:${digest}`},'active',imageInfo),/not running/u);
});
