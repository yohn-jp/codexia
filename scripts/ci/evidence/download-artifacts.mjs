#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Uint8ArrayReader, ZipReader } from '@zip.js/zip.js';

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
    assert.equal(reader.directoryOffset + reader.directoryLength + ZIP_END_RECORD_BYTES + reader.comment.length,
      bytes.length, 'Invalid ZIP central directory bounds or unsupported ZIP64 archive');
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
          await readEntry(entry, maxUncompressed, chunk => file.writeFile(chunk));
        } finally {
          await file.close();
        }
        written.push(pathname);
      }
    }
    return written;
  });
}

export async function extractJsonEntry(bytes, filename) {
  assert.ok(['ci-plan.json', 'report.json', 'profile-build.json', 'native-report.json'].includes(filename), 'Invalid evidence filename');
  const profile = filename === 'profile-build.json';
  const maxArchive = profile ? MAX_ASSET_ARCHIVE : MAX_ARCHIVE;
  const maxJson = profile ? MAX_ASSET_ARCHIVE : MAX_JSON;
  const maxUncompressed = profile ? MAX_ASSET_BYTES : MAX_ARCHIVE;
  return withArtifactZip(bytes, {maxArchive, maxUncompressed, maxEntries: 0xfffe}, async (entries, readEntry) => {
    const selected = entries.find(entry => entry.pathname === filename && !entry.isDirectory);
    assert.ok(selected, 'Missing required JSON entry');

    const chunks = [];
    for (const item of entries) {
      if (item === selected) {
        await readEntry(item.entry, maxJson, chunk => chunks.push(chunk));
      } else {
        await readEntry(item.entry, maxUncompressed);
      }
    }
    const json = Buffer.concat(chunks);
    JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(json));
    return json;
  });
}

export async function downloadSelectedArtifacts({ inventory, ids, identity, kind, directory, repository, token, request }) {
  const selected = selectedArtifacts(inventory, ids, identity, kind);
  const filename = kind === 'plan' ? 'ci-plan.json' : 'report.json';
  for (const artifact of selected) {
    const bytes = await downloadArtifact(artifact, repository, token, request);
    const json = await extractJsonEntry(bytes, filename);
    const destination = kind === 'plan' ? directory : path.join(directory, artifact.name);
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, filename), json, { flag: 'wx', mode: 0o600 });
    console.log(`Downloaded and verified artifact ${artifact.id} (${artifact.name})`);
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
