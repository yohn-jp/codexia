// Benchmark-process-only interception. Load before importing Core, API or PostgreSQL adapters.
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

export const counts = {
  gitProcesses: 0, gitCommandLogDropped: 0, readFileCalls: 0, readFileBytes: 0,
  pgQueries: 0, pgQueryErrors: 0, pgQueryRoundTripMs: 0, pgRows: 0, pgRowCount: 0, pgResultBytes: 0,
  pgPoolAcquireMs: 0, pgTransactions: 0, pgTransactionWallMs: 0,
  pgLockStatements: 0, pgLockStatementRoundTripMs: 0, pgLockBearingTransactions: 0,
  pgLockBearingTransactionWallMs: 0, pgLockWaitObservedMs: 0, pgLockWaitObservations: 0,
  pgLockPolls: 0, pgLockPollErrors: 0,
};
export const gitCommands = [];
export function resetMeasurements() {
  for (const key of Object.keys(counts)) counts[key] = 0;
  gitCommands.length = 0;
}

function isGitExecutable(value) {
  return typeof value === 'string' && value.split(/[\\/]/u).at(-1) === 'git';
}
function isGitShellCommand(value) {
  return typeof value === 'string' && /^\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*(?:exec\s+)?(?:\S*[\\/])?git(?:\s|$)/u.test(value);
}
function noteProcess(file, args) {
  if (!isGitExecutable(file) && !(file === 'env' && isGitExecutable(args?.[0]))) return;
  counts.gitProcesses++;
  if (gitCommands.length < 1000) gitCommands.push({ at: Date.now(), args: [file, ...(Array.isArray(args) ? args : [])] });
  else counts.gitCommandLogDropped++;
}

for (const name of ['execFile', 'spawn']) {
  const original = childProcess[name];
  childProcess[name] = function(file, args, ...rest) {
    noteProcess(file, args);
    return Reflect.apply(original, this, [file, args, ...rest]);
  };
  if (name === 'execFile') childProcess[name][Symbol.for('nodejs.util.promisify.custom')] = (...args) =>
    new Promise((resolve, reject) => childProcess[name](...args, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout, stderr });
    }));
}
for (const name of ['exec', 'execSync']) {
  const original = childProcess[name];
  childProcess[name] = function(command, ...rest) {
    if (isGitShellCommand(command)) noteProcess(command.trim().split(/\s+/u)[0], []);
    return Reflect.apply(original, this, [command, ...rest]);
  };
}
for (const name of ['execFileSync', 'spawnSync']) {
  const original = childProcess[name];
  childProcess[name] = function(file, args, ...rest) {
    noteProcess(file, args);
    return Reflect.apply(original, this, [file, args, ...rest]);
  };
}

const originalRead = fs.readFile;
fs.readFile = async function(...args) {
  if (String(args[0]).startsWith('/proc/')) return Reflect.apply(originalRead, this, args);
  counts.readFileCalls++;
  const value = await Reflect.apply(originalRead, this, args);
  counts.readFileBytes += Buffer.byteLength(value);
  return value;
};
syncBuiltinESMExports();

const requirePersistence = createRequire(new URL('../../packages/persistence-postgres/package.json', import.meta.url));
const { Client, Pool } = requirePersistence('pg');
const originalQuery = Client.prototype.query;
const activePids = new Set();
const activeByPid = new Map();
const transactionState = new WeakMap();

function sqlText(args) {
  const query = args[0];
  return typeof query === 'string' ? query : typeof query?.text === 'string' ? query.text : '';
}
function noteQueryStart(client) {
  if (client.__codexiaMonitor) return;
  const pid = client.processID;
  if (Number.isInteger(pid)) {
    activeByPid.set(pid, (activeByPid.get(pid) ?? 0) + 1);
    activePids.add(pid);
  }
}
function noteQueryEnd(client) {
  if (client.__codexiaMonitor) return;
  const pid = client.processID;
  if (!Number.isInteger(pid)) return;
  const remaining = (activeByPid.get(pid) ?? 1) - 1;
  if (remaining <= 0) { activeByPid.delete(pid); activePids.delete(pid); }
  else activeByPid.set(pid, remaining);
}
function recordQuery(client, text, startedAt, error, result) {
  if (client.__codexiaMonitor) return;
  const elapsed = performance.now() - startedAt;
  const statement = text.trim().replace(/^\(+/u, '').split(/\s+/u)[0]?.toUpperCase() ?? '';
  counts.pgQueries++;
  counts.pgQueryRoundTripMs += elapsed;
  if (error) counts.pgQueryErrors++;
  if (result) {
    const rows = Array.isArray(result.rows) ? result.rows : [];
    counts.pgRows += rows.length;
    counts.pgRowCount += Number.isFinite(result.rowCount) ? result.rowCount : rows.length;
    try { counts.pgResultBytes += Buffer.byteLength(JSON.stringify(rows)); } catch { /* unsupported row values are not byte-counted */ }
  }
  const state = transactionState.get(client);
  if (statement === 'BEGIN') {
    counts.pgTransactions++;
    transactionState.set(client, { startedAt, lockBearing: false });
  } else if (state && /^(COMMIT|ROLLBACK)$/u.test(statement)) {
    const duration = performance.now() - state.startedAt;
    counts.pgTransactionWallMs += duration;
    if (state.lockBearing) counts.pgLockBearingTransactionWallMs += duration;
    transactionState.delete(client);
  }
  const lockBearing = /\b(FOR\s+(?:NO\s+KEY\s+)?UPDATE|UPDATE|DELETE|INSERT)\b/iu.test(text);
  if (lockBearing) {
    counts.pgLockStatements++;
    counts.pgLockStatementRoundTripMs += elapsed;
    if (state && !state.lockBearing) {
      state.lockBearing = true;
      counts.pgLockBearingTransactions++;
    }
  }
}

Client.prototype.query = function(...args) {
  const text = sqlText(args);
  const startedAt = performance.now();
  noteQueryStart(this);
  const callbackIndex = args.findLastIndex(value => typeof value === 'function');
  if (callbackIndex >= 0) {
    const callback = args[callbackIndex];
    const client = this;
    args[callbackIndex] = function(error, result) {
      recordQuery(client, text, startedAt, error, result);
      noteQueryEnd(client);
      return Reflect.apply(callback, this, [error, result]);
    };
    try { return Reflect.apply(originalQuery, this, args); }
    catch (error) { recordQuery(this, text, startedAt, error); noteQueryEnd(this); throw error; }
  }
  let result;
  try { result = Reflect.apply(originalQuery, this, args); }
  catch (error) { recordQuery(this, text, startedAt, error); noteQueryEnd(this); throw error; }
  if (!result || typeof result.then !== 'function') {
    recordQuery(this, text, startedAt, undefined, result);
    noteQueryEnd(this);
    return result;
  }
  return result.then(value => {
    recordQuery(this, text, startedAt, undefined, value);
    noteQueryEnd(this);
    return value;
  }, error => {
    recordQuery(this, text, startedAt, error);
    noteQueryEnd(this);
    throw error;
  });
};

const originalConnect = Pool.prototype.connect;
Pool.prototype.connect = function(...args) {
  const startedAt = performance.now();
  const callbackIndex = args.findLastIndex(value => typeof value === 'function');
  if (callbackIndex >= 0) {
    const callback = args[callbackIndex];
    args[callbackIndex] = function(error, client, release) {
      if (!error && !client?.__codexiaMonitor) counts.pgPoolAcquireMs += performance.now() - startedAt;
      return Reflect.apply(callback, this, [error, client, release]);
    };
    return Reflect.apply(originalConnect, this, args);
  }
  return Reflect.apply(originalConnect, this, args).then(client => {
    if (!client?.__codexiaMonitor) counts.pgPoolAcquireMs += performance.now() - startedAt;
    return client;
  });
};

/** Sample PostgreSQL backend Lock wait states from an observer connection. */
export async function startLockSampler(connectionString, intervalMs = 25) {
  if (!Number.isInteger(intervalMs) || intervalMs < 5 || intervalMs > 1000) {
    throw new Error('CODEXIA_PERF_LOCK_POLL_MS must be an integer from 5 to 1000');
  }
  const monitor = new Client({ connectionString });
  monitor.__codexiaMonitor = true;
  await monitor.connect();
  let polling = false;
  let stopped = false;
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    counts.pgLockPolls++;
    try {
      const pids = [...activePids];
      if (!pids.length) return;
      const result = await monitor.query(`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND pid = ANY($1::int[]) AND wait_event_type = 'Lock'`, [pids]);
      counts.pgLockWaitObservations += result.rows.length;
      counts.pgLockWaitObservedMs += result.rows.length * intervalMs;
    } catch { counts.pgLockPollErrors++; }
    finally { polling = false; }
  };
  const timer = setInterval(() => { void poll(); }, intervalMs);
  return { intervalMs, async flush() { while (polling) await new Promise(resolve => setTimeout(resolve, 1)); await poll(); },
    async stop() { stopped = true; clearInterval(timer); while (polling) await new Promise(resolve => setTimeout(resolve, 1)); await monitor.end(); } };
}
