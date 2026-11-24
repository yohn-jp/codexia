import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveProducerJobAttempts, selectLatestJobArtifact } from './artifact-selection.mjs';
import { downloadArtifact } from './download-artifacts.mjs';
import { createGitHubRestClient } from '../../github/rest-client.mjs';

export function listProducerArtifacts(github,runId,artifactName) {
  return github.paginate(`/repos/yohn-jp/codexia/actions/runs/${runId}/artifacts`, { name: artifactName }, 'artifacts');
}

/** Wait only for the exact selected producer's actual terminal state.
 * GitHub has no in-job completion event for a sibling matrix runner.
 * Deadline and backoff bound metadata requests; elapsed time never proves success.
 */
export async function waitForProducerJob({read,runId,sourceSha,producerJob,expectedAttempt,timeoutMs=90_000,
  now=()=>performance.now(),pause=delay}) {
  assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>=0&&timeoutMs<=120_000,'Invalid producer wait budget');
  const start=now(),deadline=start+timeoutMs;
  let backoff=1000;
  for (;;) {
    const remainingBeforeRead=deadline-now();
    assert.ok(remainingBeforeRead>=0,'Timed out waiting for exact profile producer: '+producerJob);
    const {run,jobs}=await read(Math.max(1,remainingBeforeRead));
    assert.ok(now()<=deadline,'Timed out waiting for exact profile producer: '+producerJob);
    assert.equal(String(run.id),String(runId),'Producer run mismatch');
    assert.equal(run.head_sha,sourceSha,'Producer source mismatch');
    if(expectedAttempt!==undefined)assert.equal(run.run_attempt,expectedAttempt,'Producer run attempt changed');
    assert.ok(Array.isArray(jobs),'Invalid producer job inventory');
    const matching=jobs.filter(job=>job.name===producerJob);
    assert.ok(matching.length<=1,'Ambiguous latest producer job: '+producerJob);
    const [job]=matching;
    if(job) {
      assert.equal(String(job.run_id),String(runId),'Producer job run mismatch');
      assert.equal(job.head_sha,sourceSha,'Producer job source mismatch');
      if(job.status==='completed') {
        assert.equal(job.conclusion,'success','Profile producer failed: '+producerJob);
        return {run,jobs,waitMs:Math.round(now()-start)};
      }
      assert.ok(['queued','in_progress','waiting','pending','requested'].includes(job.status),'Unknown producer job state');
    }
    assert.notEqual(run.status,'completed','Workflow completed without successful producer: '+producerJob);
    const remaining=deadline-now();
    assert.ok(remaining>0,'Timed out waiting for exact profile producer: '+producerJob);
    await pause(Math.min(backoff,remaining));
    backoff=Math.min(backoff*2,5000);
  }
}

/** Exact-run immutable producer selection and verified download. The token is
 * confined to GitHub REST metadata and the existing authenticated redirect path. */
export async function fetchLatestProducerArtifact({plan,runId,repository,token,producerJob,artifactName,maxArchive,waitForProducerMs=0,expectedAttempt}) {
  assert.match(String(runId),/^\d+$/u);
  assert.equal(repository,'yohn-jp/codexia','Artifact producer repository mismatch');
  assert.ok(token,'Artifact read token required');
  const github=createGitHubRestClient({token});
  const request=async (endpoint,timeoutMs=15_000)=>{
    const response=await github.request('GET',`/repos/${repository}/${endpoint}`,{request:{timeout:Math.max(1,Math.min(15_000,Math.ceil(timeoutMs)))}});
    assert.ok(response.status>=200&&response.status<300,'Artifact metadata unavailable: HTTP '+response.status);return response.data;
  };
  const read=async timeoutMs=>{
    const [run,jobs]=await Promise.all([
      request('actions/runs/'+runId,timeoutMs),
      github.paginate(`/repos/${repository}/actions/runs/${runId}/jobs`,{filter:'latest'},'jobs')]);
    return {run,jobs};
  };
  const {run,jobs,waitMs}=waitForProducerMs>0
    ? await waitForProducerJob({read,runId,sourceSha:plan.sha,producerJob,expectedAttempt,timeoutMs:waitForProducerMs})
    : {...await read(15_000),waitMs:0};
  assert.equal(String(run.id),String(runId),'Producer run mismatch');
  assert.equal(run.head_sha,plan.sha,'Producer source mismatch');
  const artifacts=await listProducerArtifacts(github,runId,artifactName);
  if(waitForProducerMs>0)console.log(JSON.stringify({phase:'profile-producer-wait',producerJob,waitMs}));
  const selected=selectLatestJobArtifact(artifactName,producerJob,artifacts,jobs,{runId,sourceSha:plan.sha});
  const resolved=await resolveProducerJobAttempts(jobs,run,github,[producerJob]);
  const job=resolved.find(job=>job.name===producerJob);
  assert.ok(Number.isSafeInteger(job.run_attempt)&&job.run_attempt>0,'Invalid producer attempt');
  const bytes=await downloadArtifact(selected,repository,token,fetch,maxArchive===undefined?{}:{maxArchive});
  return {selected,job,bytes};
}
