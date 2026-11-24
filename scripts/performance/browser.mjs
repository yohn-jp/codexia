import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';
import { tsImport } from 'tsx/esm/api';
import { buildIdentity, distribution, save, sourceIdentity } from './common.mjs';
import { installBrowserProbes } from './browser-probes.mjs';
import { manuscriptEditor, expectServerSaved, selectManuscriptProject, openManuscriptScene } from '../../tests/e2e/postgres-fixture.ts';

const [datasetPathArg, output, repeatsArg = '20'] = process.argv.slice(2);
const datasetPath = resolve(datasetPathArg);
const repeats = Number(repeatsArg);
const saveRepeats = Number(process.env.BENCH_BROWSER_SAVE_REPEATS ?? 3);
if (!Number.isInteger(repeats) || repeats < 1 || !Number.isInteger(saveRepeats) || saveRepeats < 1) {
  throw new Error('Navigation and save repeat counts must be positive integers');
}
const dataset = JSON.parse(await readFile(join(datasetPath, 'dataset.json'), 'utf8'));
const report = { schemaVersion: 2, harness: { source: sourceIdentity(), build: await buildIdentity(),
    scriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') },
  profile: 'core', dataset, node: process.version, repeats, saveRepeats, runtimeAuthority: 'PostgreSQL-backed Core/API',
  gitRole: 'synthetic-fixture-transport-only', samples: [], phases: [], requests: [], status: 'running',
  failures: [], notMeasured: ['Native OS IME and physical-device input', 'Input-to-pixel latency beyond the recorded animation-frame opportunity',
    'React production render durations', 'Offline recovery, process crash, and long-idle acceptance'] };
const server = fork(new URL('./server.mjs', import.meta.url), [datasetPath], {
  execArgv: [...process.execArgv, '--import', 'tsx'],
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let page, browser, cdp, browserCDP, lastServerSnapshot;

function numericDelta(after, before) {
  return Object.fromEntries(Object.keys(after ?? {}).filter(key => typeof after[key] === 'number')
    .map(key => [key, after[key] - (before?.[key] ?? 0)]));
}
async function stats() {
  const next = once(server, 'message'); server.send('stats');
  return (await next)[0];
}
async function browserRuntime() {
  const { processInfo } = await browserCDP.send('SystemInfo.getProcessInfo');
  return Promise.all(processInfo.map(async info => {
    let rssBytes = null;
    try { rssBytes = Number((await readFile(`/proc/${info.id}/status`, 'utf8')).match(/^VmRSS:\s+(\d+)/m)?.[1]) * 1024; } catch { /* browser process may exit between CDP and procfs reads */ }
    return { ...info, rssBytes };
  }));
}
async function phase(name, action, details = {}) {
  const before = await stats();
  const browserBefore = browserCDP ? await browserRuntime() : [];
  const cpuBefore = process.cpuUsage(), start = performance.now();
  try {
    const value = await action();
    const ms = performance.now() - start;
    const after = await stats();
    if (after.counts.gitProcesses - before.counts.gitProcesses > 0) {
      throw new Error('PostgreSQL browser workload invoked Git at runtime');
    }
    const browserAfter = browserCDP ? await browserRuntime() : [];
    const cpuUs = process.cpuUsage(cpuBefore);
    const browserCpuMs = browserAfter.reduce((total, row) => total + Math.max(0,
      row.cpuTime - (browserBefore.find(previous => previous.id === row.id)?.cpuTime ?? row.cpuTime)) * 1000, 0);
    const sample = { name, status: 'complete', ms, appWallMs: ms, cpuUs, rssBytes: process.memoryUsage().rss,
      maxRssKiB: process.resourceUsage().maxRSS, server: { queryMetrics: numericDelta(after.counts, before.counts),
        cpuUs: { user: after.cpu.user - before.cpu.user, system: after.cpu.system - before.cpu.system },
        rssBytes: after.memory.rss, io: after.io && before.io ? numericDelta(after.io, before.io) : null },
      browserCpuMs, browserRssSumBytes: browserAfter.reduce((total, row) => total + (row.rssBytes ?? 0), 0), ...details };
    report.samples.push(sample);
    await save(output, report);
    lastServerSnapshot = after;
    return value;
  } catch (error) {
    report.failures.push({ name, status: 'failed', code: error.code, message: error.message });
    await save(output, report);
    throw error;
  }
}

async function waitForServer() {
  return new Promise((resolveReady, reject) => {
    server.once('message', message => message.ready ? resolveReady(message) : reject(new Error(message.error ?? 'PostgreSQL API server failed')));
    server.once('error', reject);
    server.once('exit', (code, signal) => reject(new Error(`PostgreSQL API server exited before ready (${code ?? signal})`)));
  });
}

try {
  const ready = await waitForServer();
  report.serverStartupMs = ready.startupMs;
  report.authFixtureSetupMs = ready.authFixtureSetupMs;
  report.browserAssetBuildMs = ready.browserAssetBuildMs;
  report.harness.browserAssets = ready.browserAssets;
  report.fixtureSetupMs = ready.fixtureSetupMs;
  report.fixture = ready.fixture;
  report.browser = undefined;
  browser = await chromium.launch({ headless: true,
    ...(process.env.CODEXIA_E2E_CHROMIUM ? { executablePath: process.env.CODEXIA_E2E_CHROMIUM } : {}) });
  report.browser = browser.version();
  browserCDP = await browser.newBrowserCDPSession();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(installBrowserProbes);
  page = await context.newPage();
  page.setDefaultTimeout(60000);
  const finiteRequests = new Set();
  const startupRequests = new WeakMap();
  let startupSample = null;
  report.startupNavigation = [];
  page.on("framenavigated", frame => {
    if (startupSample && frame === page.mainFrame()) report.startupNavigation.push({
      sample: startupSample, at: performance.now(), path: new URL(frame.url()).pathname,
    });
  });
  let lastFiniteEvent = performance.now();
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    const streaming = request.resourceType() === 'eventsource' || request.resourceType() === 'websocket' ||
      (request.method() === 'GET' && path.endsWith('/events')) || request.headers().accept?.includes('text/event-stream');
    const row = { start: performance.now(), method: request.method(), path, type: request.resourceType(), streaming: Boolean(streaming) };
    report.requests.push(row);
    if (startupSample && !streaming) {
      row.startupSample = startupSample;
      startupRequests.set(request, row);
    }
    if (!streaming) { finiteRequests.add(request); lastFiniteEvent = performance.now(); }
  });
  const finished = request => {
    const row = startupRequests.get(request);
    if (row) {
      row.elapsedMs = performance.now() - row.start;
      row.timing = request.timing();
      row.failed = request.failure() !== null;
    }
    if (finiteRequests.delete(request)) lastFiniteEvent = performance.now();
  };
  page.on('requestfinished', finished); page.on('requestfailed', finished);
  async function settleFiniteRequests() {
    const deadline = performance.now() + 60000;
    while (performance.now() < deadline) {
      if (!finiteRequests.size && performance.now() - lastFiniteEvent >= 500) return;
      await page.waitForTimeout(100);
    }
    const categorize = (pathname) => pathname.startsWith('/api/v1/persistence/') ? 'persistence'
      : pathname.startsWith('/api/auth/') ? 'auth'
      : pathname.startsWith('/api/jobs') ? 'jobs'
      : pathname.startsWith('/api/') ? 'other-api'
      : 'asset';
    const outstanding = [...finiteRequests].map(request => categorize(new URL(request.url()).pathname));
    const recent = report.requests.slice(-12).map(({ path, streaming }) => ({
      category: categorize(path), streaming,
    }));
    throw new Error(`Finite PostgreSQL API requests did not settle (pending=${outstanding.length},
      pendingCategories=${JSON.stringify(outstanding)}, quietForMs=${Math.round(performance.now() - lastFiniteEvent)},
      recentCategories=${JSON.stringify(recent)})`);
  }
  const base = ready.origin;
  const { signInAuthorBrowser } = await tsImport('../../tests/e2e/author-oauth-server.ts', import.meta.url);
  cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  report.network = { encodedTransferBytes: 0, completed: 0, failed: 0, cancelled: 0 };
  cdp.on('Network.loadingFinished', event => { report.network.encodedTransferBytes += event.encodedDataLength; report.network.completed++; });
  cdp.on('Network.loadingFailed', event => {
    // Replacing the selected manuscript intentionally cancels its superseded Evidence fetch.
    // Record these browser-initiated aborts without treating them as transport failures.
    if (event.canceled && event.errorText === 'net::ERR_ABORTED') report.network.cancelled++;
    else report.network.failed++;
  });
  await cdp.send('Performance.enable');
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  startupSample = 'cold';
  await phase('browser.startup.login-ready', async () => {
    await page.goto(`${base}/desktop/`);
    await page.getByRole('button', { name: 'OAuthでサインイン', exact: true }).waitFor();
  });
  await phase('browser.author.login', async () => {
    await signInAuthorBrowser(page, base, 'desktop', { continueCurrentPage: true });
  });
  startupSample = null;
  const project = ready.fixture.project;
  const scenes = ready.fixture.scenes;
  const editor = manuscriptEditor(page);
  const openScene = scene => openManuscriptScene(page, scene);
  await phase('browser.navigation.project-and-first-scene', async () => {
    await selectManuscriptProject(page, project.id);
    await openScene(scenes[0]);
  });
  report.phases.push({ name: 'browser.startup', server: await stats(),
    browser: await page.evaluate(() => structuredClone(window.__wave0)),
    cdp: await cdp.send('Performance.getMetrics'), runtime: await browserRuntime(),
    storageEstimate: await page.evaluate(() => navigator.storage.estimate()) });

  for (let index = 0; index < Math.min(3, scenes.length); index++) {
    const scene = scenes[index];
    if (index > 0) await phase('browser.navigation.scene', () => openScene(scene), { sceneId: scene.id, documentBytes: scene.bytes });
    const revisionPath = `/api/v1/persistence/projects/${project.id}/documents/${scene.id}`;
    for (let saveIndex = 0; saveIndex < saveRepeats; saveIndex++) {
      const transactionIndex = await page.evaluate(() => window.__wave0.transactions.length);
      const inputStart = await page.evaluate(() => performance.now());
      const saveResponse = page.waitForResponse(response => response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === revisionPath);
      await phase('browser.authoring.save-and-receipt', async () => {
        await editor.focus();
        await editor.press('Control+End');
        await page.keyboard.type(` Browser performance edit ${index + 1}.${saveIndex + 1}.`);
        await page.waitForFunction(startIndex => window.__wave0.transactions.slice(startIndex)
          .some(transaction => transaction.mode === 'readwrite' && transaction.durability === 'strict' && transaction.status === 'complete'), transactionIndex);
        const response = await saveResponse;
        if (!response.ok()) throw new Error(`PostgreSQL document save failed: HTTP ${response.status()}`);
        const receipt = await response.json();
        if (!receipt.revision?.id || !receipt.document?.headRevisionId) throw new Error('Document save response did not include its revision receipt');
        await expectServerSaved(page);
        return receipt;
      }, { sceneId: scene.id, documentBytes: scene.bytes, saveIndex: saveIndex + 1 });
      const end = await page.evaluate(() => performance.now());
      const snapshot = await stats();
      report.phases.push({ name: `browser.authoring.${scene.bytes}`, sceneId: scene.id, saveIndex: saveIndex + 1,
        documentBytes: scene.bytes, start: inputStart, end, server: snapshot,
        browser: await page.evaluate(() => structuredClone(window.__wave0)),
        cdp: await cdp.send('Performance.getMetrics'), runtime: await browserRuntime(),
        storageEstimate: await page.evaluate(() => navigator.storage.estimate()) });
    }
  }
  for (let index = 0; index < repeats; index++) {
    await phase('browser.navigation.repeat', () => openScene(scenes[index % Math.min(3, scenes.length)]),
      { sceneId: scenes[index % Math.min(3, scenes.length)].id, documentBytes: scenes[index % Math.min(3, scenes.length)].bytes });
  }
  await settleFiniteRequests();
  // The init script starts a fresh probe on every document navigation. Keep
  // authoring-workload metrics separate from the subsequent warm login.
  report.browserMetrics = await page.evaluate(() => structuredClone(window.__wave0));
  startupSample = 'warm';
  await phase('browser.startup.warm-login-ready', async () => {
    await page.goto(`${base}/desktop/`);
    await page.getByRole('button', { name: 'OAuthでサインイン', exact: true }).waitFor();
  });
  await phase('browser.author.warm-login', async () => {
    await signInAuthorBrowser(page, base, 'desktop', { continueCurrentPage: true });
  });
  startupSample = null;
  await settleFiniteRequests();
  report.storageEstimate = await page.evaluate(() => navigator.storage.estimate());
  report.warmLoginBrowserMetrics = await page.evaluate(() => structuredClone(window.__wave0));
  report.server = await stats();
  if (report.server.counts.gitProcesses > 0) throw new Error('PostgreSQL browser workload invoked Git at runtime');
  report.browserRuntime = await browserRuntime();
  report.cdpMetrics = await cdp.send('Performance.getMetrics');
  const cpu = await cdp.send('Profiler.stop');
  await writeFile(`${output}.cpuprofile`, JSON.stringify(cpu.profile));
  report.summaries = Object.fromEntries([...new Set(report.samples.map(sample => sample.name))].map(name =>
    [name, distribution(report.samples.filter(sample => sample.name === name && sample.status === 'complete').map(sample => sample.appWallMs))]));
  report.status = 'complete';
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, stack: error.stack };
  if (page && !page.isClosed()) {
    if (report.browserMetrics === undefined) {
      report.browserMetrics = await page.evaluate(() => structuredClone(window.__wave0)).catch(() => null);
    } else {
      report.warmLoginBrowserMetrics = await page.evaluate(() => structuredClone(window.__wave0)).catch(() => null);
    }
    report.server = await stats().catch(() => null);
    if (cdp) {
      try { const { profile } = await cdp.send('Profiler.stop'); await writeFile(`${output}.cpuprofile`, JSON.stringify(profile)); } catch { /* browser may already be closed */ }
    }
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server.connected) { const exited = once(server, 'exit'); server.send('stop'); await exited; }
  await save(output, report);
}
