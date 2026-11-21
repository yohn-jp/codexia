import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORMAT='codexia-task-input-fingerprint/v1';
const SAFETY_RECIPE_FILES=[
  '.github/workflows/verify.yml','package.json','pnpm-lock.yaml','pnpm-workspace.yaml',
  'tsconfig.base.json','tsconfig.safety.json','scripts/ci-contract.mjs','scripts/ci-impact.mjs',
  'scripts/ci-group.mjs','scripts/ci-workspace.mjs','scripts/ci-evidence.mjs','scripts/certify-ci.mjs',
  'scripts/reuse-pr-verification.mjs','scripts/ci-task-inputs.mjs','scripts/ci-task-inputs.test.mjs',
  'scripts/ci-task-proof.mjs','scripts/ci-task-proof.test.mjs','scripts/ci-contract.test.mjs',
  'scripts/ci-impact.test.mjs','scripts/ci-evidence.test.mjs','scripts/reuse-pr-verification.test.mjs',
];
const hash=value=>createHash('sha256').update(value).digest('hex');

function inside(root,filename){
  const relative=path.relative(root,filename);
  return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);
}

export function buildTaskInputFingerprint({files,environment,recipe='pnpm typecheck:safety'}){
  assert.ok(Array.isArray(files)&&files.length>0,'Task fingerprint requires source inputs');
  const sorted=[...files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  assert.equal(new Set(sorted.map(item=>item.path)).size,sorted.length,'Task fingerprint contains duplicate paths');
  for(const item of sorted){
    assert.ok(typeof item.path==='string'&&item.path.length>0);
    assert.match(item.sha256??'',/^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(item.bytes)&&item.bytes>=0);
  }
  assert.ok(environment&&typeof environment==='object'&&!Array.isArray(environment));
  const payload={format:FORMAT,task:'safety',recipe,environment,files:sorted};
  return {...payload,digest:'sha256:'+hash(JSON.stringify(payload))};
}

export function assertTaskInputFingerprint(value){
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value),'Task fingerprint is missing');
  assert.equal(value.format,FORMAT);
  assert.equal(value.task,'safety');
  const {digest,...payload}=value;
  assert.match(digest??'',/^sha256:[a-f0-9]{64}$/u);
  assert.equal(digest,'sha256:'+hash(JSON.stringify(payload)),'Task fingerprint digest mismatch');
  assert.deepEqual(value,buildTaskInputFingerprint({files:value.files,environment:value.environment,recipe:value.recipe}));
  return value;
}

export function matchesSafetyTaskProof({receipt,fingerprint,sourceSha,parentSha,event,ref,mode}){
  try{
    if(event!=='push'||ref!=='refs/heads/main'||mode!=='full')return false;
    const current=assertTaskInputFingerprint(fingerprint);
    const prior=assertTaskInputFingerprint(receipt?.fingerprint);
    return receipt.format==='codexia-safety-task-proof/v1'&&receipt.sourceSha===sourceSha&&
      receipt.before===parentSha&&/^[a-f0-9]{40}$/u.test(parentSha??'')&&current.digest===prior.digest;
  }catch{return false;}
}

export async function computeSafetyTaskInputFingerprint({root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),env=process.env,
  exec=execFileSync}={}){
  root=await realpath(root);
  const compiler=path.join(root,'node_modules/typescript/bin/tsc');
  const list=exec(process.execPath,[compiler,'--listFilesOnly','--pretty','false','-p','tsconfig.safety.json'],{cwd:root,encoding:'utf8',timeout:120_000});
  const programFiles=list.split(/\r?\n/u).map(value=>value.trim()).filter(Boolean);
  assert.ok(programFiles.length>0,'TypeScript safety program has no inputs');
  const filenames=new Set(SAFETY_RECIPE_FILES);
  const manifests=exec('git',['ls-files','-z','--','package.json','**/package.json','tsconfig*.json','**/tsconfig*.json'],
    {cwd:root,encoding:'utf8',timeout:30_000});
  for(const filename of manifests.split('\0').filter(Boolean))filenames.add(filename);
  for(const value of programFiles){
    const resolved=await realpath(path.isAbsolute(value)?value:path.resolve(root,value));
    if(inside(root,resolved)) filenames.add(path.relative(root,resolved).split(path.sep).join('/'));
    else assert.ok(resolved.includes(path.sep+'node_modules'+path.sep),'TypeScript safety input escapes the workspace');
  }
  const files=[];
  for(const filename of [...filenames].sort()){
    const absolute=path.join(root,filename),stat=await lstat(absolute);
    assert.ok(stat.isFile()&&!stat.isSymbolicLink(),'Task fingerprint input must be a regular file: '+filename);
    const bytes=await readFile(absolute);
    files.push({path:filename,sha256:hash(bytes),bytes:bytes.byteLength});
  }
  const version=(command,args)=>exec(command,args,{cwd:root,encoding:'utf8',timeout:30_000}).trim();
  const environment={node:process.version,platform:process.platform,arch:process.arch,
    runnerOS:env.RUNNER_OS??null,runnerArch:env.RUNNER_ARCH??null,imageOS:env.ImageOS??null,imageVersion:env.ImageVersion??null,
    ci:env.CI??null,nodeOptions:env.NODE_OPTIONS??null,locale:env.LANG??null,timeZone:env.TZ??null,
    pnpm:version('pnpm',['--version']),typescript:version(process.execPath,[compiler,'--version'])};
  return assertTaskInputFingerprint(buildTaskInputFingerprint({files,environment}));
}
