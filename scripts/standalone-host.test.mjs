import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {browserAuthEnvironment,imageConfig,assertVersion,PodmanStandaloneHost} from '../deploy/updater/standalone-host.mjs';
const origin='https://codexia.example.invalid';
const access={mode:'cloudflare-access',issuer:'https://example.cloudflareaccess.com',audience:'a'.repeat(64),origin,ownerEmail:'owner@example.invalid'};
const release={image:'ghcr.io/yohn-jp/codexia-backend@sha256:'+'b'.repeat(64),version:'0.1.0',profile:'full',apiEpoch:1};
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
