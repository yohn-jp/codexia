#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const PRODUCERS = ['audit', 'architecture', 'specification'];
const RECEIPT = '.codexia-part-receipt.json';
const SHA = /^[a-f0-9]{40}$/u;
function files(root) {
  assert.ok(lstatSync(root).isDirectory(), 'Pages part root must be a directory');
  const list = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const stat = lstatSync(abs);
      assert.ok(!stat.isSymbolicLink(), 'Symlink in Pages artifact');
      if (stat.isDirectory()) walk(abs);
      else {
        assert.ok(stat.isFile(), 'Non-regular Pages artifact');
        const key = relative(root, abs).split(sep).join('/');
        if (key !== RECEIPT) list.push({ key, abs });
      }
    }
  }
  walk(root);
  return list.sort((a, b) => a.key.localeCompare(b.key, 'en'));
}
function contentDigest(entries) {
  const h = createHash('sha256');
  for (const { key, abs } of entries) {
    h.update(key, 'utf8').update('\0');
    h.update(createHash('sha256').update(readFileSync(abs)).digest('hex')).update('\n');
  }
  return h.digest('hex');
}
const [mode, first, second, third] = process.argv.slice(2);
if (mode === 'stamp') {
  assert.ok(PRODUCERS.includes(second), 'Unknown Pages part');
  assert.match(third ?? '', SHA, 'Invalid source SHA');
  const root = resolve(first);
  assert.ok(!existsSync(join(root, RECEIPT)), 'Duplicate Pages part receipt');
  const entries = files(root);
  writeFileSync(join(root, RECEIPT), JSON.stringify({ version: 1, producer: second, sourceSha: third, count: entries.length, contentSha256: contentDigest(entries) }) + '\n');
} else if (mode === 'assemble') {
  assert.ok(first && second && process.argv.length === 5, 'Expected artifact root and destination');
  const parts = resolve(first), destination = resolve(second);
  const expectedSha = process.env.CODEXIA_EXPECTED_SHA;
  assert.match(expectedSha ?? '', SHA, 'Invalid expected source SHA');
  mkdirSync(destination, { recursive: true });
  const seen = new Set();
  for (const name of PRODUCERS) {
    const root = join(parts, 'pages-' + name);
    const receipt = JSON.parse(readFileSync(join(root, RECEIPT), 'utf8'));
    const entries = files(root);
    assert.equal(receipt.version, 1, 'Unknown part receipt version');
    assert.equal(receipt.producer, name, 'Wrong producer identity');
    assert.equal(receipt.sourceSha, expectedSha, 'Wrong source SHA: ' + name);
    assert.equal(receipt.count, entries.length, 'Wrong Pages file count: ' + name);
    assert.equal(receipt.contentSha256, contentDigest(entries), 'Pages part digest mismatch: ' + name);
    for (const { key, abs } of entries) {
      assert.ok(!seen.has(key), 'Colliding Pages artifact path: ' + key);
      seen.add(key);
      const target = join(destination, key);
      assert.ok(!existsSync(target), 'Existing Pages artifact path: ' + key);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(abs, target, { force: false });
    }
  }
} else {
  throw new Error('Expected stamp or assemble subcommand');
}
