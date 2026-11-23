#!/usr/bin/env node
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECURITY_FILES = ['index.html', 'app.mjs', 'api.mjs', 'security.css'];

export function pack(site) {
  const source = join(dirname(fileURLToPath(import.meta.url)), 'site');
  const output = join(resolve(site), 'security');
  mkdirSync(output, { recursive: true });
  for (const name of SECURITY_FILES) copyFileSync(join(source, name), join(output, name));
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/code-scanning-pages/pack.mjs SITE');
  pack(process.argv[2]);
}
