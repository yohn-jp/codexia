import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trimEnd();
const tracked = git('ls-files').split('\n');
const manifestPaths = tracked.filter(p => p === 'package.json' || /^(?:app|edge\/frontend|packages\/[^/]+|modules\/[^/]+|profiles\/[^/]+|tests\/e2e)\/package\.json$/.test(p));
const stable = /^\d+\.\d+\.\d+$/u;
const parts = v => v.split('.').map(Number);
const compare = (a,b) => { const x=parts(a),y=parts(b); return x[0]-y[0]||x[1]-y[1]||x[2]-y[2]; };
const highest = versions => versions.filter(v=>stable.test(v)).sort(compare).at(-1);
const readJson = p => JSON.parse(readFileSync(p,'utf8'));
const cache = new Map();
async function json(url, headers={}) {
  const r=await fetch(url,{headers,signal:AbortSignal.timeout(45000)});
  if(!r.ok)throw Error('Registry lookup failed '+r.status+' '+url);
  return r.json();
}
async function packument(name) {
  if(!cache.has(name))cache.set(name,json('https://registry.npmjs.org/'+encodeURIComponent(name),{Accept:'application/vnd.npm.install-v1+json'}));
  return cache.get(name);
}
function sameLine(version, spec) {
  const v=parts(version), b=parts(spec[2]);
  return v[0]===b[0] && ((spec[1]!=='~'&&b[0]!==0)||v[1]===b[1]);
}
function replaceTracked(old, next, filter) {
  for(const file of tracked.filter(filter)) {
    const src=readFileSync(file,'utf8');
    if(src.includes(old))writeFileSync(file,src.replaceAll(old,next));
  }
}
function imageDigest(ref) {
  const result=execFileSync('docker',['buildx','imagetools','inspect',ref],{encoding:'utf8',timeout:90000});
  const digest=result.match(/^Digest:\s+(sha256:[0-9a-f]{64})\s*$/mu)?.[1];
  assert.ok(digest,'Image manifest digest missing for '+ref);
  return digest;
}
async function npm() {
  const manifests=manifestPaths.map(path=>({path,manifest:readJson(path)}));
  const deps=new Set();
  for(const {manifest} of manifests)for(const section of ['dependencies','devDependencies','optionalDependencies'])for(const [name,spec] of Object.entries(manifest[section]??{}))if(/^([~^]?)(\d+\.\d+\.\d+)$/u.test(spec))deps.add(name);
  for(let i=0,names=[...deps];i<names.length;i+=6)await Promise.all(names.slice(i,i+6).map(packument));
  const lock=readFileSync('pnpm-lock.yaml','utf8');
  const currentPlaywright=lock.match(/^\s{2}'?@playwright\/test@(\d+\.\d+\.\d+)'?:/mu)?.[1];
  assert.ok(currentPlaywright,'Missing locked Playwright version');
  let playwrightVersion=currentPlaywright;
  for(const {path,manifest} of manifests) {
    const original=JSON.stringify(manifest);
    for(const section of ['dependencies','devDependencies','optionalDependencies']) {
      for(const [name,range] of Object.entries(manifest[section]??{})) {
        const spec=range.match(/^([~^]?)(\d+\.\d+\.\d+)$/u);
        if(!spec)continue;
        const info=await packument(name);
        const candidate=highest(Object.keys(info.versions).filter(v=>stable.test(v)&&sameLine(v,spec)&&!info.versions[v].deprecated));
        const latest=info['dist-tags']?.latest;
        console.log('DEPENDENCY_VERSION '+JSON.stringify({path,name,current:range,candidate,latest}));
        if(!candidate||compare(candidate,spec[2])<0)continue;
        if(name==='@playwright/test') {
          playwrightVersion=compare(candidate,currentPlaywright)>0?candidate:currentPlaywright;
          // The browser container version must match the resolved test package exactly.
          manifest[section][name]=playwrightVersion;
        } else manifest[section][name]=spec[1]+candidate;
      }
    }
    if(JSON.stringify(manifest)!==original)writeFileSync(path,JSON.stringify(manifest,null,2)+'\n');
  }
  if(playwrightVersion!==currentPlaywright) {
    const workflow='.github/workflows/verify.yml';
    const old=readFileSync(workflow,'utf8').match(/mcr\.microsoft\.com\/playwright@(sha256:[a-f0-9]{64})/u)?.[1];
    assert.ok(old,'Missing current browser container digest');
    // The selected release is the official Ubuntu Noble Playwright image.
    // Current CI runs Ubuntu 24.04; the complete browser matrix must prove
    // the replacement. The old digest may be a platform-specific manifest.
    const flavor='noble';
    const digest=imageDigest('mcr.microsoft.com/playwright:v'+playwrightVersion+'-'+flavor);
    replaceTracked(old,digest,p=>p===workflow||p.startsWith('scripts/')&&/\.(?:mjs|ts|sh)$/u.test(p));
    console.log('PLAYWRIGHT_IMAGE '+JSON.stringify({currentPlaywright,playwrightVersion,flavor,digest}));
  }
  // Preserve toolchain major lines and update every active exact reference
  // together; regenerate the pnpm lock with the new tool, never edit integrity.
  const activeText=p=>!p.startsWith('evidence/')&&!p.includes('dependency-refresh-candidate')&&p!=='pnpm-lock.yaml'&&!p.endsWith('package-lock.json')&&(p==='Dockerfile'||p==='Dockerfile.backend'||p==='package.json'||p.startsWith('.github/workflows/')&&p.endsWith('.yml')||p.startsWith('scripts/')&&/\.(?:mjs|ts|sh)$/u.test(p)||p.startsWith('docs/')&&p.endsWith('.md'));
  replaceTracked('12.10.1','12.21.0',activeText);
  replaceTracked('24.22.0','24.22.3',activeText);
}
async function infra() {
  const files=tracked.filter(p=>p==='Dockerfile'||p==='Dockerfile.backend'||p.startsWith('deploy/quadlet/')&&p.endsWith('.container'));
  const refs=new Map();
  for(const file of files)for(const m of readFileSync(file,'utf8').matchAll(/(docker\.io\/library\/(?:node|postgres|golang):[a-zA-Z0-9.-]+)@(sha256:[a-f0-9]{64})/gu))refs.set(m[1],m[2]);
  for(const [ref,old] of refs) {
    try { const current=imageDigest(ref); console.log('IMAGE_VERSION '+JSON.stringify({ref,old,current})); if(current!==old)replaceTracked(ref+'@'+old,ref+'@'+current,p=>files.includes(p)||p.startsWith('scripts/')&&/\.(mjs|ts|sh)$/u.test(p)); }
    catch(error){console.log('IMAGE_LOOKUP_FAILED '+ref+' '+error.message);}
  }
  const oldGo='docker.io/library/golang:1.25.5-bookworm@sha256:d9132cce84391efab786495288756d60e1da215b1f94e87860aeefc3d4c45b6d';
  const goRef='docker.io/library/golang:1.27.4-bookworm';
  const goDigest=imageDigest(goRef);
  replaceTracked(oldGo,goRef+'@'+goDigest,p=>files.includes(p)||p.startsWith('scripts/')&&/\.(?:mjs|ts|sh)$/u.test(p));
  console.log('GO_IMAGE '+JSON.stringify({ref:goRef,digest:goDigest}));
  const provider=await json('https://registry.terraform.io/v1/providers/cloudflare/cloudflare/versions');
  const tf='deploy/cloudflare/terraform/versions.tf';
  const src=readFileSync(tf,'utf8');
  const old=src.match(/version = "~> (\d+\.\d+\.\d+)"/u)?.[1];
  assert.ok(old);
  const version=highest(provider.versions.map(v=>v.version).filter(v=>stable.test(v)&&parts(v)[0]===parts(old)[0]));
  console.log('TERRAFORM_PROVIDER '+JSON.stringify({old,candidate:version,latest:highest(provider.versions.map(v=>v.version))}));
  if(version&&compare(version,old)>0)writeFileSync(tf,src.replace('version = "~> '+old+'"','version = "~> '+version+'"'));
  const node=await json('https://nodejs.org/dist/index.json');
  console.log('TOOLCHAIN_NODE '+JSON.stringify({current:'24.22.0',candidate:highest(node.map(v=>v.version.slice(1)).filter(v=>stable.test(v)&&parts(v)[0]===24))}));
  const p=await packument('pnpm');
  console.log('TOOLCHAIN_PNPM '+JSON.stringify({current:'12.10.1',candidate:highest(Object.keys(p.versions).filter(v=>stable.test(v)&&parts(v)[0]===12)),latest:p['dist-tags']?.latest}));
  const g=await json('https://go.dev/dl/?mode=json&include=all');
  console.log('TOOLCHAIN_GO '+JSON.stringify({current:'1.25.5',candidate:highest(g.map(v=>v.version.slice(2)).filter(v=>stable.test(v)&&v.startsWith('1.25.'))),latest:highest(g.map(v=>v.version.slice(2)))}));
  const ansible=await json('https://pypi.org/pypi/ansible-core/json');
  console.log('TOOLCHAIN_ANSIBLE '+JSON.stringify({current:'2.19.4',candidate:highest(Object.keys(ansible.releases).filter(v=>v.startsWith('2.19.'))),latest:ansible.info.version}));
  const tfVersions=await json('https://releases.hashicorp.com/terraform/index.json');
  console.log('TOOLCHAIN_TERRAFORM '+JSON.stringify({current:'1.17.1',candidate:highest(Object.keys(tfVersions.versions).filter(v=>v.startsWith('1.')))}));
  replaceTracked('ansible-core==2.19.4','ansible-core==2.19.15',p=>p==='.github/workflows/deployment-config.yml');
  replaceTracked('terraform_version: 1.17.1','terraform_version: 1.17.2',p=>p==='.github/workflows/deployment-config.yml');
  const actions=new Set();
  for(const file of tracked.filter(p=>p.startsWith('.github/workflows/')&&p.endsWith('.yml')))for(const m of readFileSync(file,'utf8').matchAll(/\buses:\s+([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)@(v\d+)\b/gu))actions.add(m[1]+'@'+m[2]);
  for(const action of actions) {
    const [name,current]=action.split('@');
    try {
      const tags=execFileSync('git',['ls-remote','--tags','--refs','https://github.com/'+name+'.git'],{encoding:'utf8',timeout:45000}).split('\n').map(x=>x.match(/refs\/tags\/v(\d+\.\d+\.\d+)$/u)?.[1]).filter(Boolean);
      console.log('ACTION_VERSION '+JSON.stringify({name,current,latest:highest(tags)}));
    } catch(error){console.log('ACTION_LOOKUP_FAILED '+name);}
  }
}
function emit() {
  console.log('DEPENDENCY_CANDIDATE_SOURCE '+git('rev-parse','HEAD'));
  const changed=git('diff','--name-only').split('\n').filter(Boolean);
  for(const path of changed) {
    assert.ok(tracked.includes(path),'Untracked candidate file');
    const encoded=readFileSync(path).toString('base64');
    const sha=git('hash-object',path);
    const count=Math.ceil(encoded.length/1800);
    console.log('DEPENDENCY_CANDIDATE_FILE '+path+' '+count+' '+sha);
    for(let i=0;i<count;i++)console.log('DEPENDENCY_CANDIDATE_CHUNK '+path+' '+i+' '+encoded.slice(i*1800,(i+1)*1800));
  }
  console.log('DEPENDENCY_CANDIDATE_END '+changed.length);
}
switch(process.argv[2]) {
  case 'npm': await npm(); break;
  case 'infra': await infra(); break;
  case 'emit': emit(); break;
  default: throw Error('Unsupported dependency refresh operation');
}
