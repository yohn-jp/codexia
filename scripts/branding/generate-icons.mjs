import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const { renderIcon } = require('./codexia-icon.cjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, 'app/public');
await mkdir(resolve(out, 'icons'), { recursive: true });
await Promise.all([
  writeFile(resolve(out, 'favicon.svg'), renderIcon({ size: 16, id: 'codexia-favicon' }) + '\n'),
  ...[24,32,64,180,512,1024].map(size => writeFile(resolve(out, 'icons/codexia-' + size + '.svg'), renderIcon({ size, id: 'codexia-' + size }) + '\n')),
]);
console.log('Codexia icon SVG assets written (16px favicon, 24/32/64/180/512/1024px)');
