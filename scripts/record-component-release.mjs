import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readComponentVersion } from './component-release-version.mjs';

const digest=/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u;
const repo='yohn-jp/codexia';
const component=process.argv[2];
assert.ok(['frontend','backend'].includes(component));
const sha=process.env.GITHUB_SHA;
assert.match(sha,/^[a-f0-9]{40}$/u);
assert.equal(process.env.GITHUB_REPOSITORY,repo);
assert.equal(process.env.GITHUB_REF,'refs/heads/main');
assert.equal(process.env.GITHUB_EVENT_NAME,'push');
const token=process.env.GH_TOKEN;assert.ok(token);
const version=readComponentVersion(component);
const tag=component+'-v'+version;
const title=component+' v'+version;
let metadata={component,version,sourceSha:sha};
if(component==='frontend'){
  const identity=JSON.parse(readFileSync(new URL('../app/dist/desktop/update-identity.json',import.meta.url),'utf8'));
  assert.equal(identity.version,version);assert.equal(identity.sourceSha,sha);
  metadata={...metadata,profile:identity.profile,requiredApiEpoch:identity.apiEpoch,worker:'codexia-frontend'};
}else{
  const core=process.env.CODEXIA_CERTIFIED_IMAGE,full=process.env.CODEXIA_CERTIFIED_FULL_IMAGE;
  assert.match(core,digest);assert.match(full,digest);assert.notEqual(core,full);
  const compatibility=JSON.parse(readFileSync(new URL('../deploy/update-compatibility.json',import.meta.url),'utf8'));
  metadata={...metadata,providedApiEpoch:compatibility.apiEpoch,persistenceFormat:compatibility.persistenceFormat,images:{core,full}};
}
const body='Certified component release.\n\n'+String.fromCharCode(96,96,96)+'json\n'+JSON.stringify(metadata,null,2)+'\n'+String.fromCharCode(96,96,96);
async function api(resource,method='GET',data){
  const response=await fetch('https://api.github.com/repos/'+repo+'/'+resource,{
    method,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
    ...(data?{body:JSON.stringify(data)}:{}),redirect:'error',signal:AbortSignal.timeout(20000),
  });
  if(response.status===404&&method==='GET')return null;
  if(!response.ok)throw Error('Component release API request failed: HTTP '+response.status);
  return response.json();
}
const resource='git/ref/tags/'+tag;
let ref=await api(resource);
if(!ref){
  await api('git/refs','POST',{ref:'refs/tags/'+tag,sha});
  ref=await api(resource);
}
assert.equal(ref?.object?.type,'commit');assert.equal(ref.object.sha,sha,'Component version already belongs to a different source');
const existing=await api('releases/tags/'+tag);
if(existing){
  assert.equal(existing.tag_name,tag);assert.equal(existing.body,body,'Existing component release binds different metadata');
  assert.equal(existing.draft,false);
}else{
  await api('releases','POST',{tag_name:tag,target_commitish:sha,name:title,body,draft:false,prerelease:false,make_latest:'false'});
}
console.log('Recorded '+title+' from '+sha);
