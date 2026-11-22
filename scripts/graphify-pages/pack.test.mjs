import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packGraph } from './pack.mjs';

test('publishes only the generated HTML and a source identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphify-pages-'));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'graph.html'), '<!doctype html><html><body>' + 'graph '.repeat(30) + '</body></html>');
  await writeFile(join(source, 'graph.json'), '{"private":"not published"}');
  const sha = 'a'.repeat(40);
  const result = await packGraph(source, join(root, 'site'), sha);
  assert.ok(result.bytes > 100);
  assert.match(await readFile(result.path, 'utf8'), /graph/);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'site/graph/source.json'), 'utf8')), {
    sourceSha: sha, generator: 'graphifyy', mode: 'code-only'
  });
  await assert.rejects(readFile(join(root, 'site/graph/graph.json')), { code: 'ENOENT' });
});

test('rejects invalid source identity and incomplete HTML', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphify-pages-'));
  await writeFile(join(root, 'graph.html'), 'not HTML'.repeat(30));
  await assert.rejects(packGraph(root, root, 'main'), /full commit SHA/);
  await assert.rejects(packGraph(root, root, 'a'.repeat(40)), /complete HTML/);
});
