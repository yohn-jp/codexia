import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { advanceJournal, loadJournal, recoveryDecision, saveJournal, validateJournal, withUpdateLock } from './update-host-state.mjs';
const image = x => 'ghcr.io/yohn-jp/codexia-backend@sha256:' + x.repeat(64);
const checkpoint = { sequence: 1, sha256: 'sha256:'+'c'.repeat(64) };
const initial = { format:'codexia-updater-journal/v1', generation:0, phase:'idle',
  active:{slot:'blue',image:image('a')},candidate:null,checkpoint:null };
const detected = () => advanceJournal(initial,{to:'detected',candidate:{slot:'green',image:image('b')},checkpoint});
test('only explicit verified and fenced transitions reach committed', () => {
  let j=detected();
  assert.equal(j.phase,'detected');
  assert.throws(()=>advanceJournal(j,{to:'pulled'}),/Forbidden/);
  j=advanceJournal(j,{to:'verified',proof:{channelVerified:true}});
  j=advanceJournal(j,{to:'pulled',proof:{artifactVerified:true}});
  j=advanceJournal(j,{to:'candidate-ready',proof:{ready:true,candidateReadOnly:true,migrationDisabled:true}});
  j=advanceJournal(j,{to:'draining',proof:{oldAdmissionClosed:true}});
  assert.throws(()=>advanceJournal(j,{to:'switched',proof:{oldWriterFenced:true,proxyOnCandidate:true}}),/Exclusive/);
  j=advanceJournal(j,{to:'switched',proof:{oldWriterFenced:true,newWriterExclusive:true,proxyOnCandidate:true}});
  j=advanceJournal(j,{to:'observing',proof:{candidateServing:true}});
  j=advanceJournal(j,{to:'committed',proof:{candidateHealthy:true,oldWriterFenced:true}});
  assert.equal(j.active.slot,'green');
  assert.equal(j.candidate,null);
  assert.equal(j.generation,8);
});
test('candidate cannot share active slot, image, or bypass checkpoint',()=>{
  for(const candidate of [{slot:'blue',image:image('b')},{slot:'green',image:image('a')}])
    assert.throws(()=>advanceJournal(initial,{to:'detected',candidate,checkpoint}));
  assert.throws(()=>advanceJournal(initial,{to:'detected',candidate:{slot:'green',image:image('b')}}));
  const current={...initial,checkpoint:{sequence:2,sha256:'sha256:'+'d'.repeat(64)}};
  assert.throws(()=>advanceJournal(current,{to:'detected',candidate:{slot:'green',image:image('b')},checkpoint}),/rollback/);
  assert.throws(()=>advanceJournal(current,{to:'detected',candidate:{slot:'green',image:image('b')},checkpoint:{sequence:2,sha256:'sha256:'+'e'.repeat(64)}}),/equivocation/);
});
test('rollback requires fenced new writer and compatible old image',()=>{
  let j=detected();
  for(const [to,proof] of [['verified',{channelVerified:true}],['pulled',{artifactVerified:true}],['candidate-ready',{ready:true,candidateReadOnly:true,migrationDisabled:true}],['draining',{oldAdmissionClosed:true}],['switched',{oldWriterFenced:true,newWriterExclusive:true,proxyOnCandidate:true}]])j=advanceJournal(j,{to,proof});
  assert.throws(()=>advanceJournal(j,{to:'rollback',proof:{proxyOnOld:true}}),/fencing/);
  j=advanceJournal(j,{to:'rollback',proof:{candidateWriterFenced:true,oldImageCompatible:true,proxyOnOld:true}});
  assert.equal(j.phase,'rollback');
  j=advanceJournal(j,{to:'idle',proof:{activeWriterExclusive:true,proxyOnActive:true}});
  assert.equal(j.active.slot,'blue');
});
test('recovery never guesses cutover from a stale journal',()=>{
  assert.equal(recoveryDecision(initial,{proxySlot:'blue',writerSlots:['blue']}),'resume-polling');
  assert.equal(recoveryDecision(initial,{proxySlot:'blue',writerSlots:['blue','green']}),'blocked');
  assert.equal(recoveryDecision(detected(),{proxySlot:'blue',writerSlots:['blue']}),'blocked');
  assert.equal(recoveryDecision(detected(),{proxySlot:'green',writerSlots:['green']}),'blocked');
});
test('atomic journal roundtrip, corrupt journal and exclusive lock',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'codexia-updater-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'state.json');
  await saveJournal(filename,detected());
  assert.deepEqual(await loadJournal(filename),detected());
  await writeFile(filename,'{invalid');
  await assert.rejects(loadJournal(filename));
  await assert.rejects(withUpdateLock(path.join(dir,'lock'),async()=>{
    await withUpdateLock(path.join(dir,'lock'),async()=>{throw Error('unreachable');});
  }));
  await withUpdateLock(path.join(dir,'lock'),async()=>assert.ok(true));
  assert.throws(()=>validateJournal({...initial,phase:'switched'}));
});
