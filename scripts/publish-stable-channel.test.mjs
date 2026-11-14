import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { nextChannel, releaseFromIdentity } from './publish-stable-channel.mjs';
import { signUpdateChannel, verifyUpdateChannel, authenticateHistoricalChannel } from './update-channel.mjs';
const now=Date.parse('2026-11-12T12:00:00.000Z');
const hash=c=>'sha256:'+c.repeat(64);
const image=c=>'ghcr.io/yohn-jp/codexia-backend@'+hash(c);
const release=(v,c)=>({format:'codexia-update-release/v1',channel:'stable',state:'published',version:v,sourceSha:c.repeat(40),image:image(c),platform:'linux/amd64',profile:'core',migrationFingerprint:hash('e'),persistenceFormat:1,apiEpoch:1});
test('bootstrap, monotonic publish, refresh and withdrawal preserve immutable identities',()=>{
  const zero=nextChannel(null,{mode:'bootstrap'},now);
  assert.equal(zero.sequence,1);
  assert.throws(()=>nextChannel(zero,{mode:'bootstrap'},now));
  assert.throws(()=>nextChannel(null,{mode:'publish',release:release('0.1.0','a')},now));
  const one=nextChannel(zero,{mode:'publish',release:release('0.1.0','a')},now);
  assert.equal(one.sequence,2);
  assert.equal(nextChannel(one,{mode:'publish',release:release('0.1.0','b')},now),null);
  const two=nextChannel(one,{mode:'publish',release:release('0.1.1','b')},now);
  assert.throws(()=>nextChannel(two,{mode:'publish',release:release('0.0.1','c')},now));
  const withdrawn=nextChannel(two,{mode:'withdraw',image:image('b')},now);
  assert.equal(withdrawn.releases[1].state,'withdrawn');
  assert.throws(()=>nextChannel(withdrawn,{mode:'publish',release:release('0.1.1','b')},now));
  assert.throws(()=>nextChannel(withdrawn,{mode:'publish',release:release('0.1.2','b')},now));
  assert.equal(nextChannel(withdrawn,{mode:'refresh'},now+1000).sequence,withdrawn.sequence+1);
});
test('expired historic payload is usable only by publisher, never a current host channel',()=>{
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const pub=publicKey.export({type:'spki',format:'pem'}),priv=privateKey.export({type:'pkcs8',format:'pem'});
  const state=nextChannel(null,{mode:'bootstrap'},now);
  const envelope=signUpdateChannel(state,priv,now);
  assert.throws(()=>verifyUpdateChannel(envelope,pub,null,now+13*60*60*1000),/expired/);
  assert.deepEqual(authenticateHistoricalChannel(envelope,pub),state);
  const other=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
  assert.throws(()=>authenticateHistoricalChannel(envelope,other),/signature/);
});
test('release identity must match certified source and compatibility',()=>{
  const r=release('0.1.0','a');
  const {format,channel,state,image:artifact,...fields}=r;
  const identity={format:'codexia-backend-identity/v1',...fields};
  const compatibility={apiEpoch:1,persistenceFormat:1};
  assert.deepEqual(releaseFromIdentity(identity,artifact,r.sourceSha,r.version,compatibility,'core'),r);
  assert.throws(()=>releaseFromIdentity(identity,artifact,'b'.repeat(40),r.version,compatibility,'core'));
  assert.throws(()=>releaseFromIdentity(identity,artifact,r.sourceSha,r.version,{...compatibility,apiEpoch:2},'core'));
});


test('certified Core and Full are advertised together without replacing an existing version',()=>{
  const core=release('0.1.0','a');
  const full={...core,profile:'full',image:image('b')};
  const zero=nextChannel(null,{mode:'bootstrap'},now);
  const both=nextChannel(zero,{mode:'publish',releases:[core,full]},now);
  assert.equal(both.sequence,2);
  assert.deepEqual(both.releases,[core,full]);
  assert.equal(nextChannel(both,{mode:'publish',releases:[core,full]},now),null);
  const old=nextChannel(zero,{mode:'publish',release:core},now);
  const added=nextChannel(old,{mode:'publish',releases:[core,full]},now);
  assert.deepEqual(added.releases,[core,full]);
  assert.throws(()=>nextChannel(zero,{mode:'publish',releases:[core,{...full,sourceSha:'c'.repeat(40)}]},now),/share source/);
  assert.throws(()=>nextChannel(zero,{mode:'publish',releases:[core,{...full,image:core.image}]},now),/distinct images/);
  assert.throws(()=>nextChannel(zero,{mode:'publish',releases:[core,core]},now),/Duplicate candidate profile/);
  const newer=release('0.1.1','c');
  const newerFull={...newer,profile:'full',image:image('d')};
  const next=nextChannel(both,{mode:'publish',releases:[newer,newerFull]},now);
  assert.deepEqual(next.releases,[core,full,newer,newerFull]);
  const withdrawn=nextChannel(next,{mode:'withdraw',image:newerFull.image},now);
  assert.throws(()=>nextChannel(withdrawn,{mode:'publish',releases:[newer,newerFull]},now),/Withdrawn version/);
});
