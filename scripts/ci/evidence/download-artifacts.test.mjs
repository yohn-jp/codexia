import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertTraceArtifact, downloadArtifact, extractArtifactFiles, extractJsonEntry, selectedArtifacts, validateZipEntryPath } from './download-artifacts.mjs';

const identity = { runId: '123', sourceSha: 'a'.repeat(40) };
const bytes = Buffer.from('archive');
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const artifact = { id: 10, name: 'ci-evidence-browser-full-ui-v1', workflow_run: { id: 123, head_sha: identity.sourceSha }, expired: false, digest, size_in_bytes: bytes.length };
const inventory = { identity, artifacts: [artifact, { ...artifact, id: 20 }] };

test('selected exact artifact ID is retained even when a same-name older artifact has a higher ID', () => {
  assert.deepEqual(selectedArtifacts(inventory, [10], identity, 'evidence'), [artifact]);
  for (const ids of [[10, 20], [10, 10], [99], [], [-1]]) assert.throws(() => selectedArtifacts(inventory, ids, identity, 'evidence'));
  for (const change of [{ expired: true }, { digest: 'bad' }, { name: '../report' }, { size_in_bytes: 20000000 }, { workflow_run: { id: 456, head_sha: identity.sourceSha } }]) {
    assert.throws(() => selectedArtifacts({ identity, artifacts: [{ ...artifact, ...change }] }, [10], identity, 'evidence'));
  }
});

test('Octokit artifact download validates bytes and isolates the GitHub read token', async () => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://storage.example/temporary?signature=secret' } }) : new Response(bytes);
  };
  assert.deepEqual(await downloadArtifact(artifact, 'yohn-jp/codexia', 'test-token', request), bytes);
  assert.equal(String(requests[0].url), 'https://api.github.com/repos/yohn-jp/codexia/actions/artifacts/10/zip');
  assert.equal(new Headers(requests[0].options.headers).get('authorization'), 'token test-token');
  assert.equal(requests[0].options.redirect, 'manual');
  assert.equal(requests[1].options.headers, undefined);
  assert.equal(requests[1].options.redirect, 'error');
});

test('download rejects missing artifacts, invalid redirects, size and digest mismatches', async () => {
  await assert.rejects(downloadArtifact(artifact, 'yohn-jp/codexia', 'token', async () => new Response(null, { status: 404 })), error => error.status === 404);
  await assert.rejects(downloadArtifact(artifact, 'yohn-jp/codexia', 'token', async () => new Response(null, { status: 302, headers: { location: 'http://storage.example/archive' } })), /Invalid artifact download redirect/);
  for (const bad of [Buffer.from('different'), Buffer.from('archivE'), Buffer.from('short')]) {
    let call = 0;
    await assert.rejects(downloadArtifact(artifact, 'yohn-jp/codexia', 'token', async () => ++call === 1 ? new Response(null, { status: 302, headers: { location: 'https://storage.example/archive' } }) : new Response(bad)), /size|digest/);
  }
});

test('certification materializes only the selected plan and reports for one or many groups', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'codexia-exact-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { downloadSelectedArtifacts } = await import('./download-artifacts.mjs');

  const archives = new Map();
  async function fixture(id, name, filename, data, entries = {}) {
    const directory = path.join(root, String(id));
    await mkdir(directory);
    await writeFile(path.join(directory, filename), JSON.stringify(data));
    await writeFile(path.join(directory, 'diagnostic.txt'), 'available in the original artifact only');
    for (const [entry, payload] of Object.entries(entries)) {
      const target = path.join(directory, entry);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(payload));
    }
    execFileSync('zip', ['-q', 'fixture.zip', filename, 'diagnostic.txt', ...Object.keys(entries)], { cwd: directory });
    const archive = await readFile(path.join(directory, 'fixture.zip'));
    archives.set(id, archive);
    return { ...artifact, id, name, size_in_bytes: archive.length, digest: `sha256:${createHash('sha256').update(archive).digest('hex')}` };
  }

  const selectedPlan = await fixture(1, 'ci-plan', 'ci-plan.json', { sha: identity.sourceSha });
  const selectedReport = await fixture(2, artifact.name, 'report.json', { group: 'browser-full-ui-v1', workflowAttempt: 2 });
  const olderReport = await fixture(9, artifact.name, 'report.json', { group: 'browser-full-ui-v1', workflowAttempt: 1 });
  const retainedReport = await fixture(3, 'ci-evidence-unit-core', 'report.json', { group: 'unit-core', workflowAttempt: 1 });
  const traceGroup = { group: 'types-trace', sha: identity.sourceSha, workflowRunId: 123, workflowAttempt: 2, workflowJob: 'types' };
  const trace = {
    source: { sourceSha: identity.sourceSha, worktreeClean: true },
    execution: { status: 'IN_PROGRESS', repository: 'yohn-jp/codexia', sourceSha: identity.sourceSha, runId: '123',
      runAttempt: 2, job: 'types', task: 'requirements-trace', runUrl: 'https://github.com/yohn-jp/codexia/actions/runs/123' },
    requiredCaseIds: ['TEST-TRC-01-001'], caseExecutions: [{ testId: 'TEST-TRC-01-001', result: 'PASSED' }],
    obligationTrace: { rows: [] },
  };
  const tracePath = 'requirements-trace/strictdoc/trace-report.json';
  const selectedTrace = await fixture(4, 'ci-evidence-types-trace', 'report.json', traceGroup, { [tracePath]: trace });
  const missingTrace = await fixture(5, 'ci-evidence-types-trace', 'report.json', traceGroup);
  const requestedIds = [];
  const options = {
    inventory: { identity, artifacts: [selectedPlan, selectedReport, olderReport, retainedReport, selectedTrace, missingTrace] },
    identity, repository: 'yohn-jp/codexia', token: 'fixture-token',
    async request(url) {
      const { hostname, pathname } = new URL(String(url));
      if (hostname === 'api.github.com') {
        const id = Number(pathname.split('/').at(-2));
        requestedIds.push(id);
        return new Response(null, { status: 302, headers: { location: `https://storage.example/${id}` } });
      }
      return new Response(archives.get(Number(pathname.slice(1))));
    },
  };

  const planDirectory = path.join(root, 'plan');
  await downloadSelectedArtifacts({ ...options, ids: [1], kind: 'plan', directory: planDirectory });
  assert.deepEqual(await readdir(planDirectory), ['ci-plan.json']);
  assert.deepEqual(JSON.parse(await readFile(path.join(planDirectory, 'ci-plan.json'), 'utf8')), { sha: identity.sourceSha });

  for (const ids of [[2], [2, 3]]) {
    const directory = path.join(root, `evidence-${ids.length}`);
    await downloadSelectedArtifacts({ ...options, ids, kind: 'evidence', directory });
    const groups = ids.length === 1 ? ['browser-full-ui-v1'] : ['browser-full-ui-v1', 'unit-core'];
    assert.deepEqual((await readdir(directory)).sort(), groups.map(group => `ci-evidence-${group}`));
    for (const group of groups) {
      const groupDirectory = path.join(directory, `ci-evidence-${group}`);
      assert.deepEqual(await readdir(groupDirectory), ['report.json']);
      assert.deepEqual(JSON.parse(await readFile(path.join(groupDirectory, 'report.json'), 'utf8')),
        { group, workflowAttempt: group === 'unit-core' ? 1 : 2 });
    }
  }
  const traceDirectory = path.join(root, 'evidence-trace');
  await downloadSelectedArtifacts({ ...options, ids: [4], kind: 'evidence', directory: traceDirectory });
  assert.deepEqual(await readdir(path.join(traceDirectory, selectedTrace.name)), ['report.json']);
  await assert.rejects(downloadSelectedArtifacts({ ...options, ids: [5], kind: 'evidence', directory: traceDirectory }),
    /Missing required JSON entry/);
  assert.deepEqual(requestedIds, [1, 2, 2, 3, 4, 5]);
});

test('trace proof rejects stale, foreign or skipped nested evidence in the selected artifact', () => {
  const repository = 'yohn-jp/codexia';
  const group = { group: 'types-trace', sha: identity.sourceSha, workflowRunId: 123, workflowAttempt: 2, workflowJob: 'types' };
  const execution = { status: 'IN_PROGRESS', repository, sourceSha: identity.sourceSha, runId: '123',
    runAttempt: 2, job: 'types', task: 'requirements-trace', runUrl: 'https://github.com/yohn-jp/codexia/actions/runs/123' };
  const testId = 'TEST-TRC-01-001';
  const run = { testId, repository, sourceSha: identity.sourceSha, runId: '123', attempt: 2,
    job: 'types', task: 'requirements-trace', url: execution.runUrl, result: 'PASS' };
  const report = { source: { sourceSha: identity.sourceSha, worktreeClean: true }, execution,
    requiredCaseIds: [testId], caseExecutions: [{ testId, result: 'PASSED' }],
    obligationTrace: { rows: [{ testIds: [testId], exactRuns: [run] }] } };
  assert.doesNotThrow(() => assertTraceArtifact(report, group, identity, repository));
  for (const altered of [
    { ...report, execution: { ...execution, repository: 'foreign/repo' } },
    { ...report, execution: { ...execution, runAttempt: 1 } },
    { ...report, source: { ...report.source, sourceSha: 'b'.repeat(40) } },
    { ...report, caseExecutions: [{ testId, result: 'SKIPPED' }] },
    { ...report, obligationTrace: { rows: [{ testIds: [testId], exactRuns: [{ ...run, attempt: 1 }] }] } },
    { ...report, obligationTrace: { rows: [{ testIds: [testId], exactRuns: [] }] } },
  ]) assert.throws(() => assertTraceArtifact(altered, group, identity, repository));
});

test('extracts only one requested JSON entry and rejects missing or malformed JSON', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codexia-ci-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'report.json'), '{"group":"browser-full-ui-v1"}');
  await writeFile(path.join(dir, 'extra.txt'), 'not evidence');
  execFileSync('zip', ['-q', 'artifact.zip', 'report.json', 'extra.txt'], { cwd: dir });
  const zip = await readFile(path.join(dir, 'artifact.zip'));
  assert.equal((await extractJsonEntry(zip, 'report.json')).toString(), '{"group":"browser-full-ui-v1"}');
  for (const [offset, diagnostic] of [[6, /Multi-disk/], [8, /entry count/]]) {
    const broken = Buffer.from(zip);
    broken.writeUInt16LE(1, broken.length - 22 + offset);
    await assert.rejects(extractJsonEntry(broken, 'report.json'), diagnostic);
  }
  await assert.rejects(extractJsonEntry(zip, 'ci-plan.json'), /Missing required JSON entry/);
  await writeFile(path.join(dir, 'report.json'), 'not JSON');
  execFileSync('zip', ['-q', 'invalid.zip', 'report.json'], { cwd: dir });
  await assert.rejects(extractJsonEntry(await readFile(path.join(dir, 'invalid.zip')), 'report.json'), SyntaxError);
});

test('profile ZIP extracts stored and deflated JSON and rejects truncated archives', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codexia-profile-zip-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const data = JSON.stringify({files:Array.from({length:100},(_,i)=>'profile output '+i)});
  await writeFile(path.join(dir,'profile-build.json'),data);
  await writeFile(path.join(dir,'extra.txt'),'not profile data');
  for(const method of ['-0','-9']){
    execFileSync('zip',['-q',method,'profile'+method+'.zip','profile-build.json','extra.txt'],{cwd:dir});
    const bytes=await readFile(path.join(dir,'profile'+method+'.zip'));
    assert.equal((await extractJsonEntry(bytes,'profile-build.json')).toString(),data);
    const broken=Buffer.from(bytes);
    broken.writeUInt32LE(0xffffffff,broken.length-22+16);
    await assert.rejects(extractJsonEntry(broken, 'profile-build.json'), /directory|entry|ZIP/i);
    await assert.rejects(extractJsonEntry(bytes.subarray(0,bytes.length-8), 'profile-build.json'), /directory|ZIP/i);
  }
});

test('verified frontend ZIP extraction writes only safe regular files into an empty destination',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'codexia-frontend-zip-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(path.join(dir,'desktop','assets'),{recursive:true});
  await writeFile(path.join(dir,'desktop','update-identity.json'),'{}');
  await writeFile(path.join(dir,'desktop','assets','app.js'),'export {};');
  execFileSync('zip',['-q','-r','frontend.zip','desktop'],{cwd:dir});
  const archive=await readFile(path.join(dir,'frontend.zip'));
  const destination=path.join(dir,'out');
  const written=await extractArtifactFiles(archive,destination);
  assert.deepEqual(written.sort(),['desktop/assets/app.js','desktop/update-identity.json']);
  assert.equal(await readFile(path.join(destination,'desktop','assets','app.js'),'utf8'),'export {};');
  await assert.rejects(extractArtifactFiles(archive,destination),/must be empty/);
  for(const name of ['../outside.txt','/etc/passwd','C:/outside.txt','desktop\\..\\outside.txt','desktop//empty.txt']){
    assert.throws(()=>validateZipEntryPath(name),/Unsafe ZIP entry path/);
  }
});

test('frontend ZIP extraction rejects symbolic links',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'codexia-frontend-link-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(path.join(dir,'target.js'),'export {};');
  await symlink('target.js',path.join(dir,'linked.js'));
  execFileSync('zip',['-q','-y','frontend.zip','linked.js'],{cwd:dir});
  const archive=await readFile(path.join(dir,'frontend.zip'));
  await assert.rejects(extractArtifactFiles(archive,path.join(dir,'out')),/symlinks and special files/);
});

test('JSON and frontend artifact extraction reject files with an incorrect CRC', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-zip-crc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const content = '{"value":"original"}';
  await writeFile(path.join(directory, 'profile-build.json'), content);
  execFileSync('zip', ['-q', '-0', 'fixture.zip', 'profile-build.json'], { cwd: directory });
  const archive = await readFile(path.join(directory, 'fixture.zip'));
  const offset = archive.indexOf(content);
  assert.ok(offset > 0);
  archive.write('changed!', offset + content.indexOf('original'));
  await assert.rejects(extractJsonEntry(archive, 'profile-build.json'), /CRC|signature/i);
  const destination = path.join(directory, 'out');
  await assert.rejects(extractArtifactFiles(archive, destination), /CRC|signature/i);
  assert.deepEqual(await readdir(destination), []);
});

test('JSON extraction rejects an incorrect CRC on an unmaterialized diagnostic entry', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-zip-diagnostic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'report.json'), '{}');
  await writeFile(path.join(directory, 'diagnostic.txt'), 'diagnostic payload');
  execFileSync('zip', ['-q', '-0', 'fixture.zip', 'report.json', 'diagnostic.txt'], { cwd: directory });
  const archive = await readFile(path.join(directory, 'fixture.zip'));
  const offset = archive.indexOf('diagnostic payload');
  assert.ok(offset > 0);
  archive[offset] ^= 1;
  await assert.rejects(extractJsonEntry(archive, 'report.json'), /CRC|signature/i);
});

test('evidence JSON retains the report when accompanying trace diagnostics exceed the compressed archive limit', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-zip-trace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'report.json'), '{"trace":true}');
  await writeFile(path.join(directory, 'trace.html'), Buffer.alloc(19 * 1024 * 1024, 'a'));
  execFileSync('zip', ['-q', 'fixture.zip', 'report.json', 'trace.html'], { cwd: directory });
  const archive = await readFile(path.join(directory, 'fixture.zip'));
  assert.equal((await extractJsonEntry(archive, 'report.json')).toString(), '{"trace":true}');
});

test('frontend ZIP extraction rejects case and Unicode path collisions', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-zip-collisions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [index, names] of [['Entry.js', 'entry.js'], ['café.js', 'cafe\u0301.js']].entries()) {
    for (const name of names) await writeFile(path.join(directory, name), 'export {};');
    const filename = `archive-${index}.zip`;
    execFileSync('zip', ['-q', filename, ...names], { cwd: directory });
    const archive = await readFile(path.join(directory, filename));
    await assert.rejects(extractArtifactFiles(archive, path.join(directory, `out-${index}`)), /collision|duplicate/i);
  }
});

test('frontend ZIP extraction bounds both compressed and expanded archive size', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-zip-limits-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const content = 'a'.repeat(1024);
  for (const name of ['one.txt', 'two.txt']) await writeFile(path.join(directory, name), content);
  execFileSync('zip', ['-q', '-9', 'fixture.zip', 'one.txt', 'two.txt'], { cwd: directory });
  const archive = await readFile(path.join(directory, 'fixture.zip'));
  const destination = path.join(directory, 'out');
  await assert.rejects(extractArtifactFiles(archive, destination, { maxArchive: archive.length - 1 }), /archive|limit/i);
  await assert.rejects(extractArtifactFiles(archive, destination, { maxUncompressed: 2047 }), /size|limit/i);
  assert.deepEqual((await extractArtifactFiles(archive, path.join(directory, 'valid'), { maxUncompressed: 2048 })).sort(), ['one.txt', 'two.txt']);

  // An inflated entry must still observe the output limit when it declares less.
  const undersized = Buffer.from(archive);
  const centralRecord = undersized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(centralRecord > 0);
  const localRecord = undersized.readUInt32LE(centralRecord + 42);
  undersized.writeUInt32LE(1023, centralRecord + 24);
  undersized.writeUInt32LE(1023, localRecord + 22);
  await assert.rejects(extractArtifactFiles(undersized, path.join(directory, 'undersized'), { maxUncompressed: 2047 }), /size|limit/i);
});

test('artifact ZIP extraction rejects encrypted entries', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-zip-encryption-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'report.json'), '{}');
  execFileSync('zip', ['-q', '-P', 'fixture-password', 'fixture.zip', 'report.json'], { cwd: directory });
  const archive = await readFile(path.join(directory, 'fixture.zip'));
  await assert.rejects(extractJsonEntry(archive, 'report.json'), /encrypt|encoding|password/i);
  await assert.rejects(extractArtifactFiles(archive, path.join(directory, 'out')), /encrypt|encoding|password/i);
});

test('ZIP readers reject disagreement between local and central file metadata', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-zip-header-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'report.json'), '{}');
  execFileSync('zip', ['-q', '-0', 'fixture.zip', 'report.json'], { cwd: directory });
  const archive = await readFile(path.join(directory, 'fixture.zip'));
  const localFilename = archive.indexOf('report.json');
  assert.ok(localFilename > 0 && archive.lastIndexOf('report.json') > localFilename);
  archive.write('rePort.json', localFilename);
  await assert.rejects(extractJsonEntry(archive, 'report.json'), /local|ambiguous/i);
  await assert.rejects(extractArtifactFiles(archive, path.join(directory, 'out')), /local|ambiguous/i);
});

test('ZIP readers reject overlapping file ranges before extraction', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-zip-overlap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'report.json'), '{}');
  await writeFile(path.join(directory, 'diagnostic.txt'), 'fixture');
  execFileSync('zip', ['-q', '-0', 'fixture.zip', 'report.json', 'diagnostic.txt'], { cwd: directory });
  const archive = await readFile(path.join(directory, 'fixture.zip'));
  const centralRecord = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(centralRecord > 0);
  const localRecord = archive.readUInt32LE(centralRecord + 42);
  const overlappingSize = '{}'.length + 1;
  archive.writeUInt32LE(overlappingSize, localRecord + 18);
  archive.writeUInt32LE(overlappingSize, localRecord + 22);
  archive.writeUInt32LE(overlappingSize, centralRecord + 20);
  archive.writeUInt32LE(overlappingSize, centralRecord + 24);
  await assert.rejects(extractJsonEntry(archive, 'report.json'), /overlap/i);
  const destination = path.join(directory, 'out');
  await assert.rejects(extractArtifactFiles(archive, destination), /overlap/i);
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});

test('streamed artifact ZIP entries with data descriptors retain their content', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-zip-descriptor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const content = '{"streamed":true}';
  await writeFile(path.join(directory, 'report.json'), content);
  const archive = execFileSync('zip', ['-q', '-0', '-', 'report.json'], { cwd: directory });
  assert.equal(archive.readUInt16LE(6) & 8, 8);
  assert.equal((await extractJsonEntry(archive, 'report.json')).toString(), content);
});

test('frontend artifact extraction rejects ZIP64 even for a small archive', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-zip64-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.txt');
  await writeFile(source, 'fixture');
  const input = await open(source);
  t.after(() => input.close());
  const archive = execFileSync('zip', ['-q', '-', '-'], { cwd: directory, stdio: [input.fd, 'pipe', 'pipe'] });
  await assert.rejects(extractArtifactFiles(archive, path.join(directory, 'out')), /ZIP64/i);
});

test('artifact extraction rejects a parent path in an unmaterialized entry', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-zip-parent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'xx'));
  await writeFile(path.join(directory, 'report.json'), '{}');
  await writeFile(path.join(directory, 'xx', 'fixture.txt'), 'fixture');
  execFileSync('zip', ['-q', 'fixture.zip', 'report.json', 'xx/fixture.txt'], { cwd: directory });
  const archive = await readFile(path.join(directory, 'fixture.zip'));
  const originalName = 'xx/fixture.txt';
  const localName = archive.indexOf(originalName);
  const centralName = archive.lastIndexOf(originalName);
  assert.ok(localName > 0 && centralName > localName);
  archive.write('../fixture.txt', localName);
  archive.write('../fixture.txt', centralName);
  await assert.rejects(extractJsonEntry(archive, 'report.json'), /unsafe|filename|path/i);
  await assert.rejects(extractArtifactFiles(archive, path.join(directory, 'out')), /unsafe|filename|path/i);
  await assert.rejects(readFile(path.join(directory, 'fixture.txt')), { code: 'ENOENT' });
});
