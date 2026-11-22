import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packGraph } from './pack.mjs';

test('publishes only the generated HTML and a source identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'graphify-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  const generatedHtml = Buffer.from('<!doctype html><html><body>' + '原稿の構造 '.repeat(30) + '</body></html>\r\n');
  await writeFile(join(source, 'graph.html'), generatedHtml);
  await writeFile(join(source, 'graph.json'), '{"private":"not published"}');
  const sha = 'a'.repeat(40);
  const result = await packGraph(source, join(root, 'site'), sha);
  const published = join(root, 'site', 'graph');
  assert.deepEqual((await readdir(published)).sort(), ['index.html', 'source.json']);
  assert.equal(result.bytes, generatedHtml.byteLength);
  assert.equal(result.path, join(published, 'index.html'));
  assert.deepEqual(await readFile(join(published, 'index.html')), generatedHtml);
  assert.deepEqual(JSON.parse(await readFile(join(published, 'source.json'), 'utf8')), {
    sourceSha: sha, generator: 'graphifyy', mode: 'code-only'
  });
});

test('rejects invalid source identity and incomplete HTML before writing output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'graphify-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'graph.html'), 'not HTML'.repeat(30));
  await assert.rejects(packGraph(root, root, 'main'), /full commit SHA/);
  await assert.rejects(packGraph(root, root, 'a'.repeat(40)), /complete HTML/);
  assert.deepEqual(await readdir(root), ['graph.html']);
});
