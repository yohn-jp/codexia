import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { generate, sizes } from './dataset.mjs';
import { buildIdentity, save, sourceIdentity } from './common.mjs';

// A Linux process identity includes its start time; PID reuse must never make
// the cleanup wait on, or signal, an unrelated process.
function procIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    return { pid, state: fields[0], parent: Number(fields[1]), startTime: fields[19] };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    throw error;
  }
}

function descendantsOf(root) {
  if (process.platform !== 'linux') return [];
  // /proc/<pid>/task/<pid>/children is not a reliable inventory while
  // processes are exiting and only covers the specified thread.
  const byParent = new Map();
  for (const name of readdirSync('/proc').filter(name => /^\d+$/u.test(name))) {
    let entry;
    try { entry = procIdentity(Number(name)); }
    catch (error) { if (error.code === 'EACCES') continue; throw error; }
    if (!entry) continue;
    const siblings = byParent.get(entry.parent) ?? [];
    siblings.push(entry);
    byParent.set(entry.parent, siblings);
  }
  const found = [], visited = new Set([root]);
  const visit = pid => {
    for (const entry of byParent.get(pid) ?? []) {
      if (visited.has(entry.pid)) continue;
      visited.add(entry.pid);
      visit(entry.pid);
      found.push(entry);
    }
  };
  visit(root);
  return found;
}

function sameLiveProcess(entry) {
  const current = procIdentity(entry.pid);
  return current && current.startTime === entry.startTime && !['Z', 'X'].includes(current.state);
}

async function confirmDescendantExit(descendants) {
  const deadline = performance.now() + 5000;
  for (;;) {
    const remaining = descendants.filter(sameLiveProcess);
    if (!remaining.length) return;
    if (performance.now() >= deadline) throw Error(`Worker descendant termination unconfirmed: ${remaining.map(entry => entry.pid).join(', ')}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// A live child handle is authoritative. Timeouts terminate local worker process groups;
// completed samples remain individually marked complete, while the worker stays NOT_CHECKED.
export async function runWorker(script, args, output, timeoutMs, env = {}) {
  const child = spawn(process.execPath, [script, ...args], { detached: true,
    env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
  let timeout = false, descendants = [], cleanupError;
  const timer = setTimeout(() => {
    timeout = true;
    try {
      descendants = descendantsOf(child.pid);
      for (const entry of descendants) {
        if (!sameLiveProcess(entry)) continue;
        try { process.kill(entry.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    } catch (error) { cleanupError = String(error); }
    // Always terminate the worker group even when descendant enumeration fails.
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') cleanupError = String(error); }
  }, timeoutMs);
  let terminal;
  try {
    terminal = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
  } finally { clearTimeout(timer); }
  // SIGKILL delivery and the parent's exit do not prove a detached child
  // has stopped. Verify known descendants before returning the report.
  if (timeout) {
    try { await confirmDescendantExit(descendants); }
    catch (error) { cleanupError = String(error); }
  }
  let report;
  try { report = JSON.parse(await readFile(output, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; report = { samples: [] }; }
  report.workerStatus = report.status;
  report.execution = { ...terminal, timeout, timeoutMs, ...(cleanupError ? { cleanupError } : {}) };
  if (timeout || terminal.code !== 0 || report.status !== 'complete' || cleanupError) {
    report.status = 'NOT_CHECKED';
    report.reason = cleanupError ? 'Worker cleanup failed; remaining process termination is unconfirmed.'
      : timeout ? 'Worker budget exhausted; only completed operations remain in samples.'
        : terminal.code !== 0 ? 'Worker failed; inspect failures/error and exit status.'
          : 'Worker did not reach its complete state.';
  }
  await save(output, report);
  return report;
}

function command(...args) {
  return execFileSync(args[0], args.slice(1), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
}
function osRelease() {
  try { return Object.fromEntries(readFileSync('/etc/os-release', 'utf8').split('\n').filter(line => line.includes('='))
    .map(line => { const separator = line.indexOf('='); return [line.slice(0, separator), line.slice(separator + 1).replace(/^"|"$/gu, '')]; })); }
  catch { return null; }
}

export function selectCoreDatasets(value = 'small,long-form,knowledge-dense,limit-999') {
  const selected = value.split(',').filter(Boolean);
  for (const size of selected) if (!Object.hasOwn(sizes, size)) throw new Error(`Unknown dataset: ${size}`);
  return selected;
}

async function main() {
  const root = resolve(process.argv[2] ?? '/tmp/codexia-postgresql-baseline');
  const repeats = Number(process.env.BENCH_REPEATS ?? 20);
  const browserSaveRepeats = Number(process.env.BENCH_BROWSER_SAVE_REPEATS ?? 3);
  const timeoutMs = Number(process.env.BENCH_TIMEOUT_MS ?? 600000);
  if (!Number.isInteger(repeats) || repeats < 1 || !Number.isInteger(browserSaveRepeats) || browserSaveRepeats < 1 ||
      !Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error('Invalid repeat count or timeout');
  if (!process.env.CODEXIA_TEST_DATABASE_URL) throw new Error('CODEXIA_TEST_DATABASE_URL must point to a disposable loopback codexia_perf_* database');
  const databaseUrl = new URL(process.env.CODEXIA_TEST_DATABASE_URL);
  const databaseHost = databaseUrl.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(databaseHost) ||
      !/^codexia_perf_[a-z0-9_-]+$/u.test(databaseName)) {
    throw new Error('Baseline runs require a disposable loopback PostgreSQL database named codexia_perf_*');
  }
  const source = sourceIdentity();
  const rootPath = process.cwd();
  const build = await buildIdentity();
  for (const key of ['packages/core/dist', 'packages/api/dist', 'packages/persistence-postgres/dist']) {
    if (!build[key]) throw new Error(`Missing ${key}; run CODEXIA_PROFILE=core pnpm build before measuring`);
  }
  const results = join(root, 'results');
  await mkdir(root); // fresh output directory only
  await mkdir(results);
  const browserExecutable = process.env.CODEXIA_E2E_CHROMIUM ?? 'Playwright bundled Chromium';
  const browserSizes = (process.env.BENCH_BROWSER_SIZES ?? 'small,long-form').split(',').filter(Boolean);
  const selected = selectCoreDatasets(process.env.BENCH_SIZES);
  for (const size of browserSizes) if (!Object.hasOwn(sizes, size)) throw new Error(`Unknown browser dataset: ${size}`);
  if (browserSizes.length && !build['app/dist']) throw new Error('Missing app/dist; run CODEXIA_PROFILE=core pnpm build before browser measurements');
  const environment = { schemaVersion: 2, timestamp: new Date().toISOString(), command: process.argv,
    source, build, node: process.version, pnpm: command('pnpm', '--version'),
    git: command('git', '--version'), os: { platform: os.platform(), release: os.release(), arch: os.arch(), distribution: osRelease() },
    cpuModels: [...new Set(os.cpus().map(cpu => cpu.model))], logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), loadAverage: os.loadavg(),
    profile: 'core', repeats, browserSaveRepeats, timeoutMs, poolMax: Number(process.env.CODEXIA_PERF_POOL_MAX ?? 10),
    lockPollMs: Number(process.env.CODEXIA_PERF_LOCK_POLL_MS ?? 25),
    browserExecutable, browserSizes, selectedDatasets: selected,
    instrumentation: { version: 2, processWrappers: ['pg Client.query', 'pg Pool.connect', 'readFile', 'Git process'],
      pgLockWait: 'pg_stat_activity wait_event_type polling on a separate observer connection',
      sqlRowsBytes: 'PostgreSQL returned rows, driver rowCount and serialized returned-row bytes',
      setupExcluded: ['migration', 'fixture generation', 'PostgreSQL seeding', 'browser/API startup'] } };
  await save(join(results, 'environment.json'), environment);
  let incomplete = false;
  for (const size of selected) {
    console.log(`Generating PostgreSQL fixture ${size}`);
    const datasetPath = join(root, size);
    const manifest = await generate(datasetPath, size);
    await save(join(results, `dataset-${size}.json`), manifest);
    const isBoundary = manifest.documentCount >= 999;
    console.log(`Measuring Core ${size}/${isBoundary ? 'boundary' : 'all'}`);
    const coreOutput = join(results, `core-${size}.json`);
    const core = await runWorker(resolve('scripts/performance/core.mjs'),
      [datasetPath, coreOutput, String(repeats), isBoundary ? 'boundary' : 'all'], coreOutput, timeoutMs,
      { CODEXIA_PROFILE: 'core' });
    console.log(`${size}/core: ${core.status}`);
    incomplete ||= core.status !== 'complete';
    if (browserSizes.includes(size)) {
      console.log(`Measuring PostgreSQL browser ${size}`);
      const browserOutput = join(results, `browser-${size}.json`);
      const browser = await runWorker(resolve('scripts/performance/browser.mjs'),
        [datasetPath, browserOutput, String(repeats)], browserOutput, timeoutMs,
        { CODEXIA_PROFILE: 'core' });
      console.log(`${size}/browser: ${browser.status}`);
      incomplete ||= browser.status !== 'complete';
    }
  }
  await save(join(results, 'run.json'), { source, root: rootPath, outputRoot: root,
    databaseName, selectedDatasets: selected,
    repeats, timeoutMs, browserSizes });
  if (incomplete) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
