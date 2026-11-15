#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const response = await request(`https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    redirect: 'manual', signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 302, `Artifact ${artifact.id} redirect unavailable`);
  const location = new URL(response.headers.get('location') ?? '');
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

/**
 * Extracts a verified asset archive without trusting archive paths or link metadata.
 * The caller must verify the complete archive digest before calling this function.
 * @param {Buffer} bytes
 * @param {string} destination
 * @param {{maxArchive?:number,maxUncompressed?:number}} limits
 */
export async function extractArtifactFiles(bytes, destination, {maxArchive = MAX_ASSET_ARCHIVE, maxUncompressed = MAX_ASSET_BYTES} = {}) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 22 && bytes.length <= maxArchive, 'Invalid or oversized ZIP archive');
  assert.ok(Number.isSafeInteger(maxUncompressed) && maxUncompressed > 0, 'Invalid ZIP extraction limit');

  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  assert.ok(end >= 0, 'ZIP end record missing');
  assert.equal(bytes.readUInt16LE(end + 4), 0, 'Multi-disk ZIP not supported');
  assert.equal(bytes.readUInt16LE(end + 6), 0, 'Multi-disk ZIP not supported');
  const count = bytes.readUInt16LE(end + 10);
  assert.equal(bytes.readUInt16LE(end + 8), count, 'ZIP entry count mismatch');
  assert.ok(count > 0 && count < 10_000, 'Invalid ZIP entry count');
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralOffset = bytes.readUInt32LE(end + 16);
  assert.ok(centralOffset + centralSize === end, 'Invalid ZIP central directory bounds');

  /** @type {{path:string,isDirectory:boolean,flags:number,method:number,compressed:number,uncompressed:number,localOffset:number,name:string}[]} */
  const entries = [];
  const paths = new Set();
  const localOffsets = new Set();
  let totalUncompressed = 0;
  let cursor = centralOffset;
  const decoder = new TextDecoder('utf-8', {fatal:true});
  for (let index = 0; index < count; index++) {
    assert.ok(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50, 'Invalid ZIP central entry');
    const creator = bytes.readUInt16LE(cursor + 4) >>> 8;
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    assert.ok(next <= end, 'ZIP entry exceeds central directory');
    assert.equal(diskStart, 0, 'Multi-disk ZIP not supported');
    assert.ok(compressed !== 0xffffffff && uncompressed !== 0xffffffff && localOffset !== 0xffffffff, 'ZIP64 archives are not supported');
    assert.ok((flags & 1) === 0 && [0, 8].includes(method), 'Unsupported ZIP entry encoding');
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const entryPath = validateZipEntryPath(name);
    const mode = externalAttributes >>> 16;
    const fileType = creator === 3 ? mode & 0o170000 : 0;
    assert.ok(fileType === 0 || fileType === 0o100000 || fileType === 0o040000, 'ZIP symlinks and special files are not allowed');
    if (fileType === 0o040000) assert.equal(entryPath.isDirectory, true, 'ZIP directory metadata mismatch');
    if (fileType === 0o100000) assert.equal(entryPath.isDirectory, false, 'ZIP file metadata mismatch');
    assert.ok(!paths.has(entryPath.path), 'Duplicate ZIP entry path');
    assert.ok(!localOffsets.has(localOffset), 'Duplicate ZIP local entry offset');
    paths.add(entryPath.path);
    localOffsets.add(localOffset);
    totalUncompressed += uncompressed;
    assert.ok(totalUncompressed <= maxUncompressed, 'ZIP expands beyond configured limit');
    if (entryPath.isDirectory) {
      assert.equal(uncompressed, 0, 'ZIP directory entry contains data');
      assert.equal(compressed, 0, 'ZIP directory entry contains compressed data');
    }
    entries.push({...entryPath,flags,method,compressed,uncompressed,localOffset,name});
    cursor = next;
  }
  assert.equal(cursor, centralOffset + centralSize, 'ZIP central directory size mismatch');

  const files = new Set(entries.filter(entry => !entry.isDirectory).map(entry => entry.path));
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let length = 1; length < parts.length; length++) {
      assert.ok(!files.has(parts.slice(0, length).join('/')), 'ZIP file path is a parent of another entry');
    }
  }

  /** @type {{start:number,end:number}[]} */
  const ranges = [];
  for (const entry of entries) {
    const offset = entry.localOffset;
    assert.ok(offset + 30 <= centralOffset && bytes.readUInt32LE(offset) === 0x04034b50, 'Invalid ZIP local entry');
    assert.equal(bytes.readUInt16LE(offset + 6), entry.flags, 'ZIP flags mismatch');
    assert.equal(bytes.readUInt16LE(offset + 8), entry.method, 'ZIP method mismatch');
    const localNameLength = bytes.readUInt16LE(offset + 26);
    const localExtraLength = bytes.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressed;
    assert.ok(dataEnd <= centralOffset, 'ZIP data exceeds central directory');
    assert.equal(decoder.decode(bytes.subarray(offset + 30, offset + 30 + localNameLength)), entry.name, 'ZIP local entry name mismatch');
    if ((entry.flags & 8) === 0) {
      assert.equal(bytes.readUInt32LE(offset + 18), entry.compressed, 'ZIP compressed size mismatch');
      assert.equal(bytes.readUInt32LE(offset + 22), entry.uncompressed, 'ZIP uncompressed size mismatch');
    }
    entry.dataStart = dataStart;
    ranges.push({start:offset,end:dataEnd});
  }
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index++) assert.ok(ranges[index - 1].end <= ranges[index].start, 'Overlapping ZIP entries');

  const target = path.resolve(destination);
  await mkdir(target, {recursive:true});
  const targetInfo = await lstat(target);
  assert.ok(targetInfo.isDirectory() && !targetInfo.isSymbolicLink(), 'ZIP extraction destination must be a real directory');
  assert.equal((await readdir(target)).length, 0, 'ZIP extraction destination must be empty');
  for (const entry of entries.filter(value => value.isDirectory).sort((a, b) => a.path.length - b.path.length)) {
    await mkdir(path.join(target, ...entry.path.split('/')), {recursive:true});
  }
  const written = [];
  let extractedTotal = 0;
  for (const entry of entries.filter(value => !value.isDirectory)) {
    const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed);
    const remaining = maxUncompressed - extractedTotal;
    const content = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, {maxOutputLength:Math.max(1, remaining)});
    assert.equal(content.length, entry.uncompressed, 'ZIP uncompressed size mismatch');
    extractedTotal += content.length;
    const filename = path.join(target, ...entry.path.split('/'));
    await mkdir(path.dirname(filename), {recursive:true});
    await writeFile(filename, content, {flag:'wx',mode:0o644});
    written.push(entry.path);
  }
  assert.ok(written.length > 0, 'ZIP archive contains no files');
  return written;
}

// Profile artifacts run inside the immutable Playwright image, which has no unzip.
// Parse the bounded single requested entry using the central directory. Never
// materialize an archive pathname or execute an archive-supplied command.
export function extractProfileJson(bytes, filename = 'profile-build.json') {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 22, 'Invalid ZIP archive');
  assert.equal(filename, 'profile-build.json');
  const maxJson = 128 * 1024 * 1024;
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  assert.ok(end >= 0, 'ZIP end record missing');
  assert.equal(bytes.readUInt16LE(end + 4), 0, 'Multi-disk ZIP not supported');
  assert.equal(bytes.readUInt16LE(end + 6), 0, 'Multi-disk ZIP not supported');
  const count = bytes.readUInt16LE(end + 10);
  assert.equal(bytes.readUInt16LE(end + 8), count, 'ZIP entry count mismatch');
  assert.ok(count > 0 && count < 0xffff, 'Invalid ZIP entry count');
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralOffset = bytes.readUInt32LE(end + 16);
  assert.ok(centralOffset + centralSize <= end, 'Invalid ZIP central directory');
  let cursor = centralOffset;
  let selected;
  for (let i = 0; i < count; i++) {
    assert.ok(cursor + 46 <= centralOffset + centralSize && bytes.readUInt32LE(cursor) === 0x02014b50, 'Invalid ZIP central entry');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20), uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    assert.ok(next <= centralOffset + centralSize, 'ZIP entry exceeds directory');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name === filename) {
      assert.ok(!selected, 'Duplicate required JSON entry');
      assert.ok((flags & 1) === 0 && [0, 8].includes(method), 'Unsupported ZIP encoding');
      assert.ok(uncompressed <= maxJson && compressed <= bytes.length, 'ZIP entry exceeds bounds');
      assert.ok(localOffset + 30 <= centralOffset && bytes.readUInt32LE(localOffset) === 0x04034b50, 'Invalid ZIP local entry');
      assert.equal(bytes.readUInt16LE(localOffset + 6), flags, 'ZIP flags mismatch');
      assert.equal(bytes.readUInt16LE(localOffset + 8), method, 'ZIP method mismatch');
      const localNameLength = bytes.readUInt16LE(localOffset + 26), localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      assert.ok(dataStart + compressed <= centralOffset, 'ZIP data exceeds bounds');
      assert.equal(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8'), filename, 'ZIP entry name mismatch');
      selected = {dataStart,compressed,uncompressed,method};
    }
    cursor = next;
  }
  assert.equal(cursor, centralOffset + centralSize, 'ZIP central directory size mismatch');
  assert.ok(selected, 'Missing required JSON entry');
  const data = bytes.subarray(selected.dataStart, selected.dataStart + selected.compressed);
  const json = selected.method === 0 ? data : inflateRawSync(data, {maxOutputLength: maxJson});
  assert.equal(json.length, selected.uncompressed, 'ZIP uncompressed size mismatch');
  JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(json));
  return json;
}

export async function extractJsonEntry(bytes, filename) {
  assert.ok(['ci-plan.json', 'report.json', 'profile-build.json', 'native-report.json'].includes(filename), 'Invalid evidence filename');
  if (filename === 'profile-build.json') return extractProfileJson(bytes, filename);
  const temporary = await mkdtemp(path.join(tmpdir(), 'codexia-ci-artifact-'));
  try {
    const zip = path.join(temporary, 'artifact.zip');
    await writeFile(zip, bytes, { mode: 0o600 });
    const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: MAX_JSON, timeout: 10_000 }).split(/\r?\n/u);
    assert.equal(entries.filter(entry => entry === filename).length, 1, 'Missing or duplicate required JSON entry');
    // Do not extract arbitrary archive paths onto the runner filesystem.
    const json = execFileSync('unzip', ['-p', zip, filename], { maxBuffer: MAX_JSON, timeout: 10_000 });
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
    return json;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, CODEXIA_EXPECTED_SHA, CODEXIA_CI_INVENTORY_PATH, CODEXIA_CI_ARTIFACT_IDS, CODEXIA_CI_ARTIFACT_DIR, CODEXIA_CI_ARTIFACT_KIND } = process.env;
  assert.match(GITHUB_RUN_ID ?? '', /^\d+$/u);
  assert.match(CODEXIA_EXPECTED_SHA ?? '', /^[a-f0-9]{40}$/u);
  assert.ok(CODEXIA_CI_INVENTORY_PATH && CODEXIA_CI_ARTIFACT_DIR, 'Inventory and output directory required');
  assert.match(CODEXIA_CI_ARTIFACT_IDS ?? '', /^\d+(?:,\d+)*$/u, 'Selected artifact IDs required');
  const inventory = JSON.parse(await readFile(CODEXIA_CI_INVENTORY_PATH, 'utf8'));
  const kind = CODEXIA_CI_ARTIFACT_KIND;
  const selected = selectedArtifacts(inventory, CODEXIA_CI_ARTIFACT_IDS.split(',').map(Number), { runId: GITHUB_RUN_ID, sourceSha: CODEXIA_EXPECTED_SHA }, kind);
  for (const artifact of selected) {
    const bytes = await downloadArtifact(artifact, GITHUB_REPOSITORY, GH_TOKEN);
    const filename = kind === 'plan' ? 'ci-plan.json' : 'report.json';
    const directory = kind === 'plan' ? CODEXIA_CI_ARTIFACT_DIR : path.join(CODEXIA_CI_ARTIFACT_DIR, artifact.name);
    const json = await extractJsonEntry(bytes, filename);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, filename), json, { flag: 'wx', mode: 0o600 });
    console.log(`Downloaded and verified artifact ${artifact.id} (${artifact.name})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
