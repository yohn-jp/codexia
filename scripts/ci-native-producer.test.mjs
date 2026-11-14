import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createVerificationPlan,planDigest} from './ci-impact.mjs';
import {assertNativeArtifactEvidence,sealProducer,validateNativeProducer} from './ci-native-producer.mjs';
const sha='a'.repeat(40),runId='123',jobName='hosted-native-catalog';
const digest=n=>'sha256:'+String(n).repeat(64);
const plan=createVerificationPlan({files:null,event:'push',sha});
const identity={sourceSha:sha,sourceTree:'b'.repeat(40),planDigest:planDigest(plan),runId,producerJob:jobName,producerAttempt:1,dockerfileSha256:'c'.repeat(64),lockDigest:'d'.repeat(64),node:'v24.22.0',pnpm:'12.10.1',platform:'linux',arch:'x64'};
const native={schemaVersion:'codexia-hosted-native-verification/v1',acceptanceLevel:'DISPOSABLE_NATIVE_PRODUCER',selection:'catalog',sourceSha:sha,dockerfileSha256:identity.dockerfileSha256,runtimeBaseDigest:digest(1),buildKitDigest:digest(2),catalog:{result:'PASS',producerRevision:sha,sourceDigest:digest(3),recipeDigest:digest(4),lockDigest:digest(5),moduleCount:9},compositions:[],publication:false,hostedRuntimeAcceptance:'NOT_CHECKED'};
const bytes=Buffer.from(JSON.stringify(native));
const execution={group:jobName,sha,planDigest:planDigest(plan),results:[{task:jobName,status:'passed'}]};
const artifact={id:12,name:'ci-evidence-'+jobName,created_at:'2026-01-01T00:01:00Z',expired:false,digest:digest(6),workflow_run:{id:123,head_sha:sha}};
const job={name:jobName,head_sha:sha,run_id:123,run_attempt:1,status:'completed',conclusion:'success',started_at:'2026-01-01T00:00:00Z',completed_at:'2026-01-01T00:02:00Z'};
test('native producer evidence binds an actual successful catalog report to exact source and toolchain',()=>{
  const sealed=sealProducer(execution,bytes,identity,plan);
  assert.deepEqual(validateNativeProducer(sealed,bytes,identity,plan),sealed.nativeProducer);
  assert.throws(()=>validateNativeProducer(sealed,bytes,{...identity,producerAttempt:2},plan),/evidence mismatch/);
  assert.throws(()=>validateNativeProducer(sealed,Buffer.from(JSON.stringify({...native,buildKitDigest:digest(7)})),identity,plan),/evidence mismatch/);
  for(const update of [{selection:'core'},{sourceSha:'e'.repeat(40)},{publication:true},{runtimeBaseDigest:'bad'},{dockerfileSha256:'bad'}]){
    assert.throws(()=>sealProducer(execution,Buffer.from(JSON.stringify({...native,...update})),identity,plan));
  }
  assert.throws(()=>sealProducer({...execution,results:[{task:jobName,status:'blocked'}]},bytes,identity,plan));
});
test('certification requires every native composition to consume the latest sealed producer',()=>{
  const sealed=sealProducer(execution,bytes,identity,plan);
  const {reportSha256,runtimeBaseDigest,buildKitDigest}=sealed.nativeProducer;
  const receipt={sourceSha:sha,planDigest:planDigest(plan),runId,producerJob:jobName,producerAttempt:1,artifactId:12,artifactDigest:artifact.digest,reportSha256,runtimeBaseDigest,buildKitDigest};
  const reports=[sealed,...['core','selected','full'].map(selection=>({group:'hosted-native-'+selection,nativeArtifact:{...receipt}}))];
  assert.doesNotThrow(()=>assertNativeArtifactEvidence(plan,[job],reports,[artifact],runId));
  assert.throws(()=>assertNativeArtifactEvidence(plan,[job],reports.slice(0,-1),[artifact],runId));
  assert.throws(()=>assertNativeArtifactEvidence(plan,[{...job,conclusion:'failure'}],reports,[artifact],runId));
  assert.throws(()=>assertNativeArtifactEvidence(plan,[job],reports,[{...artifact,id:13}],runId),/stale/);
  assert.throws(()=>assertNativeArtifactEvidence(plan,[{...job,run_attempt:2}],reports,[artifact],runId));
  const bad=structuredClone(reports);bad[1].nativeArtifact.buildKitDigest=digest(7);
  assert.throws(()=>assertNativeArtifactEvidence(plan,[job],bad,[artifact],runId),/identity mismatch/);
});
