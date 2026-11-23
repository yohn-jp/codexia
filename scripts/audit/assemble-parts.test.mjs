import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./assemble-parts.mjs', import.meta.url));
const sha = 'a'.repeat(40);
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'codexia-pages-parts-'));
  const parts = join(root, 'parts');
  for (const name of ['audit', 'architecture', 'specification']) {
    const dir = join(parts, 'pages-' + name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name + '.txt'), name + ' contents');
    const stamp = spawnSync(process.execPath, [script, 'stamp', dir, name, sha], { encoding: 'utf8' });
    assert.equal(stamp.status, 0, stamp.stderr);
  }
  return { root, parts, destination: join(root, 'site') };
}
function assemble({ parts, destination }, expectedSha = sha) {
  return spawnSync(process.execPath, [script, 'assemble', parts, destination], { encoding: 'utf8', env: { ...process.env, CODEXIA_EXPECTED_SHA: expectedSha } });
}
test('Pages parts assemble independent paths with verified source and content digest', () => {
  const context = setup();
  try {
    const result = assemble(context);
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['audit', 'architecture', 'specification']) {
      assert.equal(readFileSync(join(context.destination, name + '.txt'), 'utf8'), name + ' contents');
    }
    assert.equal(existsSync(join(context.destination, '.codexia-part-receipt.json')), false);
  } finally { rmSync(context.root, { recursive: true, force: true }); }
});
test('Pages assembly rejects altered content and wrong source SHA', () => {
  const context = setup();
  try {
    assert.notEqual(assemble({ ...context, destination: join(context.root, 'wrong-sha') }, 'b'.repeat(40)).status, 0);
    writeFileSync(join(context.parts, 'pages-architecture', 'architecture.txt'), 'tampered');
    const result = assemble(context);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /digest mismatch/u);
  } finally { rmSync(context.root, { recursive: true, force: true }); }
});
