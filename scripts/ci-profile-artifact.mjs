#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILES, WORKSPACES } from './ci-contract.mjs';
import { planDigest, validateVerificationPlan } from './ci-impact.mjs';
import { selectLatestJobArtifact } from './ci-artifact-selection.mjs';
import { extractJsonEntry } from './download-ci-artifacts.mjs';
import { fetchLatestProducerArtifact } from './ci-producer-artifact.mjs';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 20_000;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const safeRelative = value => typeof value === 'string' && value.length <= 1024 &&
  value.split('/').every(part => part !== '.' && part !== '..' && /^[A-Za-z0-9_.@+-]+$/u.test(part));
const profileName = value => { assert.ok(PROFILES.includes(value), 'Unknown profile'); return value; };

export function profileRoots(profile) {
  profileName(profile);
  const common = WORKSPACES.filter(({id}) => ['contracts','persistence-contracts','persistence-postgres','module-runtime','core','api','app'].includes(id));
  const extra = profile === 'full' ? WORKSPACES.filter(({id,path}) => id === 'migration' || path.startsWith('modules/')) : [];
  return [...common,...extra].map(({path}) => path + '/dist').concat('profiles/' + profile + '/generated');
}

const requiredEntries = profile => [
  'app/dist/index.html','app/dist/desktop/index.html','app/dist/mobile/index.html',
  'packages/api/dist/server.js','packages/core/dist/index.js','packages/persistence-postgres/dist/index.js',
  ...['server.mjs','browser.mjs','module-manifests.json'].map(file => 'profiles/' + profile + '/generated/' + file),
];

async function assertPlainAncestors(root, relative, { missing = false } = {}) {
  let directory = root;
  for (const segment of relative.split('/')) {
    directory = path.join(directory, segment);
    const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT' && missing) return null; throw error; });
    if (!info && missing) return;
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Unsafe directory: ' + relative);
  }
}

export async function packProfile(root, identity) {
  const files = [];
  let total = 0;
  async function visit(relative) {
    for (const item of (await readdir(path.join(root, relative), {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file = relative + '/' + item.name;
      assert.ok(safeRelative(file), 'Unsafe artifact path: ' + file);
      if (item.isDirectory()) { await visit(file); continue; }
      assert.ok(item.isFile(), 'Nonregular build output: ' + file);
      assert.ok(!/\.(node|so|dll|dylib|exe)$/iu.test(file), 'Native binary cannot be shared: ' + file);
      const info = await lstat(path.join(root,file));
      assert.ok(info.isFile() && !info.isSymbolicLink(), 'Nonregular build output: ' + file);
      assert.ok(info.size <= MAX_BYTES - total && files.length < MAX_FILES, 'Profile build exceeds bounds');
      const bytes = await readFile(path.join(root,file));
      total += bytes.length;
      files.push({path:file,size:bytes.length,sha256:sha256(bytes),data:bytes.toString('base64')});
    }
  }
  for (const dir of profileRoots(identity.profile)) {
    await assertPlainAncestors(root,dir);
    await visit(dir);
  }
  const bundle = {schemaVersion:1,identity,files};
  validateBundle(bundle,identity);
  return bundle;
}

export function validateBundle(bundle, expected) {
  assert.equal(bundle?.schemaVersion,1,'Invalid profile artifact schema');
  assert.deepEqual(bundle.identity,expected,'Profile artifact identity mismatch');
  const roots = profileRoots(expected.profile);
  assert.ok(Array.isArray(bundle.files) && bundle.files.length > 0 && bundle.files.length <= MAX_FILES,'Invalid profile file inventory');
  const seen = new Set();
  let total = 0;
  for (const file of bundle.files) {
    assert.ok(safeRelative(file.path) && roots.some(dir=>file.path.startsWith(dir+'/')), 'Unsafe profile artifact path');
    assert.ok(!/\.(node|so|dll|dylib|exe)$/iu.test(file.path), 'Native binary cannot be shared');
    assert.ok(!seen.has(file.path),'Duplicate profile artifact path');
    seen.add(file.path);
    assert.ok(Number.isSafeInteger(file.size) && file.size>=0 && file.size<=MAX_BYTES-total,'Invalid profile file size');
    assert.ok(typeof file.data==='string' && file.data.length===4*Math.ceil(file.size/3) && validHash(file.sha256),'Invalid profile file encoding');
    const bytes = Buffer.from(file.data,'base64');
    assert.equal(bytes.toString('base64'),file.data,'Invalid profile base64');
    assert.equal(bytes.length,file.size,'Profile file size mismatch');
    assert.equal(sha256(bytes),file.sha256,'Profile file digest mismatch');
    total += file.size;
  }
  for (const dir of roots) assert.ok([...seen].some(file=>file.startsWith(dir+'/')),'Missing profile output: '+dir);
  for (const file of requiredEntries(expected.profile)) assert.ok(seen.has(file),'Missing profile entry: '+file);
  // Reject a file that is also another file's directory before writing anything.
  for (const file of seen) {
    const segments=file.split('/');
    for(let i=1;i<segments.length;i++) assert.ok(!seen.has(segments.slice(0,i).join('/')),'Conflicting artifact paths');
  }
  return bundle;
}

export async function restoreProfile(root,bundle,expected) {
  validateBundle(bundle,expected);
  for (const dir of profileRoots(expected.profile)) {
    await assertPlainAncestors(root,path.posix.dirname(dir),{missing:true});
    const existing=await lstat(path.join(root,dir)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    assert.equal(existing,null,'Profile output already exists: '+dir);
  }
  for(const file of bundle.files){
    const target=path.join(root,file.path);
    await mkdir(path.dirname(target),{recursive:true});
    await writeFile(target,Buffer.from(file.data,'base64'),{flag:'wx',mode:0o644});
  }
}

export function assertBrowserReceipt(receipt,plan,profile,runId) {
  assert.equal(receipt?.profile,profileName(profile));
  assert.equal(receipt.sourceSha,plan.sha,'Browser receipt source mismatch');
  assert.equal(receipt.planDigest,planDigest(plan),'Browser receipt plan mismatch');
  assert.equal(receipt.runId,String(runId),'Browser receipt run mismatch');
  assert.ok(Number.isSafeInteger(receipt.artifactId)&&receipt.artifactId>0,'Invalid browser artifact ID');
  assert.match(receipt.artifactDigest,/^sha256:[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(receipt.producerAttempt)&&receipt.producerAttempt>0,'Invalid producer attempt');
  assert.equal(receipt.producerJob,'build-'+profile);
}

export function assertBrowserArtifactEvidence(plan,jobs,reports,artifacts,runId) {
  for(const group of plan.groups.filter(name=>name.startsWith('browser-'))){
    const profile=group.split('-')[1];
    const receipt=reports.find(report=>report.group===group)?.profileArtifact;
    assertBrowserReceipt(receipt,plan,profile,runId);
    const artifact=selectLatestJobArtifact('ci-profile-build-'+profile,'build-'+profile,artifacts,jobs,{runId,sourceSha:plan.sha});
    const job=jobs.find(job=>job.name==='build-'+profile);
    assert.equal(receipt.artifactId,artifact.id,'Browser consumed a stale producer artifact');
    assert.equal(receipt.artifactDigest,artifact.digest,'Browser artifact digest mismatch');
    assert.equal(receipt.producerAttempt,job.run_attempt,'Browser producer attempt mismatch');
  }
}

async function main(){
  const [command,profile,filename,...extra]=process.argv.slice(2);
  assert.ok(['pack','restore'].includes(command)&&filename&&extra.length===0,'Usage: ci-profile-artifact.mjs <pack|restore> <core|full> <file>');
  profileName(profile);
  const {GITHUB_RUN_ID,GITHUB_RUN_ATTEMPT,GITHUB_REPOSITORY,GH_TOKEN,CODEXIA_CI_PLAN_PATH}=process.env;
  assert.match(GITHUB_RUN_ID??'',/^\d+$/u);
  assert.match(GITHUB_RUN_ATTEMPT??'',/^[1-9]\d*$/u);
  const root=fileURLToPath(new URL('../',import.meta.url));
  const git = ref => execFileSync('git',['-c','safe.directory='+path.resolve(root),'rev-parse',ref],{cwd:root,encoding:'utf8'}).trim();
  const plan=validateVerificationPlan(JSON.parse(await readFile(CODEXIA_CI_PLAN_PATH,'utf8')));
  assert.equal(git('HEAD'),plan.sha);
  assert.ok(plan.tasks.includes('build-'+profile),'Profile build not selected');
  const identity={sourceSha:plan.sha,sourceTree:git('HEAD^{tree}'),planDigest:planDigest(plan),runId:GITHUB_RUN_ID,
    producerJob:'build-'+profile,producerAttempt:Number(GITHUB_RUN_ATTEMPT),profile,
    lockDigest:sha256(await readFile(path.join(root,'pnpm-lock.yaml'))),
    profileDigest:sha256(await readFile(path.join(root,'profiles',profile+'.json'))),
    node:process.version,pnpm:execFileSync('pnpm',['--version'],{cwd:root,encoding:'utf8'}).trim(),
    platform:process.platform,arch:process.arch};
  assert.equal(identity.platform,'linux');assert.equal(identity.arch,'x64');
  await mkdir(path.dirname(filename),{recursive:true});
  if(command==='pack'){
    const bundle=await packProfile(root,identity);
    await writeFile(filename,JSON.stringify(bundle),{flag:'wx',mode:0o600});
    console.log('Packed '+bundle.files.length+' files for '+profile);
    return;
  }
  const {selected,job,bytes}=await fetchLatestProducerArtifact({plan,runId:GITHUB_RUN_ID,repository:GITHUB_REPOSITORY,
    token:GH_TOKEN,producerJob:identity.producerJob,artifactName:'ci-profile-build-'+profile,maxArchive:MAX_BYTES});
  assert.ok(job.run_attempt<=Number(GITHUB_RUN_ATTEMPT),'Invalid producer attempt');
  identity.producerAttempt=job.run_attempt;
  const bundle=JSON.parse(await extractJsonEntry(bytes,'profile-build.json'));
  await restoreProfile(root,bundle,identity);
  const receipt={profile,sourceSha:plan.sha,planDigest:identity.planDigest,runId:GITHUB_RUN_ID,producerJob:identity.producerJob,
    producerAttempt:identity.producerAttempt,artifactId:selected.id,artifactDigest:selected.digest};
  assertBrowserReceipt(receipt,plan,profile,GITHUB_RUN_ID);
  await writeFile(filename,JSON.stringify(receipt),{flag:'wx',mode:0o600});
  console.log('Restored '+bundle.files.length+' files from exact artifact '+selected.id+' for '+profile);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
