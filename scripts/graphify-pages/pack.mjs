#!/usr/bin/env node
// Bundle Graphify's self-contained HTML into the existing Pages publisher.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_HTML_BYTES = 20 * 1024 * 1024;

export async function packGraph(sourceDir, pagesDir, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Graph source must be a full commit SHA');
  const source = join(resolve(sourceDir), 'graph.html');
  // Validate and publish the same bytes: never re-open a previously checked path.
  const htmlBytes = await readFile(source);
  if (htmlBytes.byteLength < 100 || htmlBytes.byteLength > MAX_HTML_BYTES) {
    throw new Error('Graph HTML empty or over 20 MiB limit');
  }
  const html = htmlBytes.toString('utf8');
  if (!/<html\b/i.test(html) || !/<\/html\s*>/i.test(html)) {
    throw new Error('Graphify did not generate a complete HTML document');
  }
  const target = join(resolve(pagesDir), 'graph');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'index.html'), htmlBytes);
  await writeFile(join(target, 'source.json'), JSON.stringify({ sourceSha: sha, generator: 'graphifyy', mode: 'code-only' }) + '\n');
  return { bytes: htmlBytes.byteLength, path: join(target, 'index.html') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) {
    console.error('Usage: pack.mjs GRAPHIFY_OUT PAGES_DIR FULL_SOURCE_SHA');
    process.exitCode = 2;
  } else {
    packGraph(process.argv[2], process.argv[3], process.argv[4])
      .then(result => console.log('Graphify Pages bundle:', result))
      .catch(error => { console.error(error); process.exitCode = 1; });
  }
}
