import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
const graph = JSON.parse(execFileSync('pnpm', ['--filter', '@codexia/api', 'list', '--prod', '--depth', 'Infinity', '--json'], { encoding: 'utf8' }));
const forbidden = /@codexia\/(?:core|contracts|module-|migration)|(?:onnxruntime|better-sqlite3|isomorphic-git|simple-git)/u;
assert.ok(!forbidden.test(JSON.stringify(graph)), 'Retired Git or model dependency remains in the API closure');
for (const file of ['packages/api/dist/server.js', 'app/dist/index.html', 'app/dist/desktop/index.html', 'app/dist/mobile/index.html']) await access(file);
assert.ok(!(await readFile('packages/api/dist/server.js', 'utf8')).includes('CoreStore'));
console.log('PostgreSQL runtime closure audit passed; no retired Git/module packages.');
