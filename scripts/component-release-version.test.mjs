import assert from 'node:assert/strict';
import {test} from 'node:test';
import {componentVersion} from './component-release-version.mjs';
import {assertFrontendCompatibility} from './verify-frontend-compatibility.mjs';
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
  const api={name:'codexia',version:'0.8.2',hosted:false,profile:'full',apiEpoch:1};
  assert.doesNotThrow(()=>assertFrontendCompatibility(ui,api));
  for(const changed of [{apiEpoch:2},{apiEpoch:undefined},{profile:'core'},{hosted:true},{version:'latest'}]){
    assert.throws(()=>assertFrontendCompatibility(ui,{...api,...changed}));
  }
});
