import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { distribution, save } from './common.mjs';

const sum = values => values.reduce((total, value) => total + value, 0);
const complete = rows => rows.filter(row => row.status === 'complete');
const sampleDistribution = (rows, value) => distribution(complete(rows).map(value).filter(Number.isFinite));

export function summarizeCore(report) {
  const names = [...new Set((report.samples ?? []).map(sample => sample.name))];
  const operations = Object.fromEntries(names.map(name => {
    const rows = report.samples.filter(sample => sample.name === name);
    const hasComplete = rows.some(row => row.status === 'complete');
    const incomplete = report.pending?.name === name || (report.failures ?? []).some(failure => failure.name === name);
    return [name, { status: !hasComplete ? 'NOT_CHECKED' : incomplete ? 'partial' : 'complete',
      appWallMs: sampleDistribution(rows, row => row.appWallMs ?? row.ms),
      sqlRoundTripMs: sampleDistribution(rows, row => row.sqlRoundTripMs),
      poolAcquireMs: sampleDistribution(rows, row => row.poolAcquireMs),
      sqlQueries: sampleDistribution(rows, row => row.counters?.pgQueries),
      sqlRows: sampleDistribution(rows, row => row.counters?.pgRows),
      sqlRowCount: sampleDistribution(rows, row => row.counters?.pgRowCount),
      sqlResultBytes: sampleDistribution(rows, row => row.counters?.pgResultBytes),
      transactionWallMs: sampleDistribution(rows, row => row.transactionWallMs),
      lockBearingStatementWallMs: sampleDistribution(rows, row => row.lockBearingStatementWallMs),
      lockBearingTransactionWallMs: sampleDistribution(rows, row => row.counters?.pgLockBearingTransactionWallMs),
      lockWaitObservedMs: sampleDistribution(rows, row => row.lockWaitObservedMs),
      resultBytes: sampleDistribution(rows, row => row.resultBytes),
      nodeCpuMs: sampleDistribution(rows, row => row.cpuUs ? (row.cpuUs.user + row.cpuUs.system) / 1000 : null),
      rssMaxBytes: Math.max(0, ...complete(rows).map(row => row.rssBytes ?? 0)),
      processPeakRssKiB: Math.max(0, ...complete(rows).map(row => row.maxRssKiB ?? 0)),
      gitProcesses: sampleDistribution(rows, row => row.counters?.gitProcesses),
      readFileCalls: sampleDistribution(rows, row => row.counters?.readFileCalls),
      io: Object.fromEntries(['rchar', 'wchar', 'syscr', 'syscw', 'read_bytes', 'write_bytes'].map(key =>
        [key, sampleDistribution(rows, row => row.io?.[key])])) }];
  }));
  return { status: report.status, workerStatus: report.workerStatus, execution: report.execution,
    reason: report.reason, pending: report.pending, failures: report.failures, error: report.error,
    source: report.harness?.source, build: report.harness?.build, dataset: report.dataset?.datasetId,
    fixture: report.fixture, projection: report.projection, support: report.support,
    rejections: report.rejections, conditions: report.conditions, operations };
}

export function summarizeBrowser(report) {
  const phases = report.phases ?? [];
  const inputs = phases.filter(phase => phase.name.startsWith('browser.authoring.') && Number.isFinite(phase.start) && Number.isFinite(phase.end)).map(phase => {
    const inPhase = row => row.start >= phase.start && row.start <= phase.end;
    const data = phase.browser ?? { inputs: [], reactCommits: [], longTasks: [], transactions: [], reads: [] };
    const transactions = data.transactions.filter(inPhase);
    const reads = data.reads.filter(inPhase);
    return { name: phase.name, sceneId: phase.sceneId, documentBytes: phase.documentBytes,
      typingFrameMs: distribution(data.inputs.filter(row => inPhase(row) && row.type === 'keydown' && row.key && row.key.length === 1).map(row => row.frameMs).filter(Number.isFinite)),
      beforeInputFrameMs: distribution(data.inputs.filter(row => inPhase(row) && row.type === 'beforeinput').map(row => row.frameMs).filter(Number.isFinite)),
      reactCommits: data.reactCommits.filter(row => row.at >= phase.start && row.at <= phase.end).length,
      maxCommittedFibers: Math.max(0, ...data.reactCommits.filter(row => row.at >= phase.start && row.at <= phase.end).map(row => row.fibers)),
      longTasks: distribution(data.longTasks.filter(inPhase).map(row => row.ms)),
      strictWriteMs: distribution(transactions.filter(row => row.mode === 'readwrite' && row.durability === 'strict' && row.status === 'complete').map(row => row.ms)),
      transactions: { total: transactions.length, pending: transactions.filter(row => row.status === 'pending').length,
        aborted: transactions.filter(row => row.status === 'aborted').length },
      reads: { total: reads.length, getAll: reads.filter(row => row.method === 'getAll').length,
        returnedRecords: sum(reads.map(row => row.records ?? 0)) } };
  });
  const server = report.server ?? phases.filter(phase => phase.server).at(-1)?.server;
  const api = server?.requests ?? [];
  const operations = Object.fromEntries([...new Set((report.samples ?? []).map(sample => sample.name))].map(name => {
    const rows = report.samples.filter(sample => sample.name === name);
    const hasComplete = rows.some(row => row.status === 'complete');
    const incomplete = (report.failures ?? []).some(failure => failure.name === name);
    return [name, { status: !hasComplete ? 'NOT_CHECKED' : incomplete ? 'partial' : 'complete',
      appWallMs: sampleDistribution(rows, row => row.appWallMs ?? row.ms),
      sqlQueries: sampleDistribution(rows, row => row.server?.queryMetrics?.pgQueries),
      sqlRows: sampleDistribution(rows, row => row.server?.queryMetrics?.pgRows),
      sqlRowCount: sampleDistribution(rows, row => row.server?.queryMetrics?.pgRowCount),
      poolAcquireMs: sampleDistribution(rows, row => row.server?.queryMetrics?.pgPoolAcquireMs),
      sqlResultBytes: sampleDistribution(rows, row => row.server?.queryMetrics?.pgResultBytes),
      transactionWallMs: sampleDistribution(rows, row => row.server?.queryMetrics?.pgTransactionWallMs),
      lockBearingTransactionWallMs: sampleDistribution(rows, row => row.server?.queryMetrics?.pgLockBearingTransactionWallMs),
      lockWaitObservedMs: sampleDistribution(rows, row => row.server?.queryMetrics?.pgLockWaitObservedMs),
      nodeCpuMs: sampleDistribution(rows, row => row.cpuUs ? (row.cpuUs.user + row.cpuUs.system) / 1000 : null),
      serverCpuMs: sampleDistribution(rows, row => row.server?.cpuUs ? (row.server.cpuUs.user + row.server.cpuUs.system) / 1000 : null),
      browserCpuMs: sampleDistribution(rows, row => row.browserCpuMs),
      serverRssBytes: Math.max(0, ...complete(rows).map(row => row.server?.rssBytes ?? 0)),
      browserRssBytes: Math.max(0, ...complete(rows).map(row => row.browserRssSumBytes ?? 0)),
      rssBytes: Math.max(0, ...complete(rows).map(row => row.rssBytes ?? 0)) }];
  }));
  return { status: report.status, workerStatus: report.workerStatus, reason: report.reason, error: report.error,
    failures: report.failures, source: report.harness?.source, build: report.harness?.build,
    browser: report.browser, dataset: report.dataset?.datasetId, fixtureSetupMs: report.fixtureSetupMs,
    serverStartupMs: report.serverStartupMs, fixture: report.fixture, operations, inputs,
    totals: report.browserMetrics ? { reactCommits: report.browserMetrics.reactCommits.length,
      longTasks: distribution(report.browserMetrics.longTasks.map(row => row.ms)),
      idbTransactions: report.browserMetrics.transactions.length, idbReads: report.browserMetrics.reads.length,
      idbGetAll: report.browserMetrics.reads.filter(row => row.method === 'getAll').length } : null,
    storageEstimate: report.storageEstimate, network: report.network, browserRuntime: report.browserRuntime,
    server: server && { counts: server.counts, cpu: server.cpu, memory: server.memory, usage: server.usage, io: server.io },
    requestCount: report.requests?.length, apiRequestCount: report.requests?.filter(row => row.path.startsWith('/api/')).length,
    streamingRequests: report.requests?.filter(row => row.streaming),
    api: Object.fromEntries(Object.entries(Object.groupBy(api, row => `${row.method} ${row.path}`)).map(([key, rows]) => {
      const isSuccess = status => status >= 200 && status < 300;
      const byStatus = Object.entries(Object.groupBy(rows, row => row.status));
      return [key, {
        ms: distribution(rows.filter(row => isSuccess(row.status)).map(row => row.ms)),
        statusCounts: Object.fromEntries(byStatus.map(([status, samples]) => [status, samples.length])),
        nonSuccessMsByStatus: Object.fromEntries(byStatus
          .filter(([status]) => !isSuccess(Number(status)))
          .map(([status, samples]) => [status, distribution(samples.map(row => row.ms))])),
        responseBytes: distribution(rows.map(row => row.responseBytes)),
      }];
    })),
    notMeasured: report.notMeasured };
}

export async function summarize(directory) {
  const files = await readdir(directory);
  const result = { environment: JSON.parse(await readFile(join(directory, 'environment.json'), 'utf8')),
    datasets: {}, core: {}, browser: {} };
  for (const file of files.filter(name => /^(dataset|core|browser)-.*\.json$/u.test(name))) {
    const report = JSON.parse(await readFile(join(directory, file), 'utf8'));
    if (file.startsWith('dataset-')) result.datasets[report.datasetId] = report;
    else if (file.startsWith('browser-')) result.browser[file] = summarizeBrowser(report);
    else result.core[file] = summarizeCore(report);
  }
  await save(join(directory, 'summary.json'), result);
  const fmt = value => value == null ? 'NOT_CHECKED' : Number(value).toFixed(2);
  const lines = ['| Dataset / operation | Worker status | n | App p50 ms | App p95 ms | SQL queries p50 | SQL rows returned p50 | SQL driver rowCount p50 | SQL round trip p50 ms | SQL result bytes p50 | Transaction p95 ms | Lock-bearing tx p95 ms | Lock wait observed p95 ms | CPU p50 ms | RSS max MiB |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const [file, report] of Object.entries(result.core)) for (const [operation, data] of Object.entries(report.operations)) {
    lines.push(`| ${file.replace('.json', '')} / ${operation} | ${report.status} | ${data.appWallMs.n} | ${fmt(data.appWallMs.p50)} | ${fmt(data.appWallMs.p95)} | ${fmt(data.sqlQueries.p50)} | ${fmt(data.sqlRows.p50)} | ${fmt(data.sqlRowCount.p50)} | ${fmt(data.sqlRoundTripMs.p50)} | ${fmt(data.sqlResultBytes.p50)} | ${fmt(data.transactionWallMs.p95)} | ${fmt(data.lockBearingTransactionWallMs.p95)} | ${fmt(data.lockWaitObservedMs.p95)} | ${fmt(data.nodeCpuMs.p50)} | ${fmt(data.rssMaxBytes / 1048576)} |`);
  }
  lines.push('', '| Browser dataset / operation | Worker status | n | App p50 / p95 ms | SQL queries p50 | SQL rows returned p50 | SQL driver rowCount p50 | SQL result bytes p50 | Transaction p95 ms | Lock-bearing tx p95 ms | Lock wait observed p95 ms | API CPU p50 ms | API RSS max MiB | Browser CPU p50 ms | Browser RSS max MiB |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [file, report] of Object.entries(result.browser)) for (const [operation, data] of Object.entries(report.operations)) {
    lines.push(`| ${file.replace('.json', '')} / ${operation} | ${report.status} | ${data.appWallMs.n} | ${fmt(data.appWallMs.p50)} / ${fmt(data.appWallMs.p95)} | ${fmt(data.sqlQueries.p50)} | ${fmt(data.sqlRows.p50)} | ${fmt(data.sqlRowCount.p50)} | ${fmt(data.sqlResultBytes.p50)} | ${fmt(data.transactionWallMs.p95)} | ${fmt(data.lockBearingTransactionWallMs.p95)} | ${fmt(data.lockWaitObservedMs.p95)} | ${fmt(data.serverCpuMs.p50)} | ${fmt(data.serverRssBytes / 1048576)} | ${fmt(data.browserCpuMs.p50)} | ${fmt(data.browserRssBytes / 1048576)} |`);
  }
  lines.push('', '| Browser dataset / document bytes | typing frame n | p50 / p95 / p99 ms | strict IDB writes n / p95 ms | React commits | Long Tasks n / p95 ms |',
    '| --- | ---: | --- | --- | ---: | --- |');
  for (const [file, report] of Object.entries(result.browser)) for (const input of report.inputs) {
    lines.push(`| ${file.replace('.json', '')} / ${input.documentBytes} | ${input.typingFrameMs.n} | ${fmt(input.typingFrameMs.p50)} / ${fmt(input.typingFrameMs.p95)} / ${fmt(input.typingFrameMs.p99)} | ${input.strictWriteMs.n} / ${fmt(input.strictWriteMs.p95)} | ${input.reactCommits} | ${input.longTasks.n} / ${fmt(input.longTasks.p95)} |`);
  }
  await writeFile(join(directory, 'tables.md'), `${lines.join('\n')}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await summarize(resolve(process.argv[2]));
