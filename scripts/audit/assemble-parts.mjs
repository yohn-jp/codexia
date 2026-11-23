#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
const [partsArg, destinationArg] = process.argv.slice(2);
assert.ok(partsArg && destinationArg && process.argv.length === 4, 'Expected artifact source and Pages destination');
const parts = resolve(partsArg);
const destination = resolve(destinationArg);
const sha = process.env.CODEXIA_EXPECTED_SHA;
assert.match(sha ?? '', /^[a-f0-9]{40}$/u);
mkdirSync(destination, { recursive: true });
const seen = new Set();
for (const name of ['audit', 'architecture', 'specification']) {
  const root = join(parts, 'pages-' + name);
  assert.equal(readFileSync(join(root, '.source-' + name), 'utf8').trim(), sha, 'Wrong source SHA: ' + name);
  function visit(dir) {
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith('.source-')) continue;
      const path = join(dir, entry);
      const stat = lstatSync(path);
      assert.ok(!stat.isSymbolicLink(), 'Symlink in Pages artifact');
      const key = relative(root, path).split(sep).join('/');
      if (stat.isDirectory()) { visit(path); continue; }
      assert.ok(stat.isFile(), 'Non-regular Pages artifact');
      assert.ok(!seen.has(key), 'Colliding Pages artifact path: ' + key);
      seen.add(key);
      const target = join(destination, key);
      assert.ok(!existsSync(target), 'Existing Pages artifact path: ' + key);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(path, target, { recursive: false, force: false });
    }
  }
  visit(root);
}
