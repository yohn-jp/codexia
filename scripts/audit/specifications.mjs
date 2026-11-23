#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function files(root) {
  const result = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      assert.ok(!stat.isSymbolicLink(), 'Symlink in StrictDoc output');
      if (stat.isDirectory()) walk(path);
      else { assert.ok(stat.isFile(), 'Non-regular StrictDoc output'); result.push(relative(root, path).split(sep).join('/')); }
    }
  }
  walk(root); return result;
}
export function packSpecifications(site, output, sourceSha) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/u, 'Invalid source SHA');
  const report = JSON.parse(readFileSync(join(output, 'trace-report.json'), 'utf8'));
  assert.ok(report.source?.sourceSha === sourceSha && report.source.worktreeClean === true, 'StrictDoc source must match clean checkout');
  assert.equal(report.source.registerPath, 'docs/requirements/REQUIREMENT-REGISTER.md');
  assert.equal(report.toolchain?.strictdocVersion, '0.32.1');
  assert.equal(report.toolchain.requirementsLockSha256, hash(readFileSync('scripts/strictdoc/requirements.lock.txt')), 'StrictDoc lock mismatch');
  assert.equal(report.traceability?.TRC01?.status, 'LOCAL_PASS');
  assert.equal(report.traceability?.TRC02?.status, 'LOCAL_PASS');
  assert.equal(report.traceability?.TRC07?.staticStaging, 'PASSED');
  assert.equal(report.traceability?.TRC07?.browserAcceptance, 'PASSED');
  const rawNames = ['html', 'json'].flatMap(folder => files(join(output, folder)).map(name => `${folder}/${name}`)).sort();
  assert.ok(Array.isArray(report.exports?.rawFiles), 'StrictDoc raw inventory missing');
  assert.deepEqual(report.exports.rawFiles.map(item => item.name), rawNames, 'StrictDoc raw inventory mismatch');
  for (const item of report.exports.rawFiles) {
    const bytes = readFileSync(join(output, item.name));
    assert.equal(bytes.length, item.bytes, 'StrictDoc raw size mismatch');
    assert.equal(hash(bytes), item.sha256, 'StrictDoc raw digest mismatch');
  }
  const dest = join(site, 'requirements');
  assert.ok(!existsSync(dest), 'Requirements destination must not exist');
  for (const folder of ['html', 'json']) { files(join(output, folder)); mkdirSync(dest, { recursive: true }); cpSync(join(output, folder), join(dest, folder), { recursive: true, errorOnExist: true }); }
  const indexPath = join(dest, 'html/index.html');
  const index = readFileSync(indexPath, 'utf8');
  assert.match(index, /<body\b[^>]*>/iu, 'StrictDoc index has no body');
  writeFileSync(indexPath, index.replace(/<body\b[^>]*>/iu, '$&<nav aria-label="Development Portal"><a href="../../">Development Portal</a></nav>'));
  const entries = files(dest).map(name => { const data = readFileSync(join(dest, name)); return { name, bytes: data.length, sha256: hash(data) }; });
  assert.ok(entries.some(x => x.name === 'html/index.html') && entries.some(x => x.name === 'html/requirements/REQUIREMENT-REGISTER.md-TRACE.html') && entries.some(x => x.name === 'json/index.json'), 'Missing StrictDoc output');
  const inputPaths = ['docs/requirements/REQUIREMENT-REGISTER.md', 'docs/requirements/STRICTDOC-GRAMMAR.gra.md', 'scripts/strictdoc/strictdoc_config.py', 'scripts/strictdoc/requirements.lock.txt'];
  const manifest = { schemaVersion: 1, sourceSha, generatedAt: new Date().toISOString(), publication: 'public', inputContracts: inputPaths.map(path => ({ path, sha256: hash(readFileSync(path)) })), generator: report.toolchain, outputs: entries };
  writeFileSync(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
export function verifySpecifications(site, sourceSha) {
  const root = join(site, 'requirements');
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sourceSha, sourceSha, 'Requirements source mismatch');
  assert.equal(manifest.publication, 'public');
  assert.equal(manifest.generator?.strictdocVersion, '0.32.1');
  const expectedInputs = ['docs/requirements/REQUIREMENT-REGISTER.md', 'docs/requirements/STRICTDOC-GRAMMAR.gra.md', 'scripts/strictdoc/strictdoc_config.py', 'scripts/strictdoc/requirements.lock.txt'];
  assert.deepEqual(manifest.inputContracts, expectedInputs.map(path => ({ path, sha256: hash(readFileSync(path)) })), 'Requirements input digest mismatch');
  assert.equal(manifest.generator.requirementsLockSha256, hash(readFileSync('scripts/strictdoc/requirements.lock.txt')), 'Requirements lock mismatch');
  const actual = files(root).filter(name => name !== 'manifest.json');
  assert.deepEqual(actual, manifest.outputs.map(x => x.name), 'Requirements output inventory mismatch');
  for (const item of manifest.outputs) { const data = readFileSync(join(root, item.name)); assert.equal(data.length, item.bytes, 'Requirements size mismatch'); assert.equal(hash(data), item.sha256, 'Requirements digest mismatch'); }
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const [site, output, sha] = process.argv.slice(2); packSpecifications(site, output, sha); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
