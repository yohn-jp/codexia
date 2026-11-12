#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ARCHIVE = 16 * 1024 * 1024;
const MAX_JSON = 4 * 1024 * 1024;

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

export async function downloadArtifact(artifact, repository, token, request = fetch) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/u);
  assert.ok(typeof token === 'string' && token.length > 0, 'Read token required');
  assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0);
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= MAX_ARCHIVE);
  const response = await request(`https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    redirect: 'manual', signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 302, `Artifact ${artifact.id} redirect unavailable`);
  const location = new URL(response.headers.get('location') ?? '');
  assert.ok(location.protocol === 'https:' && !location.username && !location.password, 'Invalid artifact download redirect');
  // The GitHub token belongs only at api.github.com, never the signed storage URL.
  const archive = await request(location.href, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  assert.ok(archive.ok && archive.body, `Artifact ${artifact.id} download failed`);
  const chunks = [];
  let size = 0;
  for await (const chunk of archive.body) {
    size += chunk.byteLength;
    assert.ok(size <= artifact.size_in_bytes && size <= MAX_ARCHIVE, 'Artifact exceeds declared size');
    chunks.push(chunk);
  }
  assert.equal(size, artifact.size_in_bytes, 'Artifact size mismatch');
  const bytes = Buffer.concat(chunks);
  assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, artifact.digest, 'Artifact digest mismatch');
  return bytes;
}

export async function extractJsonEntry(bytes, filename) {
  assert.ok(filename === 'ci-plan.json' || filename === 'report.json', 'Invalid evidence filename');
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
