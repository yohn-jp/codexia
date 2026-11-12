import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBackendIdentity, assertBackendIdentity } from './backend-update-identity.mjs';

const identity = {format:'codexia-backend-identity/v1', version:'0.1.0', sourceSha:'a'.repeat(40),
  profile:'core', platform:'linux/amd64', migrationFingerprint:'b'.repeat(64), apiEpoch:1, persistenceFormat:1};
const observation = {platform:identity.platform, sourceSha:identity.sourceSha,
  migrationFingerprint:identity.migrationFingerprint, api:{name:'codexia', version:'0.1.0', profile:'core', hosted:false}};
test('exact identity and runtime observation pass', () => {
  assertBackendIdentity(identity, {...identity}, observation);
});
test('invalid and unexpected identity fields fail', () => {
  for (const patch of [{version:'latest'},{sourceSha:'main'},{profile:'unknown'},{platform:'linux/arm64'},
    {migrationFingerprint:'bad'},{apiEpoch:0},{persistenceFormat:1.5},{extra:true}]) {
    assert.throws(() => validateBackendIdentity({...identity,...patch}));
  }
});
test('every expected identity field is checked', () => {
  for (const patch of [{version:'0.2.0'},{sourceSha:'c'.repeat(40)},{profile:'full'},
    {migrationFingerprint:'d'.repeat(64)},{apiEpoch:2},{persistenceFormat:2}]) {
    assert.throws(() => assertBackendIdentity(identity,{...identity,...patch},observation));
  }
});
test('runtime mismatches fail closed', () => {
  for (const patch of [{platform:'linux/arm64'},{sourceSha:'c'.repeat(40)},{migrationFingerprint:'d'.repeat(64)},
    {api:{...observation.api,profile:'full'}},{api:{...observation.api,version:'0.2.0'}},{api:{...observation.api,hosted:true}}]) {
    assert.throws(() => assertBackendIdentity(identity,identity,{...observation,...patch}));
  }
});
