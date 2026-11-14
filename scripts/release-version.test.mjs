import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRODUCT_MANIFESTS, affectsBackend, nextVersion, releasePlan, validateTransition } from './release-version.mjs';

const intentPath='.release-intents/feature-one.json';
const secondPath='.release-intents/migration.json';
const entry=(type)=>({type,summary:'Change backend behavior'});
const state=(version='0.1.0',intents={},compatibility={apiEpoch:1,persistenceFormat:1})=>({
  manifests:Object.fromEntries(PRODUCT_MANIFESTS.map(file=>[file,{name:file,version}])),intents,compatibility,
});
test('version selection obeys pre-1.0 update policy and stable SemVer',()=>{
  for (const [v,k,n] of [['0.1.0','patch','0.1.1'],['0.1.0','feature','0.1.1'],['0.1.0','breaking','0.2.0'],
    ['1.2.3','patch','1.2.4'],['1.2.3','feature','1.3.0'],['1.2.3','breaking','2.0.0']]) assert.equal(nextVersion(v,k),n);
  assert.throws(()=>nextVersion('0.1.0','unknown'));
  assert.throws(()=>nextVersion('0.01.0','patch'));
});
test('UI/docs/tests need no release; backend requires explicit new intent',()=>{
  for(const file of ['app/src/editor.ts','edge/frontend/static/_headers','docs/guide.md','packages/api/src/server.test.ts','modules/story/src/browser.ts']) assert.equal(affectsBackend(file),false,file);
  for(const file of ['packages/api/src/server.ts','modules/story/src/index.ts','profiles/full.json','Dockerfile.backend','pnpm-lock.yaml']) assert.equal(affectsBackend(file),true,file);
  assert.equal(validateTransition(state(),state(),['app/src/editor.ts']).kind,null);
  assert.throws(()=>validateTransition(state(),state(),['packages/api/src/server.ts']),/require a new/);
  assert.equal(validateTransition(state(),state('0.1.0',{[intentPath]:entry('feature')}),['packages/api/src/server.ts',intentPath]).kind,'feature');
  assert.throws(()=>validateTransition(state(),state('0.1.0',{[intentPath]:entry('patch')}),['app/src/editor.ts',intentPath]),/do not require/);
});
test('migration and compatibility epochs require breaking intent and epochs cannot go backwards',()=>{
  const base=state();
  const patch=state('0.1.0',{[intentPath]:entry('patch')});
  const breaking=state('0.1.0',{[intentPath]:entry('breaking')},{apiEpoch:2,persistenceFormat:1});
  assert.throws(()=>validateTransition(base,patch,['packages/persistence-postgres/migrations/0004.sql',intentPath]),/breaking intent/);
  assert.equal(validateTransition(base,breaking,['deploy/update-compatibility.json',intentPath]).kind,'breaking');
  assert.throws(()=>validateTransition(base,state('0.1.0',{[intentPath]:entry('feature')},{apiEpoch:2,persistenceFormat:1}),['deploy/update-compatibility.json',intentPath]),/breaking intent/);
  assert.throws(()=>validateTransition(breaking,state('0.1.0',breaking.intents),['deploy/update-compatibility.json']),/cannot decrease/);
});
test('release aggregates all pending intents, consumes them once and allows only the planned version changes',()=>{
  const base=state('0.1.0',{[intentPath]:entry('feature'),[secondPath]:entry('breaking')});
  assert.deepEqual(releasePlan(base),{kind:'breaking',version:'0.2.0',intents:[intentPath,secondPath].sort()});
  const files=[...PRODUCT_MANIFESTS,intentPath,secondPath], head=state('0.2.0');
  assert.deepEqual(validateTransition(base,head,files),{release:true,kind:'breaking',version:'0.2.0'});
  assert.equal(releasePlan(head),null);
  assert.throws(()=>validateTransition(base,state('0.1.1'),files),/does not match/);
  assert.throws(()=>validateTransition(base,head,[...files,'packages/api/src/server.ts']),/only product/);
  assert.throws(()=>validateTransition(base,head,files,{freshBase:false}),/refreshed/);
  assert.throws(()=>validateTransition(base,state('0.1.0'),[intentPath,secondPath]),/cannot be changed/);
  const modified=state('0.2.0'); modified.manifests['package.json'].name='different';
  assert.throws(()=>validateTransition(base,modified,files),/beyond version/);
  assert.throws(()=>validateTransition(state(),head,PRODUCT_MANIFESTS),/pending release intents/);
  const mismatch=state('0.2.0');mismatch.manifests['packages/api/package.json'].version='0.1.0';
  assert.throws(()=>releasePlan(mismatch),/Product version mismatch/);
});
