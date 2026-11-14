import assert from 'node:assert/strict';
import { collectGitHubPages } from './release-policy.mjs';
import { selectLatestJobArtifact } from './ci-artifact-selection.mjs';
import { downloadArtifact } from './download-ci-artifacts.mjs';

/** Exact-run immutable producer selection and verified download. The token is
 * confined to GitHub REST metadata and the existing authenticated redirect path. */
export async function fetchLatestProducerArtifact({plan,runId,repository,token,producerJob,artifactName,maxArchive}) {
  assert.match(String(runId),/^\d+$/u);
  assert.match(repository??'',/^[\w.-]+\/[\w.-]+$/u);
  assert.ok(token,'Artifact read token required');
  const request=async endpoint=>{
    const response=await fetch('https://api.github.com/repos/'+repository+'/'+endpoint,{
      headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.timeout(15_000)});
    assert.ok(response.ok,'Artifact metadata unavailable: HTTP '+response.status);return response.json();
  };
  const run=await request('actions/runs/'+runId);
  assert.equal(String(run.id),String(runId),'Producer run mismatch');
  assert.equal(run.head_sha,plan.sha,'Producer source mismatch');
  const [jobs,artifacts]=await Promise.all([
    collectGitHubPages(page=>request('actions/runs/'+runId+'/jobs?filter=latest&per_page=100&page='+page),'jobs'),
    collectGitHubPages(page=>request('actions/runs/'+runId+'/artifacts?per_page=100&page='+page),'artifacts')]);
  const selected=selectLatestJobArtifact(artifactName,producerJob,artifacts,jobs,{runId,sourceSha:plan.sha});
  const job=jobs.find(job=>job.name===producerJob);
  assert.ok(Number.isSafeInteger(job.run_attempt)&&job.run_attempt>0,'Invalid producer attempt');
  const bytes=await downloadArtifact(selected,repository,token,fetch,maxArchive===undefined?{}:{maxArchive});
  return {selected,job,bytes};
}
