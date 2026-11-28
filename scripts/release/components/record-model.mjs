import { assertBackendImageDigest, assertReleaseRepositoryBinding, releaseRepositoryBinding } from '../../github/repository.mjs';
import assert from 'node:assert/strict';
import { assertFrontendIdentity } from '../frontend/verify-compatibility.mjs';
import { readComponentVersion } from './version.mjs';
import { validateBackendIdentity } from '../backend/update-identity.mjs';

const sha=/^[a-f0-9]{40}$/u;
const digest=/^[a-f0-9]{64}$/u;
const positive=value=>Number.isSafeInteger(value)&&value>0;

export function assertBackendPublication(publication) {
  assert.ok(publication && typeof publication === 'object' && !Array.isArray(publication), 'Backend publication proof is missing');
  assert.deepEqual(Object.keys(publication).sort(), ['event', 'verifyRunId', 'workflowHeadSha', 'workflowRunId']);
  assert.equal(publication.event, 'workflow_run');
  assert.match(publication.workflowHeadSha ?? '', sha, 'Backend publication workflow SHA is invalid');
  assert.ok(positive(publication.workflowRunId) && positive(publication.verifyRunId), 'Backend publication run identity is invalid');
  return publication;
}

export function backendPublicationFromEnvironment(env, sourceSha) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_run' || env.GITHUB_SHA === sourceSha) return undefined;
  return assertBackendPublication({
    event: 'workflow_run',
    workflowHeadSha: env.GITHUB_SHA,
    workflowRunId: Number(env.GITHUB_RUN_ID),
    verifyRunId: Number(env.CODEXIA_VERIFY_RUN_ID),
  });
}

export function publicationInWorkflowWindow(release, run) {
  const published = Date.parse(release?.published_at);
  const started = Date.parse(run?.created_at);
  const finished = Date.parse(run?.updated_at);
  return Number.isFinite(published) && Number.isFinite(started) && Number.isFinite(finished) &&
    started <= published && published <= finished;
}

/** Build immutable component-release metadata while keeping tested bytes and reviewed main source distinct. */
export function buildComponentReleaseRecord(component,sourceSha,identity,producer,mainTree,context){
  assert.ok(['frontend','backend'].includes(component),'Unknown component');
  assert.match(sourceSha??'',sha,'Component source SHA is invalid');
  const binding = releaseRepositoryBinding(context);
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
    const core=producer?.core,full=producer?.full;
    assertBackendImageDigest(core, binding.repository);assertBackendImageDigest(full, binding.repository);assert.notEqual(core,full);
    const compatibility=producer.compatibility;
    assert.ok(compatibility&&Number.isSafeInteger(compatibility.apiEpoch)&&compatibility.apiEpoch>0);
    version=readComponentVersion('backend');
    metadata={component,version,sourceSha,providedApiEpoch:compatibility.apiEpoch,persistenceFormat:compatibility.persistenceFormat,images:{core,full}};
    if(producer.event==='pull_request'){
      const receipt=producer.receipt;
      assert.ok(receipt&&typeof receipt==='object'&&!Array.isArray(receipt),'Backend promotion receipt is missing');
      assertReleaseRepositoryBinding(receipt, context);
      assert.equal(receipt.format,'codexia-backend-promotion/v1');
      assert.equal(receipt.event,'pull_request');
      assert.equal(receipt.mainSha,sourceSha,'Backend promotion main authority mismatch');
      assert.match(receipt.sourceSha??'',sha,'Backend producer source SHA is invalid');
      assert.notEqual(receipt.sourceSha,sourceSha,'Backend producer source must remain distinct from main release authority');
      assert.equal(receipt.version,readComponentVersion('backend',String(receipt.workflowRunNumber)),'Backend producer version does not match its workflow run number');
      assert.equal(receipt.sourceTree,producer.mainTree,'Backend producer tree differs from exact main tree');
      for(const key of ['workflowRunId','workflowAttempt','workflowId','prNumber','verifyRunId','proofRunId','verifyAttempt']) assert.ok(positive(receipt[key]),'Backend producer '+key+' is invalid');
      for(const key of ['planDigest']) assert.match(receipt[key]??'',digest,'Backend producer '+key+' is invalid');
      for(const key of ['sourceTree','mergeBaseSha']) assert.match(receipt[key]??'',sha,'Backend producer '+key+' is invalid');
      assert.ok(receipt.artifacts&&typeof receipt.artifacts==='object','Backend producer artifacts are missing');
      for(const profile of ['core','full']){
        const artifact=receipt.artifacts[profile];
        assert.ok(artifact&&typeof artifact==='object','Backend '+profile+' producer artifact is missing');
        assert.ok(positive(artifact.id)&&positive(artifact.producerAttempt),'Backend '+profile+' producer artifact identity is invalid');
        assert.match(artifact.digest??'',/^sha256:[a-f0-9]{64}$/u,'Backend '+profile+' producer artifact digest is invalid');
        assert.match(artifact.archiveSha256??'',digest,'Backend '+profile+' handoff archive digest is invalid');
        const identity=validateBackendIdentity(artifact.identity);
        assert.equal(identity.sourceSha,receipt.sourceSha,'Backend '+profile+' image producer SHA mismatch');
        assert.equal(identity.version,receipt.version,'Backend '+profile+' image version mismatch');
        assert.equal(identity.profile,profile,'Backend '+profile+' image profile mismatch');
        assert.equal(identity.apiEpoch,compatibility.apiEpoch,'Backend '+profile+' API epoch mismatch');
        assert.equal(identity.persistenceFormat,compatibility.persistenceFormat,'Backend '+profile+' persistence format mismatch');
      }
      assert.notEqual(receipt.artifacts.core.id,receipt.artifacts.full.id,'Backend Core and Full artifacts must be distinct');
      assert.notEqual(receipt.artifacts.core.digest,receipt.artifacts.full.digest,'Backend Core and Full artifact digests must be distinct');
      const coreIdentity=receipt.artifacts.core.identity,fullIdentity=receipt.artifacts.full.identity;
      for(const key of ['version','sourceSha','platform','migrationFingerprint','apiEpoch','persistenceFormat']) assert.equal(coreIdentity[key],fullIdentity[key],'Backend Core and Full identity mismatch: '+key);
      version=receipt.version;
      metadata.producer={event:'pull_request',sourceSha:receipt.sourceSha,version:receipt.version,workflowRunId:receipt.workflowRunId,
        workflowRunNumber:receipt.workflowRunNumber,workflowAttempt:receipt.workflowAttempt,workflowId:receipt.workflowId,prNumber:receipt.prNumber,verifyRunId:receipt.verifyRunId,
        proofRunId:receipt.proofRunId,verifyAttempt:receipt.verifyAttempt,planDigest:receipt.planDigest,sourceTree:receipt.sourceTree,
        mergeBaseSha:receipt.mergeBaseSha,artifacts:Object.fromEntries(['core','full'].map(profile=>{
          const artifact=receipt.artifacts[profile];return [profile,{id:artifact.id,digest:artifact.digest,producerAttempt:artifact.producerAttempt,archiveSha256:artifact.archiveSha256}];
        }))};
    }else if(['push','workflow_run'].includes(producer.event)&&producer.receipt){
      const receipt=producer.receipt;
      assert.ok(receipt&&typeof receipt==='object'&&!Array.isArray(receipt),'Backend build receipt is missing');
      assertReleaseRepositoryBinding(receipt, context);
      assert.equal(receipt.format,'codexia-backend-build/v1');
      assert.equal(receipt.event,producer.event);
      assert.equal(receipt.sourceSha,sourceSha,'Backend build source differs from main release authority');
      assert.equal(receipt.version,readComponentVersion('backend',String(receipt.workflowRunNumber)),'Backend build version differs from its workflow run number');
      assert.equal(receipt.sourceTree,producer.mainTree,'Backend build tree differs from exact main tree');
      assert.ok(positive(receipt.workflowRunId)&&positive(receipt.workflowRunNumber),'Backend build run identity is invalid');
      assert.match(receipt.sourceTree??'',sha,'Backend build source tree is invalid');
      assert.ok(receipt.artifacts&&typeof receipt.artifacts==='object','Backend build artifact receipt is missing');
      for(const profile of ['core','full']){
        const artifact=receipt.artifacts[profile];
        assert.ok(artifact&&typeof artifact==='object','Backend '+profile+' build artifact is missing');
        assert.ok(positive(artifact.id)&&positive(artifact.producerAttempt),'Backend '+profile+' build artifact identity is invalid');
        assert.match(artifact.digest??'',/^sha256:[a-f0-9]{64}$/u,'Backend '+profile+' build artifact digest is invalid');
        assert.match(artifact.archiveSha256??'',digest,'Backend '+profile+' build archive digest is invalid');
      }
      assert.notEqual(receipt.artifacts.core.id,receipt.artifacts.full.id,'Backend Core and Full artifacts must be distinct');
      assert.notEqual(receipt.artifacts.core.digest,receipt.artifacts.full.digest,'Backend Core and Full artifact digests must be distinct');
      version=receipt.version;
      metadata.producer={event:producer.event,sourceSha:receipt.sourceSha,version:receipt.version,workflowRunId:receipt.workflowRunId,
        workflowRunNumber:receipt.workflowRunNumber,sourceTree:receipt.sourceTree,artifacts:Object.fromEntries(['core','full'].map(profile=>{
          const artifact=receipt.artifacts[profile];return [profile,{id:artifact.id,digest:artifact.digest,producerAttempt:artifact.producerAttempt,archiveSha256:artifact.archiveSha256}];
        }))};
    }
  }
  if (component === 'backend' && producer.publication !== undefined) {
    assert.ok(['workflow_run', 'pull_request'].includes(producer.event), 'Historical backend release requires verified completion');
    metadata.publication = assertBackendPublication(producer.publication);
    assert.notEqual(metadata.publication.workflowHeadSha, sourceSha, 'Historical source has no distinct workflow HEAD');
    if (producer.event === 'workflow_run') assert.equal(metadata.producer.workflowRunId, metadata.publication.workflowRunId,
      'Backend build receipt belongs to another publication workflow');
    if (producer.event === 'pull_request') assert.equal(metadata.producer.verifyRunId, metadata.publication.verifyRunId,
      'Backend promotion receipt belongs to another Verify run');
  }
  metadata.version=version;
  Object.assign(metadata, binding);
  const tag=component+'-v'+version;
  const body='Certified component release.\n\n```json\n'+JSON.stringify(metadata,null,2)+'\n```';
  return {tag,title:component+' v'+version,targetSha:sourceSha,metadata,body};
}
