import assert from 'node:assert/strict';
import { assertFrontendIdentity } from './verify-frontend-compatibility.mjs';
import { readComponentVersion } from './component-release-version.mjs';

const sha=/^[a-f0-9]{40}$/u;
const digest=/^[a-f0-9]{64}$/u;
const positive=value=>Number.isSafeInteger(value)&&value>0;

/** Build immutable component-release metadata while keeping tested bytes and reviewed main source distinct. */
export function buildComponentReleaseRecord(component,sourceSha,identity,producer,mainTree){
  assert.ok(['frontend','backend'].includes(component),'Unknown component');
  assert.match(sourceSha??'',sha,'Component source SHA is invalid');
  let version,metadata;
  if(component==='frontend'){
    assertFrontendIdentity(identity);
    assert.equal(identity.profile,'full','Released frontend must be the Full profile');
    assert.ok(producer&&typeof producer==='object'&&!Array.isArray(producer),'Frontend producer receipt is missing');
    assert.ok(['push','workflow_run','pull_request'].includes(producer.event),'Unsupported frontend producer event');
    assert.match(producer.sourceSha??'',sha,'Frontend producer source SHA is invalid');
    assert.equal(identity.sourceSha,producer.sourceSha,'Frontend producer source does not match embedded asset identity');
    assert.equal(identity.version,producer.version,'Frontend producer version does not match embedded asset identity');
    assert.equal(identity.profile,producer.profile,'Frontend producer profile does not match embedded asset identity');
    assert.equal(identity.apiEpoch,producer.apiEpoch,'Frontend producer API epoch does not match embedded asset identity');
    assert.ok(positive(producer.workflowRunId)&&positive(producer.workflowAttempt),'Frontend producer run identity is invalid');
    assert.ok(positive(producer.artifactId),'Frontend producer artifact ID is invalid');
    assert.match(producer.artifactDigest??'',digest,'Frontend producer artifact digest is invalid');
    if(producer.event==='pull_request'){
      assert.notEqual(producer.sourceSha,sourceSha,'Promoted PR identity must remain distinct from the main merge source');
      assert.ok(positive(producer.prNumber)&&positive(producer.workflowId)&&positive(producer.verifyRunId)&&positive(producer.proofRunId)&&positive(producer.verifyAttempt),
        'Frontend promotion proof identity is invalid');
      assert.match(producer.planDigest??'',digest,'Frontend promotion plan digest is invalid');
      assert.match(producer.sourceTree??'',sha,'Frontend producer tree is invalid');
      assert.match(producer.mergeBaseSha??'',sha,'Frontend merge base is invalid');
      assert.equal(producer.sourceTree,mainTree,'Frontend producer tree differs from main source tree');
    }else{
      assert.equal(producer.sourceSha,sourceSha,'Main frontend producer source mismatch');
    }
    version=identity.version;
    metadata={component,version,sourceSha,profile:identity.profile,requiredApiEpoch:identity.apiEpoch,worker:'codexia-frontend',
      ...(producer.event==='pull_request'?{producer:{event:producer.event,sourceSha:producer.sourceSha,version:producer.version,workflowRunId:producer.workflowRunId,
        workflowAttempt:producer.workflowAttempt,artifactId:producer.artifactId,artifactDigest:'sha256:'+producer.artifactDigest,
        profile:producer.profile,apiEpoch:producer.apiEpoch,prNumber:producer.prNumber,workflowId:producer.workflowId,verifyRunId:producer.verifyRunId,
        proofRunId:producer.proofRunId,verifyAttempt:producer.verifyAttempt,planDigest:producer.planDigest,sourceTree:producer.sourceTree,
        mergeBaseSha:producer.mergeBaseSha}}:{})};
  }else{
    version=readComponentVersion('backend');
    const digestPattern=/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u;
    const core=producer?.core,full=producer?.full;
    assert.match(core??'',digestPattern);assert.match(full??'',digestPattern);assert.notEqual(core,full);
    const compatibility=producer.compatibility;
    assert.ok(compatibility&&Number.isSafeInteger(compatibility.apiEpoch)&&compatibility.apiEpoch>0);
    metadata={component,version,sourceSha,providedApiEpoch:compatibility.apiEpoch,persistenceFormat:compatibility.persistenceFormat,images:{core,full}};
  }
  const tag=component+'-v'+version;
  const body='Certified component release.\n\n```json\n'+JSON.stringify(metadata,null,2)+'\n```';
  return {tag,title:component+' v'+version,targetSha:sourceSha,metadata,body};
}
