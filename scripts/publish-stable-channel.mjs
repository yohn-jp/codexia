import { createPrivateKey, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticateHistoricalChannel, signUpdateChannel } from './update-channel.mjs';
import { validateUpdateRelease } from './update-release-policy.mjs';
import { validateBackendIdentity, fingerprintProbe } from './backend-update-identity.mjs';

const REPO = 'yohn-jp/codexia';
const REF = 'codexia-stable-channel';
const FILE = 'stable-channel.json';
const nowIso = ms => new Date(ms).toISOString();
const cmp = (a,b) => {
  const left=a.split('.').map(Number),right=b.split('.').map(Number);
  for(let i=0;i<3;i++) if(left[i]!==right[i]) return left[i]<right[i]?-1:1;
  return 0;
};

export function nextChannel(previous, command, now) {
  if (!Number.isSafeInteger(now)) throw new Error('Invalid publisher time');
  if (command.mode === 'bootstrap') {
    if (previous !== null) throw new Error('Existing channel cannot be bootstrapped again');
  } else if (!previous) throw new Error('Channel must be explicitly bootstrapped');
  const releases = previous ? previous.releases.map(validateUpdateRelease) : [];
  if (command.mode === 'publish') {
    const candidate = validateUpdateRelease(command.release);
    if (candidate.state !== 'published') throw new Error('Only published releases may be added');
    const scoped = releases.filter(r=>r.platform===candidate.platform&&r.profile===candidate.profile);
    const sameVersion = scoped.find(r=>r.version===candidate.version);
    if (sameVersion) {
      // Main commits do not implicitly create new product releases.
      if (sameVersion.state === 'withdrawn') throw new Error('Withdrawn version cannot be republished');
      if (JSON.stringify(sameVersion) !== JSON.stringify(candidate)) return null;
      return null;
    }
    if (scoped.some(r=>cmp(candidate.version,r.version)<=0 || r.image===candidate.image || r.sourceSha===candidate.sourceSha)) throw new Error('Release version or artifact identity must advance');
    releases.push(candidate);
  } else if (command.mode === 'withdraw') {
    if (typeof command.image !== 'string') throw new Error('Withdrawal requires exact digest image');
    const matches = releases.filter(r=>r.image===command.image&&r.state==='published');
    if (matches.length === 0) throw new Error('No published release matches withdrawal');
    for (let i=0;i<releases.length;i++) if (releases[i].image===command.image) releases[i]={...releases[i],state:'withdrawn'};
  } else if (!['refresh','bootstrap'].includes(command.mode)) throw new Error('Invalid channel operation');
  if (previous && Date.parse(previous.issuedAt)>now) throw new Error('Publisher clock is behind channel');
  const sequence=(previous?.sequence ?? 0)+1;
  if (!Number.isSafeInteger(sequence)) throw new Error('Channel sequence exhausted');
  return {format:'codexia-update-channel/v1',sequence,issuedAt:nowIso(now),expiresAt:nowIso(now+12*60*60*1000),releases};
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
    redirect:'error',signal:AbortSignal.timeout(15000),
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
  const resource='contents/'+FILE;
  const old=await request(token,resource+'?ref='+REF);
  let previous=null, previousSha;
  if(old.ok){
    const entry=await old.json();
    if(entry.type!=='file'||entry.encoding!=='base64'||typeof entry.content!=='string'||typeof entry.sha!=='string'||entry.size>2*1024*1024)throw new Error('Invalid existing channel file');
    previous=authenticateHistoricalChannel(JSON.parse(Buffer.from(entry.content,'base64').toString('utf8')),pub);
    previousSha=entry.sha;
  } else if(mode!=='bootstrap') throw new Error('Stable channel file missing; refusing implicit reset');
  let command={mode};
  if(mode==='publish'){
    const image=process.env.CODEXIA_CERTIFIED_IMAGE;
    const source=process.env.GITHUB_SHA;
    if(!/^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u.test(image??'')||!source||execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==source)throw new Error('Certified immutable main image required');
    const output=(args)=>execFileSync('docker',args,{encoding:'utf8',timeout:120000,maxBuffer:1024*1024}).trim();
    output(['pull','--platform','linux/amd64',image]);
    const identity=JSON.parse(output(['run','--rm','--network','none','--read-only','--entrypoint','cat',image,'/app/update-identity.json']));
    const observedFingerprint=output(['run','--rm','--network','none','--read-only','--entrypoint','node',image,'--input-type=module','-e',fingerprintProbe]);
    if(observedFingerprint!==identity.migrationFingerprint)throw new Error('Packaged migration fingerprint mismatch');
    const observed=JSON.parse(output(['image','inspect',image]))[0];
    if(observed.Os+'/'+observed.Architecture!==identity.platform||observed.Config.Labels?.['org.opencontainers.image.revision']!==source||!observed.RepoDigests?.includes(image))throw new Error('Published digest or OCI identity mismatch');
    const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
    const compatibility=JSON.parse(readFileSync(new URL('../deploy/update-compatibility.json',import.meta.url),'utf8'));
    command={mode,release:releaseFromIdentity(identity,image,source,version,compatibility,'core')};
  } else if(mode==='withdraw') command={mode,image:process.env.CODEXIA_WITHDRAW_IMAGE};
  const now=Date.now();
  const next=nextChannel(previous,command,now);
  if(next===null){console.log('Product version already advertised; a new SemVer is required for a new stable release.');return;}
  const signed=signUpdateChannel(next,privatePem,now);
  const write=await request(token,resource,{method:'PUT',body:JSON.stringify({branch:REF,
    message:'publish signed Codexia stable channel sequence '+next.sequence,
    content:Buffer.from(JSON.stringify(signed)+'\n').toString('base64'),...(previousSha?{sha:previousSha}:{})})});
  if(!write.ok)throw new Error('Channel update failed; no fallback publication');
  console.log('Published stable channel sequence '+next.sequence);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
