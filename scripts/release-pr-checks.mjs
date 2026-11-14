import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectGitHubPages } from './release-policy.mjs';

const repository='yohn-jp/codexia';
const branch='automation/semver-release';
const workflows=['.github/workflows/verify.yml','.github/workflows/backend-release.yml',
  '.github/workflows/frontend-release.yml','.github/workflows/deployment-config.yml'];
export function releaseChecksReady(runs,sha,number) {
  assert.match(sha,/^[a-f0-9]{40}$/u);
  assert.ok(Number.isSafeInteger(number)&&number>0);
  assert.ok(Array.isArray(runs));
  return workflows.every(workflow=>{
    const matching=runs.filter(run=>run.path===workflow&&run.head_sha===sha&&
      run.head_branch===branch&&run.event==='pull_request'&&run.head_repository?.full_name===repository&&
      run.pull_requests?.some(pr=>pr.number===number&&pr.base?.ref==='main'&&pr.head?.sha===sha));
    for(const run of matching)assert.ok(Number.isSafeInteger(run.id)&&run.id>0);
    const latest=matching.sort((a,b)=>b.id-a.id)[0];
    return latest?.status==='completed'&&latest.conclusion==='success';
  });
}
async function main() {
  const [sha,pr]=process.argv.slice(2),number=Number(pr);
  assert.match(sha,/^[a-f0-9]{40}$/u);assert.ok(Number.isSafeInteger(number)&&number>0);
  const token=process.env.GH_TOKEN;assert.ok(token,'Read-only Actions credential required');
  const runs=await collectGitHubPages(async(page,perPage)=>{
    const response=await fetch('https://api.github.com/repos/'+repository+'/actions/runs?head_sha='+sha+
      '&event=pull_request&per_page='+perPage+'&page='+page,{
        headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},
        redirect:'error',signal:AbortSignal.timeout(15000),
      });
    if(!response.ok)throw Error('Release PR workflow query failed: HTTP '+response.status);
    return response.json();
  },'workflow_runs');
  console.log(releaseChecksReady(runs,sha,number)?'ready':'waiting');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
