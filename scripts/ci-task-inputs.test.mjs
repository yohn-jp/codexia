import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertTaskInputFingerprint, buildTaskInputFingerprint, matchesSafetyTaskProof } from './ci-task-inputs.mjs';

const item=(path,value)=>({path,sha256:value.repeat(64),bytes:1});
const fixture=overrides=>buildTaskInputFingerprint({files:[item('b.ts','b'),item('a.ts','a')],environment:{node:'v24.22.3',runner:'ubuntu-24.04'},...overrides});

test('safety task fingerprint covers ordered source closure, environment and recipe deterministically',()=>{
  const first=fixture(),second=fixture({files:[item('a.ts','a'),item('b.ts','b')]});
  assert.deepEqual(first,second);
  assert.deepEqual(first.files.map(file=>file.path),['a.ts','b.ts']);
  assert.equal(assertTaskInputFingerprint(first).digest,first.digest);
  assert.notEqual(first.digest,fixture({files:[item('a.ts','c'),item('b.ts','b')]}).digest);
  assert.notEqual(first.digest,fixture({environment:{node:'v24.22.4',runner:'ubuntu-24.04'}}).digest);
  assert.notEqual(first.digest,fixture({recipe:'pnpm typecheck:safety --strict'}).digest);
});

test('task fingerprints reject altered checksums, duplicate paths and malformed manifests',()=>{
  const proof=fixture();
  assert.throws(()=>assertTaskInputFingerprint({...proof,digest:'sha256:'+'f'.repeat(64)}),/digest mismatch/);
  assert.throws(()=>buildTaskInputFingerprint({files:[item('same.ts','a'),item('same.ts','b')],environment:{}}),/duplicate/);
  assert.throws(()=>buildTaskInputFingerprint({files:[{path:'a.ts',sha256:'bad',bytes:1}],environment:{}}),/64/);
});

test('safety proof reuse requires exact main source, first parent, full plan and equal input closure',()=>{
  const fingerprint=fixture();
  const receipt={format:'codexia-safety-task-proof/v1',sourceSha:'a'.repeat(40),before:'b'.repeat(40),fingerprint};
  const context={receipt,fingerprint,sourceSha:receipt.sourceSha,parentSha:receipt.before,event:'push',ref:'refs/heads/main',mode:'full'};
  assert.equal(matchesSafetyTaskProof(context),true);
  for(const mismatch of [
    {sourceSha:'c'.repeat(40)},{parentSha:'d'.repeat(40)},{event:'pull_request'},
    {ref:'refs/heads/feature'},{mode:'affected'},{fingerprint:fixture({recipe:'pnpm typecheck:safety --strict'})},
    {receipt:{...receipt,fingerprint:{...fingerprint,digest:'sha256:'+'0'.repeat(64)}}},{fingerprint:undefined},
  ]) assert.equal(matchesSafetyTaskProof({...context,...mismatch}),false);
});
