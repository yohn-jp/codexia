import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compareComponentVersions, componentVersion} from './version.mjs';
import {
  assertFrontendCompatibility,
  assertFrontendReleaseAdmission,
  readFrontendReleaseConfiguration,
  verifyFrontendCompatibility,
} from '../frontend/verify-compatibility.mjs';
test('independent stable release lines use monotonically increasing workflow patches',()=>{
  assert.equal(componentVersion('0.1.0','42'),'0.1.42');
  assert.equal(componentVersion('0.2.0','43'),'0.2.43');
  assert.equal(componentVersion('1.2.3','9'),'1.2.12');
  assert.equal(componentVersion('0.1.0',''),'0.1.0');
  for(const n of ['0','01','-1','1.2','9007199254740992']) assert.throws(()=>componentVersion('0.1.0',n));
  assert.throws(()=>componentVersion('0.01.0','1'));
});
test('frontend and backend releases are independent, but profile and API epoch must match',()=>{
  const ui={format:'codexia-frontend-identity/v1',version:'0.4.8',sourceSha:'a'.repeat(40),profile:'full',apiEpoch:1};
  const api={name:'codexia',version:'0.8.2',auth:['oauth-owner','oauth-mcp'],profile:'full',apiEpoch:1};
  assert.doesNotThrow(()=>assertFrontendCompatibility(ui,api));
  for(const changed of [{apiEpoch:2},{apiEpoch:undefined},{profile:'core'},{auth:['oauth-owner']},{version:'latest'}]){
    assert.throws(()=>assertFrontendCompatibility(ui,{...api,...changed}));
  }
});

test('frontend release order rejects stale versions and preserves same-version immutability',()=>{
  const current={format:'codexia-frontend-identity/v1',version:'0.4.9',sourceSha:'a'.repeat(40),profile:'full',apiEpoch:1};
  const newer={...current,version:'0.4.10',sourceSha:'b'.repeat(40)};
  assert.equal(compareComponentVersions('0.4.10','0.4.9'),1);
  assert.equal(compareComponentVersions('0.4.9','0.4.10'),-1);
  assert.equal(compareComponentVersions('0.4.9','0.4.9'),0);
  assert.equal(assertFrontendReleaseAdmission(current,newer),true);
  assert.throws(()=>assertFrontendReleaseAdmission(current,{...current,version:'0.4.8'}),/older than deployed frontend/);
  assert.equal(assertFrontendReleaseAdmission(current,{...current}),false);
  assert.throws(()=>assertFrontendReleaseAdmission(current,{...current,sourceSha:'c'.repeat(40)}),/immutable and belongs to a different source/);
  assert.throws(()=>assertFrontendReleaseAdmission(current,{...current,apiEpoch:2}),/immutable and has a different API epoch/);
});

const candidate={format:'codexia-frontend-identity/v1',version:'0.4.10',sourceSha:'b'.repeat(40),profile:'full',apiEpoch:1};
const liveBackend={name:'codexia',version:'0.8.2',auth:['oauth-owner','oauth-mcp'],profile:'full',apiEpoch:1};
const liveFrontend={format:'codexia-frontend-identity/v1',version:'0.4.9',sourceSha:'a'.repeat(40),profile:'full',apiEpoch:1};
const releaseEnv={GITHUB_SHA:candidate.sourceSha,CODEXIA_PUBLIC_ORIGIN:'https://codexia.example.com',CODEXIA_ACCESS_CLIENT_ID:'client-id',CODEXIA_ACCESS_CLIENT_SECRET:'client-secret'};
const jsonResponse=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});

test('frontend live gate admits a newer artifact only after protected API compatibility succeeds',async()=>{
  const calls=[];
  const result=await verifyFrontendCompatibility({frontend:candidate,env:releaseEnv,fetchImpl:async(url,options)=>{
    calls.push([String(url),options.headers]);
    return jsonResponse(String(url).endsWith('/api/version')?liveBackend:liveFrontend);
  }});
  assert.equal(result.deploy,true);
  assert.deepEqual(result.backend,liveBackend);
  assert.deepEqual(calls.map(([url])=>new URL(url).pathname).sort(),['/api/version','/desktop/update-identity.json']);
  assert.ok(calls.every(([,headers])=>headers['CF-Access-Client-Id']==='client-id'&&headers['CF-Access-Client-Secret']==='client-secret'));
});

test('same-version frontend retry observes the deployed identity without allowing replacement',async()=>{
  const retry={...candidate};
  const result=await verifyFrontendCompatibility({frontend:retry,env:releaseEnv,fetchImpl:async url=>
    jsonResponse(String(url).endsWith('/api/version')?liveBackend:retry)});
  assert.equal(result.deploy,false);
});

test('frontend live gate reports missing origin and Access credentials without guessing values',()=>{
  assert.throws(()=>readFrontendReleaseConfiguration({...releaseEnv,CODEXIA_PUBLIC_ORIGIN:''}),/CODEXIA_PUBLIC_ORIGIN must be configured/);
  assert.throws(()=>readFrontendReleaseConfiguration({...releaseEnv,CODEXIA_PUBLIC_ORIGIN:'https://codexia.example.com/app'}),/without a path/);
  assert.throws(()=>readFrontendReleaseConfiguration({...releaseEnv,CODEXIA_ACCESS_CLIENT_ID:''}),/CODEXIA_ACCESS_CLIENT_ID and CODEXIA_ACCESS_CLIENT_SECRET/);
  assert.throws(()=>readFrontendReleaseConfiguration({...releaseEnv,CODEXIA_ACCESS_CLIENT_SECRET:undefined}),/CODEXIA_ACCESS_CLIENT_ID and CODEXIA_ACCESS_CLIENT_SECRET/);
});

test('frontend live gate rejects wrong source, incompatible profile or epoch, and unavailable identity',async()=>{
  await assert.rejects(verifyFrontendCompatibility({frontend:candidate,env:{...releaseEnv,GITHUB_SHA:'c'.repeat(40)},fetchImpl:async()=>jsonResponse(liveBackend)}),/artifact source mismatch/);
  await assert.rejects(verifyFrontendCompatibility({frontend:candidate,env:releaseEnv,fetchImpl:async url=>
    jsonResponse(String(url).endsWith('/api/version')?{...liveBackend,apiEpoch:2}:liveFrontend)}),/API epochs are incompatible/);
  await assert.rejects(verifyFrontendCompatibility({frontend:candidate,env:releaseEnv,fetchImpl:async url=>
    jsonResponse(String(url).endsWith('/api/version')?{...liveBackend,profile:'core'}:liveFrontend)}),/Backend profile mismatch/);
  await assert.rejects(verifyFrontendCompatibility({frontend:candidate,env:releaseEnv,fetchImpl:async()=>new Response('unavailable',{status:503})}),/IDENTITY_UNAVAILABLE: \/api\/version \(HTTP 503\)[\s\S]*IDENTITY_UNAVAILABLE: \/desktop\/update-identity\.json \(HTTP 503\)/);
});

test('frontend live gate diagnoses Access rejection without exposing service credentials',async()=>{
  const secret='do-not-print-this-access-secret';
  await assert.rejects(verifyFrontendCompatibility({frontend:candidate,env:{...releaseEnv,CODEXIA_ACCESS_CLIENT_SECRET:secret},fetchImpl:async()=>new Response('',{status:403})}),error=>{
    assert.match(error.message,/ACCESS_DENIED: \/api\/version \(HTTP 403\)/);
    assert.match(error.message,/ACCESS_DENIED: \/desktop\/update-identity\.json \(HTTP 403\)/);
    assert.match(error.message,/CI token pair, exact-path Service Auth policy and Tunnel AUD/);
    assert.equal(error.message.includes(releaseEnv.CODEXIA_ACCESS_CLIENT_ID),false);
    assert.equal(error.message.includes(secret),false);
    return true;
  });
});
