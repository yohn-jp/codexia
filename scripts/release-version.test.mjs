import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('real git source transition, generated release, stale base and backend publication gate',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'codexia-release-version-'));
  const eventPath=path.join(dir,'event.json'), outputPath=path.join(dir,'output.txt');
  const repo=path.join(dir,'repo');mkdirSync(repo);
  const script=fileURLToPath(new URL('./release-version.mjs',import.meta.url));
  const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const write=(file,value)=>{const target=path.join(repo,file);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');};
  const invoke=(command,eventName,event,extra={})=>{
    writeFileSync(eventPath,JSON.stringify(event));
    writeFileSync(outputPath,'');
    const result=execFileSync(process.execPath,[script,command],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe'],
      env:{...process.env,GITHUB_EVENT_NAME:eventName,GITHUB_EVENT_PATH:eventPath,GITHUB_OUTPUT:outputPath,...extra}});
    return {result,output:readFileSync(outputPath,'utf8')};
  };
  try {
    git('init','-q','-b','main');git('config','user.email','release-test@example.invalid');git('config','user.name','Release fixture');
    for(const [file,manifest] of Object.entries(state().manifests))write(file,manifest);
    write('deploy/update-compatibility.json',state().compatibility);
    git('add','.');git('commit','-qm','base');const before=git('rev-parse','HEAD');
    write('packages/api/src/example.ts','export const example = 1;\n');write(intentPath,entry('feature'));
    git('add','.');git('commit','-qm','feature');const source=git('rev-parse','HEAD');
    assert.deepEqual(JSON.parse(invoke('check','push',{before,after:source}).result),{release:false,kind:'feature',version:'0.1.0'});
    assert.equal(invoke('backend','push',{before,after:source},{CODEXIA_AUTO_RELEASE_ENABLED:'true'}).output,'build=false\n');
    assert.equal(invoke('backend','push',{before,after:source},{CODEXIA_AUTO_RELEASE_ENABLED:'false'}).output,'build=true\n');
    const prepared=invoke('prepare','workflow_run',{});
    assert.match(prepared.output,/release=true\nversion=0\.1\.1\nkind=feature\nsource=[a-f0-9]{40}\n/);
    for(const file of PRODUCT_MANIFESTS)assert.equal(JSON.parse(readFileSync(path.join(repo,file),'utf8')).version,'0.1.1');
    git('add','-A');git('commit','-qm','generated version');const release=git('rev-parse','HEAD');
    assert.deepEqual(JSON.parse(invoke('check','push',{before:source,after:release}).result),{release:true,kind:'feature',version:'0.1.1'});
    assert.equal(invoke('backend','push',{before:source,after:release},{CODEXIA_AUTO_RELEASE_ENABLED:'true'}).output,'build=true\n');
    assert.equal(invoke('prepare','workflow_run',{}).output,'release=false\n');
    git('checkout','-qb','new-main',source);write('app/src/editor.ts','// UI only\n');git('add','.');git('commit','-qm','new main');
    const newMain=git('rev-parse','HEAD');git('checkout','-q','--detach',release);
    const stale={pull_request:{base:{sha:newMain},head:{sha:release}}};
    assert.throws(()=>invoke('check','pull_request',stale),error=>String(error.stderr).includes('must be refreshed against current main'));
    const fresh={pull_request:{base:{sha:source},head:{sha:release}}};
    assert.equal(JSON.parse(invoke('check','pull_request',fresh).result).version,'0.1.1');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
