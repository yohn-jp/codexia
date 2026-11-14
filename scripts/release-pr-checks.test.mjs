import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseChecksReady } from './release-pr-checks.mjs';
const sha='a'.repeat(40);
const paths=['verify','backend-release','frontend-release','deployment-config'];
const runs=paths.map((p,i)=>({path:'.github/workflows/'+p+'.yml',id:i+1,
  head_sha:sha,head_branch:'automation/semver-release',head_repository:{full_name:'yohn-jp/codexia'},
  event:'pull_request',pull_requests:[{number:123,base:{ref:'main'},head:{sha}}],
  status:'completed',conclusion:'success'}));
test('automatic merge requires every exact release PR workflow',()=>{
  assert.equal(releaseChecksReady(runs,sha,123),true);
  assert.equal(releaseChecksReady(runs.slice(0,-1),sha,123),false);
  for(const patch of [{head_sha:'b'.repeat(40)},{event:'push'},{head_branch:'other'},
    {head_repository:{full_name:'other/codexia'}},{pull_requests:[]},{status:'in_progress',conclusion:null},{conclusion:'failure'}]){
    assert.equal(releaseChecksReady([...runs.slice(1),{...runs[0],...patch}],sha,123),false);
  }
  assert.equal(releaseChecksReady(runs,sha,124),false);
  assert.equal(releaseChecksReady([...runs,{...runs[0],id:99,status:'queued',conclusion:null}],sha,123),false);
  assert.equal(releaseChecksReady([...runs,{...runs[0],id:99,conclusion:'failure'}],sha,123),false);
});
