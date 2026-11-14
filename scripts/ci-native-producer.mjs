#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planDigest,validateVerificationPlan } from './ci-impact.mjs';
import { selectLatestJobArtifact } from './ci-artifact-selection.mjs';
import { extractJsonEntry } from './download-ci-artifacts.mjs';
import { fetchLatestProducerArtifact } from './ci-producer-artifact.mjs';

const producerJob='hosted-native-catalog';
const artifactName='ci-evidence-'+producerJob;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const validDigest=value=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/u.test(value);

export function assertNativeProducerReport(report,sourceSha,dockerfileSha256){
  assert.equal(report?.schemaVersion,'codexia-hosted-native-verification/v1');
  assert.equal(report.acceptanceLevel,'DISPOSABLE_NATIVE_PRODUCER');
  assert.equal(report.selection,'catalog');
  assert.equal(report.sourceSha,sourceSha);
  assert.equal(report.dockerfileSha256,dockerfileSha256);
  assert.ok(validDigest(report.runtimeBaseDigest)&&validDigest(report.buildKitDigest),'Invalid OCI identities');
  assert.equal(report.catalog?.result,'PASS');
  assert.equal(report.catalog.producerRevision,sourceSha);
  for(const field of ['sourceDigest','recipeDigest','lockDigest']) assert.ok(validDigest(report.catalog[field]),'Invalid catalog '+field);
  assert.ok(Number.isSafeInteger(report.catalog.moduleCount)&&report.catalog.moduleCount>0,'Invalid catalog module count');
  assert.deepEqual(report.compositions,[]);
  assert.equal(report.publication,false);
  assert.equal(report.hostedRuntimeAcceptance,'NOT_CHECKED');
}
function assertCatalogExecution(report,plan){
  assert.equal(report?.group,producerJob);
  assert.equal(report.sha,plan.sha);
  assert.equal(report.planDigest,planDigest(plan));
  assert.deepEqual(report.results.map(item=>[item.task,item.status]),[[producerJob,'passed']]);
}
export function sealProducer(report,bytes,identity,plan){
  assertCatalogExecution(report,plan);
  const native=JSON.parse(bytes);
  assertNativeProducerReport(native,plan.sha,identity.dockerfileSha256);
  return {...report,nativeProducer:{identity,reportSha256:hash(bytes),runtimeBaseDigest:native.runtimeBaseDigest,buildKitDigest:native.buildKitDigest}};
}
export function validateNativeProducer(report,bytes,identity,plan){
  assertCatalogExecution(report,plan);
  const expected=sealProducer(report,bytes,identity,plan).nativeProducer;
  assert.deepEqual(report.nativeProducer,expected,'Native producer evidence mismatch');
  return expected;
}
export function assertNativeReceipt(receipt,plan,runId){
  assert.equal(receipt?.sourceSha,plan.sha);
  assert.equal(receipt.planDigest,planDigest(plan));
  assert.equal(receipt.runId,String(runId));
  assert.equal(receipt.producerJob,producerJob);
  assert.ok(Number.isSafeInteger(receipt.producerAttempt)&&receipt.producerAttempt>0);
  assert.ok(Number.isSafeInteger(receipt.artifactId)&&receipt.artifactId>0);
  assert.ok(validDigest(receipt.artifactDigest)&&validDigest(receipt.runtimeBaseDigest)&&validDigest(receipt.buildKitDigest));
  assert.match(receipt.reportSha256,/^[a-f0-9]{64}$/u);
}
export function assertNativeArtifactEvidence(plan,jobs,reports,artifacts,runId){
  if(!plan.groups.includes(producerJob)) return;
  const catalog=reports.find(report=>report.group===producerJob);
  assertCatalogExecution(catalog,plan);
  const producer=catalog.nativeProducer;
  assert.ok(producer?.identity,'Native producer seal missing');
  const artifact=selectLatestJobArtifact(artifactName,producerJob,artifacts,jobs,{runId,sourceSha:plan.sha});
  const job=jobs.find(job=>job.name===producerJob);
  assert.equal(producer.identity.sourceSha,plan.sha);
  assert.equal(producer.identity.planDigest,planDigest(plan));
  assert.equal(producer.identity.runId,String(runId));
  assert.equal(producer.identity.producerJob,producerJob);
  assert.equal(producer.identity.producerAttempt,job.run_attempt);
  assert.match(producer.reportSha256,/^[a-f0-9]{64}$/u);
  assert.ok(validDigest(producer.runtimeBaseDigest)&&validDigest(producer.buildKitDigest));
  for(const group of plan.groups.filter(group=>group.startsWith('hosted-native-')&&group!==producerJob)){
    const receipt=reports.find(report=>report.group===group)?.nativeArtifact;
    assertNativeReceipt(receipt,plan,runId);
    assert.equal(receipt.artifactId,artifact.id,'Native consumer used stale producer artifact');
    assert.equal(receipt.artifactDigest,artifact.digest,'Native artifact digest mismatch');
    assert.equal(receipt.producerAttempt,job.run_attempt,'Native producer attempt mismatch');
    for(const key of ['reportSha256','runtimeBaseDigest','buildKitDigest']) assert.equal(receipt[key],producer[key],'Native producer identity mismatch: '+key);
  }
}
async function main(){
  const [command,directory,...extra]=process.argv.slice(2);
  assert.ok(['seal','restore'].includes(command)&&directory&&extra.length===0,'Usage: ci-native-producer.mjs <seal|restore> <directory>');
  const {GITHUB_RUN_ID,GITHUB_RUN_ATTEMPT,GITHUB_REPOSITORY,GH_TOKEN,CODEXIA_CI_PLAN_PATH}=process.env;
  assert.match(GITHUB_RUN_ID??'',/^\d+$/u);assert.match(GITHUB_RUN_ATTEMPT??'',/^[1-9]\d*$/u);
  const plan=validateVerificationPlan(JSON.parse(await readFile(CODEXIA_CI_PLAN_PATH,'utf8')));
  assert.ok(plan.groups.includes(producerJob),'Native producer not selected');
  const root=fileURLToPath(new URL('../',import.meta.url));
  const git=ref=>execFileSync('git',['-c','safe.directory='+path.resolve(root),'rev-parse',ref],{cwd:root,encoding:'utf8'}).trim();
  assert.equal(git('HEAD'),plan.sha);
  const identity={sourceSha:plan.sha,sourceTree:git('HEAD^{tree}'),planDigest:planDigest(plan),runId:GITHUB_RUN_ID,producerJob,producerAttempt:Number(GITHUB_RUN_ATTEMPT),
    dockerfileSha256:hash(await readFile(path.join(root,'Dockerfile'))),lockDigest:hash(await readFile(path.join(root,'pnpm-lock.yaml'))),
    node:process.version,pnpm:execFileSync('pnpm',['--version'],{cwd:root,encoding:'utf8'}).trim(),platform:process.platform,arch:process.arch};
  assert.equal(identity.platform,'linux');assert.equal(identity.arch,'x64');
  const reportPath=path.join(directory,'report.json');
  const nativePath=path.join(directory,'native-report.json');
  if(command==='seal'){
    const sealed=sealProducer(JSON.parse(await readFile(reportPath,'utf8')),await readFile(nativePath),identity,plan);
    await writeFile(reportPath,JSON.stringify(sealed,null,2)+'\n',{mode:0o600});
    return;
  }
  const {selected,job,bytes}=await fetchLatestProducerArtifact({plan,runId:GITHUB_RUN_ID,repository:GITHUB_REPOSITORY,token:GH_TOKEN,producerJob,artifactName});
  assert.ok(job.run_attempt<=Number(GITHUB_RUN_ATTEMPT),'Invalid native producer attempt');
  identity.producerAttempt=job.run_attempt;
  const report=JSON.parse(await extractJsonEntry(bytes,'report.json'));
  const nativeBytes=await extractJsonEntry(bytes,'native-report.json');
  const sealed=validateNativeProducer(report,nativeBytes,identity,plan);
  const receipt={sourceSha:plan.sha,planDigest:identity.planDigest,runId:GITHUB_RUN_ID,producerJob,producerAttempt:identity.producerAttempt,
    artifactId:selected.id,artifactDigest:selected.digest,reportSha256:sealed.reportSha256,runtimeBaseDigest:sealed.runtimeBaseDigest,buildKitDigest:sealed.buildKitDigest};
  assertNativeReceipt(receipt,plan,GITHUB_RUN_ID);
  await mkdir(directory,{recursive:true});
  await writeFile(nativePath,nativeBytes,{flag:'wx',mode:0o600});
  await writeFile(path.join(directory,'receipt.json'),JSON.stringify(receipt),{flag:'wx',mode:0o600});
  console.log('Restored verified Hosted Native producer artifact '+selected.id);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
