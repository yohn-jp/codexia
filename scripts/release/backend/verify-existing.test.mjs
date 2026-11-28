import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildComponentReleaseRecord } from '../components/record-model.mjs';
import { assertExistingBackendReleaseBinding, backendReleaseSourceTree, publishedBackendCompatibility,
  successfulPublicationJobs, verifyExistingBackendRelease } from './verify-existing.mjs';
import { readComponentVersion } from '../components/version.mjs';

const sha=char=>char.repeat(40),image=char=>'ghcr.io/yohn-jp/codexia-backend@sha256:'+char.repeat(64);
const compatibility={apiEpoch:1,persistenceFormat:1};
const context = { repository: 'yohn-jp/codexia', repositoryId: 100, ownerId: 50 };
const buildRecord = (component, source, identity, producer, tree) =>
  buildComponentReleaseRecord(component, source, identity, producer, tree, context);
const assertReleaseBinding = (release, tagRef, expected) =>
  assertExistingBackendReleaseBinding(release, tagRef, expected, context);


test('resolves the published Git tree and API epoch after a newer checkout', async t => {
  const repository = await mkdtemp(path.join(tmpdir(), 'codexia-release-tree-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release-test@example.invalid');
  await mkdir(path.join(repository, 'deploy'));
  const file = path.join(repository, 'deploy/update-compatibility.json');
  await writeFile(file, '{"apiEpoch":1,"persistenceFormat":1}\n');
  git('add', 'deploy/update-compatibility.json');
  const certifiedTree = git('write-tree');
  git('commit', '-qm', 'Certified source');
  const certifiedSha = git('rev-parse', 'HEAD');
  await writeFile(file, '{"apiEpoch":2,"persistenceFormat":1}\n');
  git('add', 'deploy/update-compatibility.json');
  assert.notEqual(git('write-tree'), certifiedTree);
  git('commit', '-qm', 'Newer source');

  const module = new URL('./verify-existing.mjs', import.meta.url);
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { backendReleaseSourceTree, publishedBackendCompatibility } from ${JSON.stringify(module.href)};
    console.log(JSON.stringify({ tree: backendReleaseSourceTree(process.argv[1]), compatibility: publishedBackendCompatibility(process.argv[1]) }));
  `, certifiedSha], { cwd: repository, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(result), { tree: certifiedTree, compatibility: { apiEpoch: 1, persistenceFormat: 1 } });
  assert.throws(() => backendReleaseSourceTree('HEAD'), /source SHA is invalid/u);
});

function promotedFixture(){
  const mainSha=sha('a'),sourceSha=sha('b'),tree=sha('c'),version=readComponentVersion('backend','450');
  const identity=profile=>({format:'codexia-backend-identity/v1',version,sourceSha,profile,platform:'linux/amd64',
    migrationFingerprint:'sha256:'+'d'.repeat(64),apiEpoch:1,persistenceFormat:1});
  const receipt={...context,format:'codexia-backend-promotion/v1',event:'pull_request',sourceSha,version,workflowRunId:451,workflowRunNumber:450,
    workflowAttempt:2,workflowId:31,prNumber:8,verifyRunId:452,proofRunId:453,verifyAttempt:1,planDigest:'e'.repeat(64),sourceTree:tree,
    mergeBaseSha:sha('f'),mainSha,artifacts:{core:{id:454,digest:'sha256:'+'1'.repeat(64),producerAttempt:2,archiveSha256:'2'.repeat(64),identity:identity('core')},
      full:{id:455,digest:'sha256:'+'3'.repeat(64),producerAttempt:2,archiveSha256:'4'.repeat(64),identity:identity('full')}}};
  const record=buildRecord('backend',mainSha,null,{core:image('5'),full:image('6'),compatibility,event:'pull_request',receipt,mainTree:tree});
  return {mainSha,sourceSha,version,receipt,record,release:{tag_name:record.tag,draft:false,prerelease:false,body:record.body},tagRef:{object:{type:'commit',sha:mainSha}}};
}

test('immutable digest retry requires a prior release with the exact producer receipt and main tag',()=>{
  const fixture=promotedFixture();
  const expected={image:fixture.record.metadata.images.core,mainSha:fixture.mainSha,producerSha:fixture.sourceSha,version:fixture.version,
    profile:'core',event:'pull_request',receipt:fixture.receipt,mainTree:fixture.receipt.sourceTree,compatibility};
  assert.deepEqual(assertReleaseBinding(fixture.release,fixture.tagRef,expected),fixture.record.metadata);
  const changed=JSON.parse(fixture.release.body.match(/```json\s*\n([\s\S]*?)\n```/u)[1]);
  changed.producer.artifacts.core.id+=100;
  const forged={...fixture.release,body:'Certified component release.\n\n```json\n'+JSON.stringify(changed)+'\n```'};
  assert.throws(()=>assertReleaseBinding(forged,fixture.tagRef,expected),/exact promoted producer receipt/);
  assert.throws(()=>assertReleaseBinding(fixture.release,{object:{type:'commit',sha:sha('9')}},expected),/main source mismatch/);
  assert.throws(()=>assertReleaseBinding(fixture.release,fixture.tagRef,{...expected,image:image('8')}),/immutable registry digest/);
});

test('main fallback digest retry requires the exact build artifact receipt',()=>{
  const mainSha=sha('a'),tree=sha('b'),version=readComponentVersion('backend','450');
  const receipt={...context,format:'codexia-backend-build/v1',event:'push',sourceSha:mainSha,version,workflowRunId:451,workflowRunNumber:450,
    sourceTree:tree,artifacts:{core:{id:452,digest:'sha256:'+'1'.repeat(64),producerAttempt:2,archiveSha256:'2'.repeat(64)},
      full:{id:453,digest:'sha256:'+'3'.repeat(64),producerAttempt:2,archiveSha256:'4'.repeat(64)}}};
  const core=image('5'),full=image('6');
  const record=buildRecord('backend',mainSha,null,{core,full,compatibility,event:'push',receipt,mainTree:tree});
  const release={tag_name:record.tag,draft:false,prerelease:false,body:record.body},tagRef={object:{type:'commit',sha:mainSha}};
  const expected={image:core,mainSha,producerSha:mainSha,version,profile:'core',event:'push',receipt,mainTree:tree,compatibility};
  assert.deepEqual(assertReleaseBinding(release,tagRef,expected),record.metadata);
  assert.throws(() => assertReleaseBinding(release, tagRef, { ...expected, compatibility: { apiEpoch: 2, persistenceFormat: 1 } }),
    /does not bind this exact main build receipt/u);
  const completedReceipt={...receipt,event:'workflow_run'};
  const completedRecord=buildRecord('backend',mainSha,null,{core,full,compatibility,event:'workflow_run',receipt:completedReceipt,mainTree:tree});
  const completedRelease={...release,body:completedRecord.body};
  assert.deepEqual(assertReleaseBinding(completedRelease,tagRef,{...expected,event:'workflow_run',receipt:completedReceipt}),completedRecord.metadata);
  const changed=structuredClone(receipt);changed.artifacts.core.digest='sha256:'+'7'.repeat(64);
  assert.throws(()=>assertReleaseBinding(release,tagRef,{...expected,receipt:changed}),/exact main build receipt/);
  assert.throws(()=>assertReleaseBinding(release,tagRef,{...expected,mainTree:sha('9')}),/tree differs/);
});

test('verifies a backend release when the tag prefix matches more than one REST page', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codexia-release-read-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const sourceTree = backendReleaseSourceTree(sourceSha);
  const version = readComponentVersion('backend', '450');
  const receipt = {
    ...context, format: 'codexia-backend-build/v1', event: 'workflow_run', sourceSha, sourceTree, version,
    workflowRunId: 451, workflowRunNumber: 450,
    artifacts: {
      core: { id: 452, digest: 'sha256:' + '1'.repeat(64), producerAttempt: 1, archiveSha256: '2'.repeat(64) },
      full: { id: 453, digest: 'sha256:' + '3'.repeat(64), producerAttempt: 1, archiveSha256: '4'.repeat(64) },
    },
  };
  const record = buildRecord('backend', sourceSha, null, {
    core: image('5'), full: image('6'), compatibility: publishedBackendCompatibility(sourceSha),
    event: 'workflow_run', receipt, mainTree: sourceTree,
  });
  const manifest = path.join(dir, 'build.json');
  await writeFile(manifest, JSON.stringify(receipt));
  const release = { tag_name: record.tag, draft: false, prerelease: false, body: record.body, published_at: '2026-01-01T00:01:00Z' };
  const tag = { ref: 'refs/tags/' + record.tag, object: { type: 'commit', sha: sourceSha } };
  const otherTags = Array.from({ length: 104 }, (_, index) => ({ ref: 'refs/tags/backend-v0.0.' + index, object: tag.object }));
  const jobs = ['Resolve verified backend promotion', 'Build and test backend OCI image (core)',
    'Build and test backend OCI image (full)', 'Publish immutable GHCR image'].map(name => ({
    name, run_id: 451, run_attempt: 1, head_sha: sourceSha, status: 'completed', conclusion: 'success',
  }));
  t.mock.method(globalThis, 'fetch', async input => {
    const endpoint = decodeURIComponent(new URL(input).pathname).replace('/repos/yohn-jp/codexia/', '');
    switch (endpoint) {
      case 'releases': return Response.json([release]);
      case 'git/matching-refs/tags/backend-v': return Response.json([...otherTags, tag]);
      case 'releases/tags/' + record.tag: return Response.json(release);
      case 'git/ref/tags/' + record.tag: return Response.json(tag);
      case 'actions/workflows/backend-release.yml/runs': return Response.json({ total_count: 1, workflow_runs: [{
        id: 451, run_number: 450, run_attempt: 1,
        repository: { full_name: context.repository, id: context.repositoryId, owner: { id: context.ownerId } },
        head_repository: { full_name: context.repository, id: context.repositoryId, owner: { id: context.ownerId } },
        path: '.github/workflows/backend-release.yml', event: 'workflow_run',
        head_branch: 'main', head_sha: sourceSha, status: 'completed', conclusion: 'success',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:02:00Z',
      }] });
      case 'actions/runs/451/jobs': return Response.json({ total_count: jobs.length, jobs });
      default: assert.fail('Unexpected GitHub API path: ' + endpoint);
    }
  });

  const verified = await verifyExistingBackendRelease({
    env: { GITHUB_REPOSITORY: context.repository, GITHUB_REPOSITORY_ID: String(context.repositoryId), GITHUB_REPOSITORY_OWNER_ID: String(context.ownerId), GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_run',
      GITHUB_SHA: sourceSha, GITHUB_RUN_ID: '451', GITHUB_RUN_NUMBER: '450', CODEXIA_BACKEND_ARTIFACT_MANIFEST: manifest,
      GH_TOKEN: 'fixture' },
    args: [image('6'), sourceSha, sourceSha, version, 'full', 'workflow_run'],
    usePublishedSourceCompatibility: true,
  });
  assert.equal(verified.publicationRunId, 451);
  assert.equal(verified.metadata.images.full, image('6'));
});

test('existing digest requires successful prior main publication jobs for its path',()=>{
  const main=[
    {name:'Resolve verified backend promotion',status:'completed',conclusion:'success'},
    {name:'Build and test backend OCI image (core)',status:'completed',conclusion:'success'},
    {name:'Build and test backend OCI image (full)',status:'completed',conclusion:'success'},
    {name:'Publish immutable GHCR image',status:'completed',conclusion:'success'},
  ];
  const promoted=[
    {name:'Resolve verified backend promotion',status:'completed',conclusion:'success'},
    {name:'Build and test backend OCI image (core)',status:'completed',conclusion:'skipped'},
    {name:'Build and test backend OCI image (full)',status:'completed',conclusion:'skipped'},
    {name:'Publish immutable GHCR image',status:'completed',conclusion:'success'},
  ];
  assert.equal(successfulPublicationJobs(main,false,true),true);
  assert.equal(successfulPublicationJobs(promoted,true),true);
  assert.equal(successfulPublicationJobs(promoted,false),false);
  assert.equal(successfulPublicationJobs(main.map(job=>job.name.includes('(core)')?{...job,conclusion:'failure'}:job),false),false);
});

test('promoted publication accepts the REST aggregate for a skipped matrix without weakening producer checks',()=>{
  const promotedAggregate=[
    {name:'Resolve verified backend promotion',status:'completed',conclusion:'success'},
    {name:'Build and test backend OCI image (${{ matrix.profile }})',status:'completed',conclusion:'skipped'},
    {name:'Publish immutable GHCR image',status:'completed',conclusion:'success'},
  ];
  assert.equal(successfulPublicationJobs(promotedAggregate,true,true),true);
  assert.equal(successfulPublicationJobs(promotedAggregate,false,true),false,
    'the skipped aggregate cannot stand in for main Core and Full build jobs');
  assert.equal(successfulPublicationJobs(promotedAggregate,true,false),true);
  assert.equal(successfulPublicationJobs(promotedAggregate.map(job=>job.name.startsWith('Build and test')
    ? {...job,conclusion:'failure'} : job),true,true),false);
  assert.equal(successfulPublicationJobs([...promotedAggregate,
    {...promotedAggregate[1]}],true,true),false,'duplicate aggregate jobs must fail');
});

test('a matching tag, image and SHA cannot replace repository identity for release reuse', () => {
  const fixture = promotedFixture();
  const expected = { image: fixture.record.metadata.images.core, mainSha: fixture.mainSha, producerSha: fixture.sourceSha,
    version: fixture.version, profile: 'core', event: 'pull_request', receipt: fixture.receipt,
    mainTree: fixture.receipt.sourceTree, compatibility };
  assert.throws(() => assertExistingBackendReleaseBinding(fixture.release, fixture.tagRef, expected,
    { ...context, repositoryId: 1000 }), /different repository or owner/);
  assert.throws(() => assertExistingBackendReleaseBinding(fixture.release, fixture.tagRef, expected,
    { ...context, ownerId: 500 }), /different repository or owner/);
});
