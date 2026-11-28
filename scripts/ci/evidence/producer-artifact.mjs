import { actionsRepository, assertArtifactRunRepository, matchesRunRepository } from '../../github/repository.mjs';
import assert from 'node:assert/strict';
import { resolveProducerJobAttempts, selectLatestJobArtifact } from './artifact-selection.mjs';
import { normalizeVerificationJobs } from './job-name.mjs';
import { downloadArtifact } from './download-artifacts.mjs';
import { createGitHubOctokit } from '../../github/octokit.mjs';
import { paginateActionsInventory } from '../../github/paginate-actions.mjs';

export function listProducerArtifacts(github,runId,artifactName,{owner,repo}) {
  return paginateActionsInventory(github, github.rest.actions.listWorkflowRunArtifacts,
    { owner, repo, run_id: runId, name: artifactName }, 'artifacts');
}

export function assertProducerRunIdentity(run,{runId,sourceSha,expectedRunAttempt}) {
  assert.equal(String(run.id),String(runId),'Producer run mismatch');
  assert.equal(run.head_sha,sourceSha,'Producer source mismatch');
  assert.equal(run.run_attempt,expectedRunAttempt,'Producer workflow run attempt mismatch');
}

/** Exact-run immutable producer selection and verified download. The token is
 * confined to GitHub REST metadata and the existing authenticated redirect path. */
export async function fetchLatestProducerArtifact({plan,runId,repository,token,producerJob,artifactName,maxArchive,expectedRunAttempt}) {
  assert.match(String(runId),/^\d+$/u);
  const context = actionsRepository();
  assert.equal(repository, context.repository, 'Artifact producer repository mismatch');
  assert.ok(token,'Artifact read token required');
  const github=createGitHubOctokit({token});
  const { owner, repo } = context;
  const [{ data: run }, rawJobs, artifacts] = await Promise.all([
    github.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(runId) }),
    paginateActionsInventory(github, github.rest.actions.listJobsForWorkflowRun,
      { owner, repo, run_id: Number(runId), filter: 'latest' }, 'jobs'),
    listProducerArtifacts(github,runId,artifactName,{owner,repo}),
  ]);
  assert.ok(matchesRunRepository(run, context, { sameHead: plan.event !== 'pull_request' }), 'Artifact producer repository mismatch');
  assert.equal(run.event, plan.event, 'Artifact producer event mismatch');
  assert.equal(run.path, '.github/workflows/verify.yml', 'Artifact producer workflow mismatch');
  assertProducerRunIdentity(run,{runId,sourceSha:plan.sha,expectedRunAttempt});
  const jobs=normalizeVerificationJobs(rawJobs);
  const selected=selectLatestJobArtifact(artifactName,producerJob,artifacts,jobs,{runId,sourceSha:plan.sha});
  const resolved=await resolveProducerJobAttempts(jobs,run,
    (producerRunId,attempt)=>paginateActionsInventory(github,github.rest.actions.listJobsForWorkflowRunAttempt,
      {owner,repo,run_id:producerRunId,attempt_number:attempt},'jobs'),[producerJob]);
  const job=resolved.find(job=>job.name===producerJob);
  assert.ok(Number.isSafeInteger(job.run_attempt)&&job.run_attempt>0,'Invalid producer attempt');
  assertArtifactRunRepository(selected, run);
  const bytes=await downloadArtifact(selected,repository,token,fetch,maxArchive===undefined?{}:{maxArchive});
  return {selected,job,bytes};
}
