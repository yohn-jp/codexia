import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/u, 'Pass the exact Git commit SHA');
const src = new URL('./src/', import.meta.url);
const dist = new URL('./dist/', import.meta.url);
const target = new URL('codexia/', dist);
const html = await readFile(new URL('index.html', src), 'utf8');
assert.equal(html.split('__SOURCE_SHA__').length, 2);
await rm(dist, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await writeFile(new URL('index.html', target), html.replace('__SOURCE_SHA__', sha));
for (const name of ['site.css', 'site.js', 'favicon.svg']) await cp(new URL(name, src), new URL(name, target));
await cp(new URL('_headers', src), new URL('_headers', dist));
