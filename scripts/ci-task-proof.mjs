#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTaskInputFingerprint } from './ci-task-inputs.mjs';
import { assertPlanEvidence, assertSafetyTaskEvidence } from './ci-evidence.mjs';
import { assertProfileArtifactEvidence } from './ci-profile-artifact.mjs';
import { assertNativeArtifactEvidence } from './ci-native-producer.mjs';
import { resolveProducerJobAttempts, selectLatestEvidenceArtifacts, selectLatestPlanArtifact } from './ci-artifact-selection.mjs';
import { selectedArtifacts, downloadArtifact, extractJsonEntry } from './download-ci-artifacts.mjs';
import { collectGitHubPages } from './release-policy.mjs';
import { planDigest, validateVerificationPlan } from './ci-impact.mjs';
import { verifyReusableMainProof, verifyReusableMainTaskProof } from './reuse-pr-verification.mjs';

const FORMAT='codexia-safety-task-proof/v1';
const WORKFLOW='.github/workflows/verify.yml';
const positive=value=>Number.isSafeInteger(Number(value))&&Number(value)>0;
const success=value=>value?.status==='completed'&&value.conclusion==='success';
const sameRepo=(value,id)=>value?.id===id;

function assertJobBindings(jobs,run){
  assert.ok(Array.isArray(jobs)&&jobs.length>0,'Base main run has no jobs');
  for(const job of jobs){
    assert.equal(job.head_sha,run.head_sha,'Base main job source mismatch');
    assert.equal(String(job.run_id),String(run.id),'Base main job run mismatch');
    assert.ok(positive(job.run_attempt)&&job.run_attempt<=run.run_attempt,'Base main job attempt mismatch');
    assert.equal(job.status,'completed','Base main job unfinished');
  }
  const cert=jobs.filter(job=>job.name==='certification');
  assert.equal(cert.length,1,'Missing or duplicate base certification');
  assert.ok(success(cert[0]),'Base main certification failed');
  assert.equal(cert[0].run_attempt,run.run_attempt,'Base certification is not from latest attempt');
  const step=cert[0].steps?.filter(item=>item.name==='Certify every required exact-source matrix element');
  assert.equal(step?.length,1,'Missing base certification proof step');
  assert.ok(success(step[0]),'Base certification proof step failed');
}

export function assertBaseSafetyTaskEvidence(planValue,jobs,reports){
  const plan=validateVerificationPlan(planValue);
  assert.ok(plan.event==='push'||plan.event==='pull_request','Base safety proof has an unsupported event');
  assert.equal(plan.mode,'full','Base safety proof must have executed the full plan');
  assert.ok(plan.tasks.includes('safety'),'Base plan omitted safety');
  assert.ok(plan.groups.includes('types-sources'),'Base plan omitted types-sources');
  assertPlanEvidence(plan,jobs,reports);
  assertSafetyTaskEvidence(plan,reports);
  const group=reports.find(item=>item.group==='types-sources');
  const task=group?.results?.find(item=>item.task==='safety');
  assert.ok(task&&task.status==='passed','Base safety task did not pass');
  return assertTaskInputFingerprint(group.taskInputs?.safety);
}

export function selectExactMainRun(runs,{baseSha,workflowId,repositoryId}){
  assert.ok(Array.isArray(runs),'Invalid first-parent Verify run inventory');
  const matches=runs.filter(run=>run?.workflow_id===workflowId&&run.path===WORKFLOW&&run.event==='push'&&
    run.head_sha===baseSha&&run.head_branch==='main'&&sameRepo(run.repository,repositoryId)&&sameRepo(run.head_repository,repositoryId));
  assert.ok(matches.length>0,'No exact first-parent main Verify run');
  const ids=new Set(),numbers=new Set();
  for(const run of matches){
    assert.ok(positive(run.id)&&positive(run.run_number)&&positive(run.run_attempt),'Invalid exact first-parent main run identity');
    assert.ok(!ids.has(run.id)&&!numbers.has(run.run_number),'Ambiguous exact first-parent main run inventory');
    ids.add(run.id);numbers.add(run.run_number);
  }
  const run=[...matches].sort((a,b)=>b.run_number-a.run_number)[0];
  assert.ok(success(run),'Latest exact first-parent main Verify run failed or is unfinished');
  return run;
}

async function verifyBaseMainTask({baseSha,repository,repositoryId,workflowId,request,readArtifact,git}){
  const runs=await collectGitHubPages((page,perPage)=>request(`actions/workflows/${workflowId}/runs?head_sha=${baseSha}&event=push&per_page=${perPage}&page=${page}`),'workflow_runs');
  const run=selectExactMainRun(runs,{baseSha,workflowId,repositoryId});
  const jobs=await collectGitHubPages(page=>request(`actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`),'jobs');
  assertJobBindings(jobs,run);
  const artifacts=await collectGitHubPages(page=>request(`actions/runs/${run.id}/artifacts?per_page=100&page=${page}`),'artifacts');
  const identity={runId:run.id,sourceSha:baseSha};
  const inventory={identity,artifacts};
  const planArtifact=selectLatestPlanArtifact(artifacts,jobs,identity);
  const [selectedPlan]=selectedArtifacts(inventory,[planArtifact.id],identity,'plan');
  const plan=await readArtifact(selectedPlan,'ci-plan.json');
  assert.equal(plan.sha,baseSha,'First-parent plan artifact source mismatch');
  assert.equal(plan.event,'push','First-parent plan artifact event mismatch');
  let evidence=[];
  let selected=[];
  let reports=[];
  let proofReceipt;
  let proofJobs=jobs;
  let taskPlan=plan;
  const sourceGroupJob=jobs.filter(job=>job.name==='types-sources');
  assert.equal(sourceGroupJob.length,1,'Missing or duplicate first-parent types-sources job');
  if(success(sourceGroupJob[0])){
    evidence=selectLatestEvidenceArtifacts(plan,artifacts,jobs,identity);
    selected=selectedArtifacts(inventory,evidence.map(item=>item.id),identity,'evidence');
    reports=await Promise.all(selected.map(item=>readArtifact(item,'report.json')));
    assertPlanEvidence(plan,jobs,reports);
    const producerJobs=await resolveProducerJobAttempts(jobs,run,request,['build-core','build-full','hosted-native-catalog']);
    assertProfileArtifactEvidence(plan,producerJobs,reports,artifacts,run.id);
    assertNativeArtifactEvidence(plan,producerJobs,reports,artifacts,run.id);
  }else{
    assert.equal(sourceGroupJob[0].conclusion,'skipped','First-parent types-sources job neither succeeded nor had the approved compact skip');
    assert.equal(plan.mode,'full','A base run without safety evidence must have a full source plan');
    const parents=git(['rev-list','--parents','-n','1',baseSha]).trim().split(/\s+/u);
    assert.equal(parents.length,3,'Compact base source is not an exact two-parent merge');
    const sourceProof=await verifyReusableMainProof({sourceSha:baseSha,before:parents[1],repository,currentRun:run,git,request,readArtifact});
    assert.equal(sourceProof.plan.mode,'full');
    proofReceipt=sourceProof.receipt;
    proofJobs=sourceProof.jobs;
    reports=sourceProof.reports;
    taskPlan=sourceProof.plan;
    evidence=sourceProof.receipt.evidence;
    selected=sourceProof.selected;
  }
  const fingerprint=assertBaseSafetyTaskEvidence(taskPlan,proofJobs,reports);
  const selectedGroup=selected.find(item=>item.name==='ci-evidence-types-sources');
  assert.ok(selectedGroup,'Missing selected types-sources evidence artifact');
  return {run,plan,planArtifact:selectedPlan,groupArtifact:selectedGroup,fingerprint,
    planDigest:planDigest(plan),evidence:Array.isArray(evidence)?evidence.map(item=>({id:item.id,digest:item.digest})):[],proofReceipt,
    evidenceSource:proofReceipt?'verified-merged-pr-full-plan':'exact-main-full-plan'};
}

export async function resolveSafetyTaskReuse({sourceSha,before,repository,currentRun,git,request,readArtifact}){
  assert.match(sourceSha,/^[a-f0-9]{40}$/u);
  assert.match(before,/^[a-f0-9]{40}$/u);
  assert.ok(positive(currentRun?.repository?.id),'Current main repository ID is invalid');
  const candidateProof=await verifyReusableMainTaskProof({sourceSha,before,repository,currentRun,git,request,readArtifact});
  const workflow=await request('actions/workflows/verify.yml');
  assert.equal(workflow.path,WORKFLOW);
  assert.ok(positive(workflow.id),'Invalid Verify workflow identity');
  const base=await verifyBaseMainTask({baseSha:before,repository,repositoryId:currentRun.repository.id,workflowId:workflow.id,request,readArtifact,git});
  return {format:FORMAT,sourceSha,before,headSha:candidateProof.candidate.head,tree:candidateProof.candidate.tree,
    currentPrProof:candidateProof.receipt,baseRunId:base.run.id,baseRunAttempt:base.run.run_attempt,
    basePlanDigest:base.planDigest,basePlanArtifact:{id:base.planArtifact.id,digest:base.planArtifact.digest},
    baseTypesEvidence:{id:base.groupArtifact.id,digest:base.groupArtifact.digest},baseEvidence:base.evidence,
    baseEvidenceSource:base.evidenceSource,...(base.proofReceipt?{baseMergedSourceProof:base.proofReceipt}:{}),fingerprint:base.fingerprint};
}

export async function revalidateSafetyTaskProof({receipt,fingerprint,env=process.env}){
  assert.equal(env.GITHUB_EVENT_NAME,'push');
  assert.equal(env.GITHUB_REF,'refs/heads/main');
  assert.match(env.GITHUB_SHA??'',/^[a-f0-9]{40}$/u);
  assert.equal(assertTaskInputFingerprint(fingerprint).digest,assertTaskInputFingerprint(receipt?.fingerprint).digest,
    'Safety proof report fingerprint mismatch');
  const payload=JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8'));
  assert.equal(payload.ref,env.GITHUB_REF);
  assert.equal(payload.after,env.GITHUB_SHA);
  assert.equal(payload.forced,false);
  assert.equal(payload.deleted,false);
  const request=githubRequest(env.GITHUB_REPOSITORY,env.GH_TOKEN);
  const currentRun=await request('actions/runs/'+env.GITHUB_RUN_ID);
  assert.equal(String(currentRun.id),env.GITHUB_RUN_ID);
  const actual=await resolveSafetyTaskReuse({sourceSha:env.GITHUB_SHA,before:payload.before,repository:env.GITHUB_REPOSITORY,currentRun,
    git:args=>execFileSync('git',args,{encoding:'utf8',maxBuffer:16*1024*1024,timeout:15_000}),request,
    readArtifact:async(artifact,filename)=>JSON.parse(await extractJsonEntry(await downloadArtifact(artifact,env.GITHUB_REPOSITORY,env.GH_TOKEN),filename))});
  assert.deepEqual(actual,receipt,'Safety task proof changed after preselection');
  return actual;
}

function githubRequest(repository,token){
  return async endpoint=>{
    const response=await fetch(`https://api.github.com/repos/${repository}/${endpoint}`,{
      headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},
      redirect:'error',signal:AbortSignal.timeout(15_000)});
    assert.ok(response.ok,`GitHub task proof lookup failed (HTTP ${response.status})`);
    return response.json();
  };
}

async function resolveFromEnvironment(){
  const env=process.env;
  const destination=path.join(path.dirname(env.CODEXIA_CI_PLAN_PATH||'ci-plan.json'),'safety-task-proof.json');
  const unavailable=reason=>({format:FORMAT,eligible:false,reason});
  let result=unavailable('not-main-push');
  try{
    if(env.GITHUB_EVENT_NAME==='push'&&env.GITHUB_REF==='refs/heads/main'){
      const payload=JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8'));
      assert.equal(payload.ref,env.GITHUB_REF);
      assert.equal(payload.after,env.GITHUB_SHA);
      assert.equal(payload.forced,false);
      assert.equal(payload.deleted,false);
      assert.ok(env.GITHUB_REPOSITORY,'Repository name is required');
      assert.ok(env.GH_TOKEN,'Read-only GitHub token is required');
      const request=githubRequest(env.GITHUB_REPOSITORY,env.GH_TOKEN);
      const currentRun=await request('actions/runs/'+env.GITHUB_RUN_ID);
      assert.equal(String(currentRun.id),env.GITHUB_RUN_ID);
      const proof=await resolveSafetyTaskReuse({sourceSha:env.GITHUB_SHA,before:payload.before,repository:env.GITHUB_REPOSITORY,currentRun,
        git:args=>execFileSync('git',args,{encoding:'utf8',maxBuffer:16*1024*1024,timeout:15_000}),request,
        readArtifact:async(artifact,filename)=>JSON.parse(await extractJsonEntry(await downloadArtifact(artifact,env.GITHUB_REPOSITORY,env.GH_TOKEN),filename))});
      result={format:FORMAT,eligible:true,receipt:proof};
    }
  }catch(error){result=unavailable(String(error instanceof Error?error.message:'proof unavailable').replace(/[\r\n]/gu,' ').slice(0,400));}
  await mkdir(path.dirname(destination),{recursive:true});
  await writeFile(destination,JSON.stringify(result,null,2)+'\n',{mode:0o600});
  if(env.GITHUB_OUTPUT)await appendFile(env.GITHUB_OUTPUT,'safety_task_reuse='+String(result.eligible)+'\n');
  if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,(result.eligible?'Safety task reused from exact first-parent proof.':'Safety task proof unavailable; execute the canonical task: '+result.reason)+'\n');
  console.log(result.eligible?'Eligible exact first-parent safety task proof':'Safety task proof unavailable; execute safety task'+(result.reason?': '+result.reason:''));
  return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv[2],'plan');
  await resolveFromEnvironment();
}
