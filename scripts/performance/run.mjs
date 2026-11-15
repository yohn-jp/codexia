import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { generate, sizes } from './dataset.mjs';
import { buildIdentity, save, sourceIdentity } from './common.mjs';

// A live child handle is authoritative. Timeouts terminate local worker process groups;
// completed samples remain individually marked complete, while the worker stays NOT_CHECKED.
export async function runWorker(script, args, output, timeoutMs, env = {}) {
  const child = spawn(process.execPath, [script, ...args], { detached: true,
    env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    const descendants = [];
    const visit = pid => {
      let children = [];
      try { children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); }
      catch (error) {
        if (process.platform === 'linux' && error.code === 'ENOENT') {
          for (const candidate of readdirSync('/proc').filter(name => /^\d+$/u.test(name))) {
            try {
              const stat = readFileSync(`/proc/${candidate}/stat`, 'utf8');
              const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
              if (Number(fields[1]) === pid) children.push(Number(candidate));
            } catch (cause) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(cause.code)) throw cause; }
          }
        }
      }
      for (const id of children) { visit(id); descendants.push(id); }
    };
    visit(child.pid);
    for (const id of descendants) { try { process.kill(id, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }, timeoutMs);
  const terminal = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  clearTimeout(timer);
  let report;
  try { report = JSON.parse(await readFile(output, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; report = { samples: [] }; }
  report.workerStatus = report.status;
  report.execution = { ...terminal, timeout, timeoutMs };
  if (timeout || terminal.code !== 0 || report.status !== 'complete') {
    report.status = 'NOT_CHECKED';
    report.reason = timeout ? 'Worker budget exhausted; only completed operations remain in samples.'
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
  const selected = (process.env.BENCH_SIZES ?? Object.keys(sizes).join(',')).split(',').filter(Boolean);
  for (const size of selected) if (!Object.hasOwn(sizes, size)) throw new Error(`Unknown dataset: ${size}`);
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
