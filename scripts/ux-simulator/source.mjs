import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const isPath = (path) => typeof path === 'string' && /^[\w./@+-]+$/.test(path)
  && path.split('/').every((part) => part && part !== '.' && part !== '..');

export function jsonRecordLocator(path, text) {
  const lines = new Map();
  let offset = 0;
  let line = 1;
  for (const match of text.matchAll(/"id"\s*:\s*"([\w.-]+)"/gu)) {
    line += text.slice(offset, match.index).split('\n').length - 1;
    offset = match.index;
    lines.set(match[1], line);
  }
  return id => {
    if (!lines.has(id)) throw new Error('Missing source location for design record: ' + id);
    return { path, line: lines.get(id) };
  };
}

export function createSource(rootLocation) {
  const root = rootLocation instanceof URL ? fileURLToPath(rootLocation) : resolve(rootLocation);
  const inputs = new Map();
  function filename(path) {
    if (!isPath(path)) throw new Error('Invalid repository path: ' + path);
    let current = root;
    for (const segment of path.split('/')) {
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink()) throw new Error('Unexpected symlink: ' + path);
    }
    return current;
  }
  function read(path) {
    const bytes = readFileSync(filename(path));
    inputs.set(path, digest(bytes));
    return bytes.toString('utf8');
  }
  function exists(path) {
    try {
      return lstatSync(filename(path)).isFile();
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  function list(dir) {
    filename(dir);
    // A published source location must refer to a tracked path at the certified SHA.
    const tracked = execFileSync('git', ['-c', 'safe.directory=' + root, 'ls-files', '-z', '--', dir], { cwd: root, encoding: 'utf8' });
    return tracked.split('\0').filter(isPath).sort();
  }
  function location(path, needle) {
    if (!exists(path)) return null;
    const text = read(path);
    const index = text.indexOf(needle);
    return index < 0 ? null : { path, line: text.slice(0, index).split('\n').length, symbol: needle };
  }
  function hashes() {
    return Object.fromEntries([...inputs.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')));
  }
  return { read, exists, list, location, hashes };
}
