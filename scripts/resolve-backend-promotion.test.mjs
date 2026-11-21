import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBackendPromotionVersion, selectBackendPromotionRun } from './resolve-backend-promotion.mjs';

const sha='a'.repeat(40), branch='feature/backend-change';
const proof={headSha:sha,headRef:branch,prNumber:23,mergedAt:'2026-11-19T12:00:00Z'};
const repository={id:9};
function run(patch={}) { return {id:12,run_number:88,run_attempt:2,workflow_id:31,path:'.github/workflows/backend-release.yml',
  event:'pull_request',head_sha:sha,head_branch:branch,status:'completed',conclusion:'success',updated_at:'2026-11-19T11:00:00Z',
  repository,head_repository:repository,...patch}; }

test('backend producer selection uses the latest successful same-repository attempt completed before merge',()=>{
  const selected=selectBackendPromotionRun([run({id:10,run_number:86}),run()],proof,9,31);
  assert.equal(selected.id,12);
  for(const patch of [
    {event:'push'}, {head_branch:'other'}, {head_repository:{id:10}}, {status:'in_progress'},
    {conclusion:'failure'}, {updated_at:'2026-11-19T13:00:00Z'},
  ]) assert.throws(()=>selectBackendPromotionRun([run(patch)],proof,9,31));
  assert.throws(()=>selectBackendPromotionRun([run()],proof,9,32),/No same-repository/);
  assert.throws(()=>selectBackendPromotionRun([run(),run({id:13})],proof,9,31),/Ambiguous/);
});

test('backend PR promotion requires a strict SemVer advance over published backend releases',()=>{
  assert.ok(assertBackendPromotionVersion('0.1.90','0.1.89'));
  assert.ok(assertBackendPromotionVersion('1.0.0','0.99.99'));
  assert.ok(assertBackendPromotionVersion('0.1.0',null));
  for(const version of ['0.1.89','0.1.88','latest','01.2.3']) assert.throws(()=>assertBackendPromotionVersion(version,'0.1.89'));
});
