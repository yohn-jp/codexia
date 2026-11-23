import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { link, mkdtemp, open, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { readFile, rename, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { readRegularFile as readRegularFileDescriptor } from '../shared/read-regular-file.mjs';

export function distribution(values) {
  if (!values.length) return { n: 0, p50: null, p95: null, p99: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { n: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) };
}
export async function io() {
  try {
    return Object.fromEntries((await readFile('/proc/self/io', 'utf8')).trim().split('\n').map(line => {
      const [key, value] = line.split(':'); return [key, Number(value.trim())];
    }));
  } catch { return null; }
}
async function filesUnder(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  await visit(root);
  return result.sort();
}
export async function hashTree(root) {
  const absolute = resolve(root), digest = createHash('sha256');
  const files = await filesUnder(absolute);
  for (const file of files) {
    digest.update(relative(absolute, file).replaceAll('\\', '/')).update('\0').update(await readFile(file)).update('\0');
  }
  return { root: relative(process.cwd(), absolute) || '.', files: files.length, sha256: digest.digest('hex') };
}
/** Read the bytes through the descriptor that was checked, never by reopening a checked path. */
export function readRegularFile(file) {
  return readRegularFileDescriptor(file, { encoding: null });
}
export function sourceIdentity() {
  const git = (...args) => execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  const status = git('status', '--porcelain=v1', '--untracked-files=all');
  const diff = git('diff', '--binary', 'HEAD', '--');
  return { commit: git('rev-parse', 'HEAD'), clean: status.length === 0,
    status, statusSha256: createHash('sha256').update(status).digest('hex'),
    worktreeDiffSha256: createHash('sha256').update(diff).digest('hex') };
}
export async function buildIdentity() {
  const roots = ['app/dist', 'packages/core/dist', 'packages/api/dist', 'packages/persistence-postgres/dist'];
  const outputs = {};
  for (const root of roots) {
    try { outputs[root] = await hashTree(root); }
    catch (error) { if (error.code !== 'ENOENT') throw error; outputs[root] = null; }
  }
  return outputs;
}
export async function measure(name, action, counters = () => ({})) {
  const beforeIO = await io(), before = counters(), cpu = process.cpuUsage(), start = performance.now();
  const value = await action();
  const ms = performance.now() - start, cpuUs = process.cpuUsage(cpu), afterIO = await io(), after = counters();
  let resultBytes = null;
  try { resultBytes = Buffer.isBuffer(value) ? value.byteLength : Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)); }
  catch { /* opaque return values have no serializable projection size */ }
  return { value, sample: { name, status: 'complete', ms, appWallMs: ms, resultBytes, cpuUs, rssBytes: process.memoryUsage().rss,
    maxRssKiB: process.resourceUsage().maxRSS,
    io: beforeIO && afterIO ? Object.fromEntries(Object.keys(afterIO).map(k => [k, afterIO[k] - beforeIO[k]])) : null,
    counters: Object.fromEntries(Object.keys(after).map(k => [k, after[k] - (before[k] ?? 0)])) } };
}
export async function save(file, data) {
  if (typeof file !== 'string' || !file.trim()) throw new TypeError('Result path must be a non-empty string');
  const destination = resolve(file);
  const temporaryDirectory = await mkdtemp(`${destination}.tmp-`);
  const temporary = join(temporaryDirectory, 'result.json');
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(data, null, 2) + '\n'); }
    finally { await handle.close(); }
    await rename(temporary, destination);
  } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
}

/** Create an explicitly requested result file without following or overwriting an existing path. */
export async function writeNewJsonResult(file, data) {
  if (typeof file !== 'string' || !file.trim()) throw new TypeError('Result path must be a non-empty string');
  const destination = resolve(file);
  const temporaryDirectory = await mkdtemp(`${destination}.tmp-`);
  const temporary = join(temporaryDirectory, 'result.json');
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(data, null, 2) + '\n'); }
    finally { await handle.close(); }
    // link() provides an atomic no-replace claim even when another process races
    // to create the requested output path.
    await link(temporary, destination);
  } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
}
