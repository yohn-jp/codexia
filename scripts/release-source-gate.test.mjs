import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifiedReleaseEvent } from './release-source-gate.mjs';

const sha='a'.repeat(40);
const run={id:123,path:'.github/workflows/verify.yml',event:'push',head_branch:'main',
  head_sha:sha,status:'completed',conclusion:'success',
  repository:{full_name:'yohn-jp/codexia'},head_repository:{full_name:'yohn-jp/codexia'}};
const env={GITHUB_EVENT_NAME:'workflow_run',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'yohn-jp/codexia',
  CODEXIA_SOURCE_SHA:sha,CODEXIA_VERIFY_RUN_ID:'123'};

test('only exact successful main Verify completion can authorize a privileged release',()=>{
  assert.equal(verifiedReleaseEvent({workflow_run:run},env,sha),run);
  for(const altered of [
    {event:'pull_request'}, {head_branch:'feature'}, {path:'.github/workflows/other.yml'},
    {head_sha:'b'.repeat(40)}, {status:'in_progress',conclusion:null},
    {conclusion:'failure'}, {repository:{full_name:'attacker/codexia'}},
    {head_repository:{full_name:'attacker/codexia'}}, {id:124},
  ]) assert.throws(()=>verifiedReleaseEvent({workflow_run:{...run,...altered}},env,sha));
  assert.throws(()=>verifiedReleaseEvent({workflow_run:run},{...env,GITHUB_REF:'refs/pull/123/merge'},sha));
  assert.throws(()=>verifiedReleaseEvent({workflow_run:run},env,'b'.repeat(40)));
});
