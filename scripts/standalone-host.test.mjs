import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserAuthEnvironment,imageConfig,assertVersion} from '../deploy/updater/standalone-host.mjs';
const origin='https://codexia.example.invalid';
const access={mode:'cloudflare-access',issuer:'https://example.cloudflareaccess.com',audience:'a'.repeat(64),origin,ownerEmail:'owner@example.invalid'};
const release={image:'ghcr.io/yohn-jp/codexia-backend@sha256:'+'b'.repeat(64),version:'0.1.0',profile:'full'};
test('standalone writer and preflight use an explicit compatible browser auth mode',()=>{
  const env=browserAuthEnvironment({browserAuth:access},origin);
  assert.equal(env.CODEXIA_BROWSER_AUTH,'cloudflare-access');
  assert.equal(env.CODEXIA_ACCESS_AUDIENCE,access.audience);
  const quadlet=imageConfig(release,env);
  for(const [key,value] of Object.entries(env))assert.ok(quadlet.includes('Environment='+key+'='+value+'\n'));
  assert.ok(quadlet.includes('Environment=CODEXIA_PROFILE=full\n'));
  assert.ok(quadlet.includes('Environment=CODEXIA_DATABASE_MIGRATE_ON_START=0\n'));
  assert.ok(quadlet.includes('Secret=codexia-auth-token,'));
  const version={name:'codexia',version:release.version,profile:'full',hosted:false};
  assertVersion({...version,browserAuth:'cloudflare-access'},release,'cloudflare-access');
  assert.throws(()=>assertVersion(version,release,'cloudflare-access'),/mode mismatch/);
  assertVersion(version,release,'token');
  assert.deepEqual(browserAuthEnvironment({browserAuth:{mode:'token'}},origin),{CODEXIA_BROWSER_AUTH:'token'});
});
test('standalone auth rejects implicit fallback, cross-origin configuration and Quadlet injection',()=>{
  assert.throws(()=>browserAuthEnvironment({},origin),/Explicit browserAuth/);
  assert.throws(()=>browserAuthEnvironment({browserAuth:{...access,origin:'https://other.example.invalid'}},origin),/must match/);
  assert.throws(()=>browserAuthEnvironment({browserAuth:{...access,ownerEmail:'owner@example.invalid\nEnvironment=CODEXIA_HOSTED_MODE=1'}},origin));
  assert.throws(()=>browserAuthEnvironment({browserAuth:{...access,ownerEmail:'owner%h@example.invalid'}},origin));
  assert.throws(()=>browserAuthEnvironment({browserAuth:{...access,audience:'bad'}},origin));
});
