#!/usr/bin/env node
import assert from 'node:assert/strict';
import { VERIFICATION_GROUPS } from '../impact/contract.mjs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Uint8ArrayReader, ZipReader } from '@zip.js/zip.js';
import { createGitHubOctokit } from '../../github/octokit.mjs';

const MAX_ARCHIVE = 16 * 1024 * 1024;
const MAX_JSON = 4 * 1024 * 1024;
export const MAX_ASSET_ARCHIVE = 128 * 1024 * 1024;
export const MAX_ASSET_BYTES = 256 * 1024 * 1024;

export function selectedArtifacts(inventory, ids, identity, kind) {
  assert.ok(kind === 'plan' || kind === 'evidence', 'Invalid artifact kind');
  assert.equal(String(inventory.identity.runId), String(identity.runId), 'Inventory run mismatch');
  assert.equal(inventory.identity.sourceSha, identity.sourceSha, 'Inventory source mismatch');
  assert.ok(Array.isArray(inventory.artifacts), 'Invalid artifact inventory');
  assert.ok(Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isSafeInteger(id) && id > 0), 'Invalid selected artifact IDs');
  assert.equal(new Set(ids).size, ids.length, 'Duplicate selected artifact ID');
  if (kind === 'plan') assert.equal(ids.length, 1, 'Expected one plan artifact');
  const names = new Set();
  return ids.map(id => {
    const matching = inventory.artifacts.filter(artifact => artifact.id === id);
    assert.equal(matching.length, 1, 'Missing or duplicate selected artifact');
    const artifact = matching[0];
    assert.equal(String(artifact.workflow_run?.id), String(identity.runId), 'Artifact run mismatch');
    assert.equal(artifact.workflow_run?.head_sha, identity.sourceSha, 'Artifact source mismatch');
    assert.equal(artifact.expired, false, 'Artifact expired');
    assert.match(artifact.name, kind === 'plan' ? /^ci-plan$/u : /^ci-evidence-[a-z0-9-]+$/u, 'Invalid artifact name');
    assert.ok(!names.has(artifact.name), 'Duplicate selected artifact name');
    names.add(artifact.name);
    assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/u, 'Artifact digest missing or invalid');
    assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= MAX_ARCHIVE, 'Invalid artifact size');
    return artifact;
  });
}

export async function downloadArtifact(artifact, repository, token, request = fetch, { maxArchive = MAX_ARCHIVE, downloadTimeoutMs = 30_000 } = {}) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/u);
  assert.ok(typeof token === 'string' && token.length > 0, 'Read token required');
  assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0);
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= maxArchive);
  const [owner, repo] = repository.split('/');
  const octokit = createGitHubOctokit({ token, repository, fetchImpl: request, timeout: 15_000 });
  const response = await octokit.rest.actions.downloadArtifact({
    owner, repo, artifact_id: artifact.id, archive_format: 'zip', request: { signal: AbortSignal.timeout(15_000) },
  });
  assert.equal(response.status, 302, `Artifact ${artifact.id} redirect unavailable`);
  const location = new URL(response.headers.location ?? '');
  assert.ok(location.protocol === 'https:' && !location.username && !location.password, 'Invalid artifact download redirect');
  // The GitHub token belongs only at api.github.com, never the signed storage URL.
  assert.ok(Number.isSafeInteger(downloadTimeoutMs) && downloadTimeoutMs > 0 && downloadTimeoutMs <= 300_000, 'Invalid artifact download timeout');
  const archive = await request(location.href, { redirect: 'error', signal: AbortSignal.timeout(downloadTimeoutMs) });
  assert.ok(archive.ok && archive.body, `Artifact ${artifact.id} download failed`);
  const chunks = [];
  let size = 0;
  for await (const chunk of archive.body) {
    size += chunk.byteLength;
    assert.ok(size <= artifact.size_in_bytes && size <= maxArchive, 'Artifact exceeds declared size');
    chunks.push(chunk);
  }
  assert.equal(size, artifact.size_in_bytes, 'Artifact size mismatch');
  const bytes = Buffer.concat(chunks);
  assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, artifact.digest, 'Artifact digest mismatch');
  return bytes;
}

export function validateZipEntryPath(name) {
  assert.ok(typeof name === 'string' && name.length > 0, 'Empty ZIP entry path');
  assert.ok(!name.includes('\\') && !name.includes('\0') && !name.startsWith('/') && !/^[a-z]:/iu.test(name), 'Unsafe ZIP entry path');
  const isDirectory = name.endsWith('/');
  const normalized = isDirectory ? name.slice(0, -1) : name;
  const parts = normalized.split('/');
  assert.ok(parts.length > 0 && parts.every(part => part.length > 0 && part !== '.' && part !== '..'), 'Unsafe ZIP entry path');
  return {path: parts.join('/'), isDirectory};
}

const ZIP_END_RECORD_BYTES = 22;
const ZIP_ALLOWED_FLAGS = 0x080e; // Deflate level, data descriptor and UTF-8.
const utf8 = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

function validateExtraFields(fields) {
  assert.ok(!fields?.has(0x0001), 'ZIP64 archives are not supported');
  // PKWARE Unix may carry link targets or device numbers after the timestamps
  // and IDs. ASi Unix can carry a separate file mode and link target.
  assert.ok((fields?.get(0x000d)?.data.length ?? 0) <= 12 && !fields?.has(0x756e),
    'ZIP links and special files are not allowed');
}

function registerZipPath(paths, pathname, isDirectory) {
  const parts = pathname.split('/');
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const leaf = index === parts.length - 1;
    const directory = !leaf || isDirectory;
    const key = part.normalize('NFC').toLowerCase().toUpperCase().normalize('NFC');
    let node = paths.get(key);
    if (node) {
      assert.ok(node.part === part, 'ZIP normalized path collision');
      assert.ok(!leaf || !node.explicit, 'Duplicate ZIP entry path');
      assert.ok(node.children && directory, 'ZIP file path is a parent of another entry');
    } else {
      node = {part, children: directory ? new Map() : null, explicit: false};
      paths.set(key, node);
    }
    if (leaf) node.explicit = true;
    paths = node.children;
  }
}

async function withArtifactZip(bytes, {maxArchive, maxUncompressed, maxEntries}, consume) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= ZIP_END_RECORD_BYTES && bytes.length <= maxArchive, 'Invalid or oversized ZIP archive');
  assert.ok(Number.isSafeInteger(maxUncompressed) && maxUncompressed > 0, 'Invalid ZIP extraction limit');
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    strictness: 'strict',
    filenameValidation: 'strict',
    checkOverlappingEntry: true,
    checkCrc32: true,
    useWebWorkers: false,
  });
  try {
    const entries = [];
    const paths = new Map();
    let declaredTotal = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      assert.ok(entries.length < maxEntries, 'Invalid ZIP entry count');
      assert.equal(entry.diskNumberStart, 0, 'Multi-disk ZIP not supported');
      assert.ok(!entry.zip64, 'ZIP64 archives are not supported');
      assert.ok(!entry.encrypted && (entry.rawBitFlag & ~ZIP_ALLOWED_FLAGS) === 0 &&
        [0, 8].includes(entry.compressionMethod), 'Unsupported ZIP entry encoding');
      validateExtraFields(entry.extraField);
      const name = utf8.decode(entry.rawFilename);
      const {path: pathname, isDirectory} = validateZipEntryPath(name);
      assert.ok(entry.filename === name, 'ZIP filename metadata mismatch');
      const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
      assert.ok(!entry.symlink && [0, 0o100000, 0o040000].includes(fileType),
        'ZIP symlinks and special files are not allowed');
      assert.equal(entry.directory, isDirectory, 'ZIP directory metadata mismatch');
      if (fileType === 0o100000) assert.ok(!isDirectory, 'ZIP file metadata mismatch');
      if (isDirectory) {
        assert.equal(entry.uncompressedSize, 0, 'ZIP directory entry contains data');
        assert.equal(entry.compressedSize, 0, 'ZIP directory entry contains compressed data');
      }
      assert.ok(entry.compressedSize <= maxArchive, 'ZIP compressed entry exceeds configured limit');
      declaredTotal += entry.uncompressedSize;
      assert.ok(declaredTotal <= maxUncompressed, 'ZIP expands beyond configured limit');

      registerZipPath(paths, pathname, isDirectory);
      entries.push({entry, pathname, isDirectory});
    }
    assert.ok(entries.length > 0, 'Invalid ZIP entry count');
    // The library exposes the central directory bounds. A ZIP64 end record adds
    // data between that directory and the classic end record.
    const endOffset = bytes.length - ZIP_END_RECORD_BYTES - reader.comment.length;
    assert.equal(reader.directoryOffset + reader.directoryLength, endOffset,
      'Invalid ZIP central directory bounds or unsupported ZIP64 archive');
    // zip.js accepts these fields on a single reader without enforcing that
    // the central directory and all entries belong to that one disk.
    assert.equal(bytes.readUInt16LE(endOffset + 6), 0, 'Multi-disk ZIP not supported');
    assert.equal(bytes.readUInt16LE(endOffset + 8), entries.length, 'ZIP entry count mismatch');
    assert.ok(!reader.digitalSignature, 'Unsupported ZIP central directory signature');

    for (const {entry} of entries) {
      await entry.getData(undefined, {checkOverlappingEntryOnly: true});
      const local = entry.localDirectory;
      validateExtraFields(local.extraField);
      assert.ok(!local.dataDescriptor?.zip64, 'ZIP64 archives are not supported');
      assert.ok(!entry.warnings.length, 'Malformed ZIP local header');
      assert.equal(local.rawBitFlag, entry.rawBitFlag, 'ZIP flags mismatch');
      if (entry.bitFlag.dataDescriptor) {
        assert.ok(local.dataDescriptor, 'ZIP data descriptor is missing');
        const descriptorBytes = local.dataDescriptor.signature ? 16 : 12;
        assert.ok(local.dataOffset + entry.compressedSize + descriptorBytes <= reader.directoryOffset,
          'ZIP data descriptor exceeds central directory');
      } else {
        assert.equal(local.compressedSize, entry.compressedSize, 'ZIP compressed size mismatch');
        assert.equal(local.uncompressedSize, entry.uncompressedSize, 'ZIP uncompressed size mismatch');
        assert.equal(local.crc32, entry.crc32, 'ZIP local CRC mismatch');
      }
    }

    let expanded = 0;
    async function readEntry(entry, limit, write) {
      assert.ok(entry.uncompressedSize <= limit, 'ZIP entry exceeds configured limit');
      let size = 0;
      await entry.getData(new WritableStream({
        async write(chunk) {
          size += chunk.byteLength;
          expanded += chunk.byteLength;
          assert.ok(size <= limit && expanded <= maxUncompressed, 'ZIP expands beyond configured limit');
          await write?.(chunk);
        },
      }));
      assert.equal(size, entry.uncompressedSize, 'ZIP uncompressed size mismatch');
    }

    return await consume(entries, readEntry);
  } finally {
    await reader.close();
  }
}

/**
 * Extracts a verified asset archive without trusting archive paths or link metadata.
 * The caller must verify the complete archive digest before calling this function.
 * @param {Buffer} bytes
 * @param {string} destination
 * @param {{maxArchive?:number,maxUncompressed?:number}} limits
 */
export async function extractArtifactFiles(bytes, destination, {maxArchive = MAX_ASSET_ARCHIVE, maxUncompressed = MAX_ASSET_BYTES} = {}) {
  return withArtifactZip(bytes, {maxArchive, maxUncompressed, maxEntries: 9_999}, async (entries, readEntry) => {
    assert.ok(entries.some(entry => !entry.isDirectory), 'ZIP archive contains no files');
    const target = path.resolve(destination);
    await mkdir(target, {recursive: true});
    const targetInfo = await lstat(target);
    assert.ok(targetInfo.isDirectory() && !targetInfo.isSymbolicLink(), 'ZIP extraction destination must be a real directory');
    assert.equal((await readdir(target)).length, 0, 'ZIP extraction destination must be empty');

    const written = [];
    for (const {entry, pathname, isDirectory} of entries) {
      const filename = path.join(target, ...pathname.split('/'));
      if (isDirectory) {
        await readEntry(entry, 0);
        await mkdir(filename, {recursive: true});
      } else {
        await mkdir(path.dirname(filename), {recursive: true});
        const file = await open(filename, 'wx', 0o644);
        try {
          try {
            await readEntry(entry, maxUncompressed, chunk => file.writeFile(chunk));
          } finally {
            await file.close();
          }
        } catch (error) {
          await unlink(filename);
          throw error;
        }
        written.push(pathname);
      }
    }
    return written;
  });
}

const TRACE_REPORT_ENTRY = 'requirements-trace/strictdoc/trace-report.json';

async function extractJsonEntries(bytes, filenames) {
  const permitted = ['ci-plan.json', 'report.json', 'profile-build.json', 'native-report.json', TRACE_REPORT_ENTRY];
  assert.ok(filenames.every(filename => permitted.includes(filename)), 'Invalid evidence filename');
  return readArtifactJsonEntries(bytes, filenames);
}

async function readArtifactJsonEntries(bytes, filenames) {
  const profile = filenames.includes('profile-build.json');
  const maxArchive = profile ? MAX_ASSET_ARCHIVE : MAX_ARCHIVE;
  const maxJson = profile ? MAX_ASSET_ARCHIVE : MAX_JSON;
  // Diagnostic files still receive ZIP integrity checks but are not materialized.
  const maxUncompressed = MAX_ASSET_BYTES;
  return withArtifactZip(bytes, {maxArchive, maxUncompressed, maxEntries: 0xfffe}, async (entries, readEntry) => {
    const selected = new Map(filenames.map(filename => [filename, []]));
    const seen = new Set();
    for (const item of entries) {
      const chunks = !item.isDirectory && selected.get(item.pathname);
      if (chunks) {
        await readEntry(item.entry, maxJson, chunk => chunks.push(chunk));
        seen.add(item.pathname);
      } else {
        await readEntry(item.entry, maxUncompressed);
      }
    }
    assert.equal(seen.size, selected.size, 'Missing required JSON entry');
    return filenames.map(filename => {
      const json = Buffer.concat(selected.get(filename));
      JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(json));
      return json;
    });
  });
}

export async function extractJsonEntry(bytes, filename) {
  const [json] = await extractJsonEntries(bytes, [filename]);
  return json;
}

export async function readTraceArtifact(bytes) {
  const [report, traceReport] = await extractJsonEntries(bytes, ['report.json', TRACE_REPORT_ENTRY]);
  return { group: JSON.parse(report), trace: JSON.parse(traceReport) };
}

export async function readBrowserArtifact(bytes, groupName) {
  const tasks = VERIFICATION_GROUPS[groupName];
  assert.ok(groupName.startsWith('browser-') && Array.isArray(tasks), 'Invalid browser evidence group');
  const group = JSON.parse(await extractJsonEntry(bytes, 'report.json'));
  assert.equal(group.group, groupName, 'Browser evidence group mismatch');
  const executed = group.results.filter(item => item.status === 'passed').map(item => item.task);
  assert.ok(executed.every(task => tasks.includes(task)) && new Set(executed).size === executed.length,
    'Browser artifact contains invalid task identities');
  const entries = executed.length
    ? await readArtifactJsonEntries(bytes, executed.map(task => `${task}/browser-coverage.json`))
    : [];
  const reports = entries.map((value, index) => {
    const report = JSON.parse(value);
    assert.equal(`browser-${report.profile}-${report.shard}`, executed[index], 'Browser coverage task does not match its artifact entry');
    return report;
  });
  return { group, reports };
}

export function assertTraceArtifact(trace, group, identity, repository) {
  const task = 'requirements-trace';
  const url = `https://github.com/${repository}/actions/runs/${identity.runId}`;
  assert.equal(group.group, 'types-trace', 'Trace evidence producer group mismatch');
  assert.equal(group.sha, identity.sourceSha, 'Trace evidence group source mismatch');
  assert.equal(String(group.workflowRunId), identity.runId, 'Trace evidence group run mismatch');
  assert.ok(Number.isSafeInteger(group.workflowAttempt) && group.workflowAttempt > 0, 'Invalid trace evidence attempt');
  assert.equal(group.workflowJob, 'types', 'Trace evidence producer job mismatch');
  assert.equal(trace.source?.sourceSha, identity.sourceSha, 'Trace report source mismatch');
  assert.equal(trace.source?.worktreeClean, true, 'Trace report must come from a clean checkout');
  const execution = trace.execution;
  assert.deepEqual({
    status: execution?.status, repository: execution?.repository, sourceSha: execution?.sourceSha,
    runId: execution?.runId, runAttempt: execution?.runAttempt, job: execution?.job, task: execution?.task, runUrl: execution?.runUrl,
  }, {
    status: 'IN_PROGRESS', repository, sourceSha: identity.sourceSha, runId: identity.runId,
    runAttempt: group.workflowAttempt, job: group.workflowJob, task, runUrl: url,
  }, 'Trace report execution identity mismatch');
  assert.ok(Array.isArray(trace.caseExecutions) && Array.isArray(trace.requiredCaseIds) && trace.requiredCaseIds.length > 0,
    'Trace report lacks case execution evidence');
  const results = new Map(trace.caseExecutions.map(({ testId, result }) => [testId, result]));
  assert.equal(results.size, trace.caseExecutions.length, 'Trace report contains duplicate TEST IDs');
  for (const testId of trace.requiredCaseIds) {
    assert.equal(results.get(testId), 'PASSED', `Required trace case did not pass: ${testId}`);
  }
  assert.ok(Array.isArray(trace.obligationTrace?.rows), 'Trace report lacks obligation mappings');
  for (const row of trace.obligationTrace.rows) {
    assert.notEqual(row.status, 'VERIFIED', 'Trace execution cannot certify a product obligation');
    assert.ok(row.testIds.every(testId => results.has(testId)), 'Obligation refers to an unknown case execution');
    const passedIds = row.testIds.filter(testId => results.get(testId) === 'PASSED').sort();
    assert.deepEqual(row.exactRuns.map(run => run.testId).sort(), passedIds, 'Obligation exact-run cases do not match observed passes');
    for (const run of row.exactRuns) {
      assert.ok(row.testIds.includes(run.testId) && results.get(run.testId) === 'PASSED',
        `Obligation run has no passing case execution: ${run.testId}`);
      assert.deepEqual({
        repository: run.repository, sourceSha: run.sourceSha, runId: run.runId, attempt: run.attempt,
        job: run.job, task: run.task, url: run.url, result: run.result,
      }, {
        repository, sourceSha: identity.sourceSha, runId: identity.runId, attempt: group.workflowAttempt,
        job: group.workflowJob, task, url, result: 'PASS',
      }, 'Obligation exact-run reference mismatch');
    }
  }
}

export async function downloadSelectedArtifacts({ inventory, ids, identity, kind, directory, repository, token, request }) {
  const selected = selectedArtifacts(inventory, ids, identity, kind);
  const filename = kind === 'plan' ? 'ci-plan.json' : 'report.json';
  async function materialize(artifact) {
    const bytes = await downloadArtifact(artifact, repository, token, request);
    const hasTrace = kind === 'evidence' && artifact.name === 'ci-evidence-types-trace';
    const [json, trace] = await extractJsonEntries(bytes, hasTrace ? [filename, TRACE_REPORT_ENTRY] : [filename]);
    if (hasTrace) assertTraceArtifact(JSON.parse(trace), JSON.parse(json), identity, repository);
    const destination = kind === 'plan' ? directory : path.join(directory, artifact.name);
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, filename), json, { flag: 'wx', mode: 0o600 });
    console.log(`Downloaded and verified artifact ${artifact.id} (${artifact.name})`);
  }
  // Names and IDs are unique across the validated selection. Bound archive
  // memory and wait for both writes before propagating a download or ZIP error.
  const batchSize = 2;
  for (let start = 0; start < selected.length; start += batchSize) {
    const batch = selected.slice(start, start + batchSize);
    const results = await Promise.allSettled(batch.map(materialize));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, CODEXIA_EXPECTED_SHA,
    CODEXIA_CI_INVENTORY_PATH, CODEXIA_CI_ARTIFACT_IDS, CODEXIA_CI_ARTIFACT_DIR, CODEXIA_CI_ARTIFACT_KIND } = process.env;
  assert.match(GITHUB_RUN_ID ?? '', /^\d+$/u);
  assert.match(CODEXIA_EXPECTED_SHA ?? '', /^[a-f0-9]{40}$/u);
  assert.ok(CODEXIA_CI_INVENTORY_PATH && CODEXIA_CI_ARTIFACT_DIR, 'Inventory and output directory required');
  assert.match(CODEXIA_CI_ARTIFACT_IDS ?? '', /^\d+(?:,\d+)*$/u, 'Selected artifact IDs required');
  await downloadSelectedArtifacts({
    inventory: JSON.parse(await readFile(CODEXIA_CI_INVENTORY_PATH, 'utf8')),
    ids: CODEXIA_CI_ARTIFACT_IDS.split(',').map(Number),
    identity: { runId: GITHUB_RUN_ID, sourceSha: CODEXIA_EXPECTED_SHA },
    kind: CODEXIA_CI_ARTIFACT_KIND,
    directory: CODEXIA_CI_ARTIFACT_DIR,
    repository: GITHUB_REPOSITORY,
    token: GH_TOKEN,
  });
}
