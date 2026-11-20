import { createPrivateKey, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticateHistoricalChannel, signUpdateChannel } from './update-channel.mjs';
import { initialStableChannelRegistry, nextStableChannelRegistry, signStableChannelRegistry, verifyStableChannelRegistry } from './stable-channel-registry.mjs';
import { validateUpdateRelease } from './update-release-policy.mjs';
import { readComponentVersion } from './component-release-version.mjs';
import { validateBackendIdentity, fingerprintProbe } from './backend-update-identity.mjs';

const REPO = 'yohn-jp/codexia';
const REF = 'codexia-stable-channel';
const FILE = 'stable-channel.json';
const REGISTRY = 'stable-channel-registry.json';
const MAX_CHANNEL_BYTES = 1024 * 1024;
const nowIso = ms => new Date(ms).toISOString();
const cmp = (a,b) => {
  const left=a.split('.').map(Number),right=b.split('.').map(Number);
  for(let i=0;i<3;i++) if(left[i]!==right[i]) return left[i]<right[i]?-1:1;
  return 0;
};

function releaseScope(release) { return `${release.platform}/${release.profile}`; }
function channelPayload(sequence, releases, now) {
  return {format:'codexia-update-channel/v1',sequence,issuedAt:nowIso(now),expiresAt:nowIso(now+12*60*60*1000),releases};
}
function fitChannelReleases(sequence, releases, historicalReleases, now, protectImages = []) {
  const historyByScope = new Map();
  for (const release of historicalReleases) {
    if (release.state !== 'published') continue;
    const scope=releaseScope(release),list=historyByScope.get(scope)??[];
    list.push(release.image);historyByScope.set(scope,list);
  }
  const retained = new Set([...historyByScope.values()].flatMap(items=>items.slice(-2)));
  for(const image of protectImages)retained.add(image);
  const current = [...releases];
  const fits = () => Buffer.byteLength(JSON.stringify(channelPayload(sequence,current,now))) <= MAX_CHANNEL_BYTES && current.length <= 1000;
  while (!fits()) {
    const index=current.findIndex(release=>!retained.has(release.image));
    if (index<0) throw new Error('Stable channel cannot fit its protected rollback releases within v1 limits');
    current.splice(index,1);
  }
  return current;
}

export function nextChannelWithRegistry(previous, command, now, registry = null) {
  if (!Number.isSafeInteger(now)) throw new Error('Invalid publisher time');
  if (command.mode === 'bootstrap') {
    if (previous !== null) throw new Error('Existing channel cannot be bootstrapped again');
  } else if (!previous) throw new Error('Channel must be explicitly bootstrapped');
  const releases = previous ? previous.releases.map(validateUpdateRelease) : [];
  const history = (registry?.releases ?? releases).map(validateUpdateRelease);
  const protectImages=[];
  if (command.mode === 'publish') {
    const candidates = (command.releases ?? [command.release]).map(validateUpdateRelease);
    if (candidates.length === 0) throw new Error('No certified releases supplied');
    if (new Set(candidates.map(r=>r.platform+'/'+r.profile)).size !== candidates.length) throw new Error('Duplicate candidate profile');
    if (candidates.length > 1 && candidates.some(r=>r.sourceSha!==candidates[0].sourceSha||r.version!==candidates[0].version||r.platform!==candidates[0].platform||r.migrationFingerprint!==candidates[0].migrationFingerprint||r.apiEpoch!==candidates[0].apiEpoch||r.persistenceFormat!==candidates[0].persistenceFormat)) throw new Error('Certified profiles must share source and compatibility');
    if (new Set(candidates.map(r=>r.image)).size !== candidates.length) throw new Error('Profiles must bind distinct images');
    let added = false;
    for (const candidate of candidates) {
      if (candidate.state !== 'published') throw new Error('Only published releases may be added');
      const scoped = history.filter(r=>r.platform===candidate.platform&&r.profile===candidate.profile);
      const sameVersion = scoped.find(r=>r.version===candidate.version);
      if (sameVersion) {
        if (sameVersion.state === 'withdrawn') throw new Error('Withdrawn version cannot be republished');
        if (Object.keys(candidate).some(key=>candidate[key]!==sameVersion[key])) throw new Error('Existing backend version binds a different artifact');
        continue;
      }
      if (scoped.some(r=>cmp(candidate.version,r.version)<=0 || r.image===candidate.image || r.sourceSha===candidate.sourceSha)) throw new Error('Release version or artifact identity must advance');
      releases.push(candidate);history.push(candidate);
      added = true;
    }
    if (!added) return null;
  } else if (command.mode === 'withdraw') {
    if (typeof command.image !== 'string') throw new Error('Withdrawal requires exact digest image');
    const matches = history.filter(r=>r.image===command.image&&r.state==='published');
    if (matches.length === 0) throw new Error('No published release matches withdrawal');
    protectImages.push(command.image);
    for (let i=0;i<releases.length;i++) if (releases[i].image===command.image) releases[i]={...releases[i],state:'withdrawn'};
    for (let i=0;i<history.length;i++) if (history[i].image===command.image) history[i]={...history[i],state:'withdrawn'};
  } else if (!['refresh','bootstrap'].includes(command.mode)) throw new Error('Invalid channel operation');
  if (previous && Date.parse(previous.issuedAt)>now) throw new Error('Publisher clock is behind channel');
  const sequence=(previous?.sequence ?? 0)+1;
  if (!Number.isSafeInteger(sequence)) throw new Error('Channel sequence exhausted');
  const retained=fitChannelReleases(sequence,releases,history,now,protectImages);
  return {channel:channelPayload(sequence,retained,now),history};
}

export function nextChannel(previous, command, now, registry = null) {
  return nextChannelWithRegistry(previous,command,now,registry)?.channel ?? null;
}

export function releaseFromIdentity(identity, image, expectedSha, expectedVersion, compatibility, expectedProfile) {
  validateBackendIdentity(identity);
  if (identity.sourceSha !== expectedSha || identity.version !== expectedVersion ||
      identity.profile !== expectedProfile || identity.apiEpoch !== compatibility.apiEpoch ||
      identity.persistenceFormat !== compatibility.persistenceFormat) throw new Error('Artifact identity differs from certified source');
  const {version,sourceSha,platform,profile,migrationFingerprint,persistenceFormat,apiEpoch}=identity;
  return validateUpdateRelease({format:'codexia-update-release/v1',channel:'stable',state:'published',
    version,sourceSha,image,platform,profile,migrationFingerprint,persistenceFormat,apiEpoch});
}

async function request(token, resource, options={}) {
  const response=await fetch('https://api.github.com/repos/'+REPO+'/'+resource,{
    ...options, headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
    redirect:'error',signal:AbortSignal.timeout(30000),
  });
  if (!response.ok && response.status!==404) throw new Error('Channel repository request failed: HTTP '+response.status);
  return response;
}

async function main() {
  const mode=process.env.CODEXIA_CHANNEL_MODE;
  const token=process.env.GH_TOKEN;
  const privatePem=process.env.CODEXIA_CHANNEL_SIGNING_KEY;
  if (!token || !privatePem || process.env.GITHUB_REPOSITORY!==REPO || process.env.GITHUB_REF!=='refs/heads/main') throw new Error('Trusted main publisher environment required');
  const pub=createPublicKey(createPrivateKey(privatePem)).export({type:'spki',format:'pem'}).toString();
  const head=await request(token,'git/ref/heads/'+REF);
  if (!head.ok) throw new Error('Operator must provision dedicated stable channel branch');
  const ref=await head.json();
  if(ref.object?.type!=='commit'||typeof ref.object.sha!=='string')throw new Error('Invalid stable channel branch head');
  const commitResponse=await request(token,'git/commits/'+ref.object.sha);
  if(!commitResponse.ok)throw new Error('Stable channel branch commit is unavailable');
  const headCommit=await commitResponse.json();
  const treeResponse=await request(token,'git/trees/'+headCommit.tree.sha+'?recursive=1');
  if(!treeResponse.ok)throw new Error('Stable channel branch tree is unavailable');
  const tree=await treeResponse.json();
  if(tree.truncated)throw new Error('Stable channel branch tree is truncated; refusing incomplete history read');
  const entries=new Map((tree.tree??[]).filter(entry=>entry.type==='blob').map(entry=>[entry.path,entry]));
  const readAt=async (commitSha,file)=>{
    let commit=headCommit;
    if(commitSha!==ref.object.sha){
      const response=await request(token,'git/commits/'+commitSha);
      if(!response.ok)throw new Error('Stable channel parent commit is unavailable');
      commit=await response.json();
    }
    let listing=entries;
    if(commitSha!==ref.object.sha){
      const response=await request(token,'git/trees/'+commit.tree.sha+'?recursive=1');
      if(!response.ok)throw new Error('Stable channel parent tree is unavailable');
      const parentTree=await response.json();
      if(parentTree.truncated)throw new Error('Stable channel parent tree is truncated; refusing incomplete history read');
      listing=new Map((parentTree.tree??[]).filter(entry=>entry.type==='blob').map(entry=>[entry.path,entry]));
    }
    const entry=listing.get(file);if(!entry)return null;
    const blobResponse=await request(token,'git/blobs/'+entry.sha);
    if(!blobResponse.ok)throw new Error('Stable channel blob is unavailable: '+file);
    const blob=await blobResponse.json();
    if(blob.encoding!=='base64'||typeof blob.content!=='string'||blob.size>100*1024*1024)throw new Error('Invalid stable channel blob: '+file);
    const bytes=Buffer.from(blob.content,'base64');if(bytes.length!==blob.size)throw new Error('Truncated stable channel blob: '+file);
    return bytes;
  };
  const oldBytes=await readAt(ref.object.sha,FILE);
  let previous=null;
  if(oldBytes)previous=authenticateHistoricalChannel(JSON.parse(oldBytes.toString('utf8')),pub);
  else if(mode!=='bootstrap')throw new Error('Stable channel file missing; refusing implicit reset');
  let registry=null;
  const registryBytes=await readAt(ref.object.sha,REGISTRY);
  if(registryBytes){
    if(!oldBytes)throw new Error('Stable registry exists without its bound channel');
    registry=verifyStableChannelRegistry(JSON.parse(registryBytes.toString('utf8')),pub,oldBytes);
    if(registry.channelSequence!==previous.sequence)throw new Error('Stable registry sequence differs from channel');
  } else if(oldBytes){
    const parentSha=headCommit.parents?.[0]?.sha;
    if(parentSha){
      const parentRegistry=await readAt(parentSha,REGISTRY);
      if(parentRegistry)throw new Error('Stable channel history registry disappeared; refusing reset');
    }
    // One-time migration: the old signed channel is still the complete registry.
    registry=initialStableChannelRegistry(previous,oldBytes);
  }
  let command={mode};
  if(mode==='publish'){
    const source=process.env.CODEXIA_SOURCE_SHA || process.env.GITHUB_SHA;
    if(!source||execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==source)throw new Error('Certified immutable main source required');
    const output=(args)=>execFileSync('docker',args,{encoding:'utf8',timeout:300000,maxBuffer:1024*1024}).trim();
    const version=readComponentVersion('backend');
    const compatibility=JSON.parse(readFileSync(new URL('../deploy/update-compatibility.json',import.meta.url),'utf8'));
    const releases=[];
    for(const [profile,image] of [['core',process.env.CODEXIA_CERTIFIED_IMAGE],['full',process.env.CODEXIA_CERTIFIED_FULL_IMAGE]]){
      if(!/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u.test(image??''))throw new Error('Certified immutable '+profile+' image required');
      output(['pull','--platform','linux/amd64',image]);
      const identity=JSON.parse(output(['run','--rm','--network','none','--read-only','--entrypoint','cat',image,'/app/update-identity.json']));
      const observedFingerprint=output(['run','--rm','--network','none','--read-only','--entrypoint','node',image,'--input-type=module','-e',fingerprintProbe]);
      if(observedFingerprint!==identity.migrationFingerprint)throw new Error('Packaged migration fingerprint mismatch');
      const observed=JSON.parse(output(['image','inspect',image]))[0];
      if(observed.Os+'/'+observed.Architecture!==identity.platform||observed.Config.Labels?.['org.opencontainers.image.revision']!==source||!observed.RepoDigests?.includes(image))throw new Error('Published digest or OCI identity mismatch');
      releases.push(releaseFromIdentity(identity,image,source,version,compatibility,profile));
    }
    command={mode,releases};
  } else if(mode==='withdraw') command={mode,image:process.env.CODEXIA_WITHDRAW_IMAGE};
  const now=Date.now();
  const result=nextChannelWithRegistry(previous,command,now,registry);
  if(result===null){console.log('Backend version already recorded; no change.');return;}
  const signed=signUpdateChannel(result.channel,privatePem,now);
  const channelBytes=Buffer.from(JSON.stringify(signed)+'\n');
  const nextRegistry=nextStableChannelRegistry(registry??{releases:[]},result.channel,channelBytes,result.history);
  const signedRegistry=signStableChannelRegistry(nextRegistry,privatePem,channelBytes);
  const newTreeResponse=await request(token,'git/trees',{method:'POST',body:JSON.stringify({base_tree:headCommit.tree.sha,tree:[
    {path:FILE,mode:'100644',type:'blob',content:channelBytes.toString('utf8')},
    {path:REGISTRY,mode:'100644',type:'blob',content:JSON.stringify(signedRegistry)+'\n'},
  ]})});
  if(!newTreeResponse.ok)throw new Error('Stable channel tree creation failed');
  const newTree=await newTreeResponse.json();
  const newCommitResponse=await request(token,'git/commits',{method:'POST',body:JSON.stringify({message:'publish signed Codexia stable channel sequence '+result.channel.sequence,tree:newTree.sha,parents:[ref.object.sha]})});
  if(!newCommitResponse.ok)throw new Error('Stable channel commit creation failed');
  const newCommit=await newCommitResponse.json();
  const advance=await request(token,'git/refs/heads/'+REF,{method:'PATCH',body:JSON.stringify({sha:newCommit.sha,force:false})});
  if(!advance.ok)throw new Error('Stable channel branch advanced concurrently; retry from the new authenticated head');
  console.log('Published stable channel sequence '+result.channel.sequence+' with authenticated history');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
