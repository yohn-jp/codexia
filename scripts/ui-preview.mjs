#!/usr/bin/env node
// Local-only visual-review harness: canonical API + disposable PostgreSQL + seeded E2E data.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifactDir = path.join(root, 'artifacts', 'ui-preview');
const requirePostgres = createRequire(new URL('../packages/persistence-postgres/package.json', import.meta.url));

export function parsePreviewArgs(argv) {
  const options = { profile: 'core', port: 4173, engine: 'auto', skipBuild: false, capture: true };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--skip-build') options.skipBuild = true;
    else if (flag === '--no-capture') options.capture = false;
    else if (['--profile', '--port', '--engine'].includes(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      if (flag === '--profile') options.profile = value;
      if (flag === '--port') options.port = Number(value);
      if (flag === '--engine') options.engine = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (!['core', 'full'].includes(options.profile)) throw new Error('--profile must be core or full');
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65533) throw new Error('--port must be 1024..65533');
  if (!['auto', 'docker', 'podman'].includes(options.engine)) throw new Error('--engine must be auto, docker or podman');
  return options;
}

export function parsePublishedPort(output) {
  const mapping = output.trim();
  const match = /^127\.0\.0\.1:(\d+)$/u.exec(mapping);
  if (!match) throw new Error(`Expected one loopback PostgreSQL port mapping; got ${JSON.stringify(mapping)}`);
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PostgreSQL host port');
  return port;
}

function invocation(command, args) {
  return command === 'pnpm'
    ? { executable: 'corepack', args: ['pnpm', ...args], shell: process.platform === 'win32' }
    : { executable: command, args, shell: false };
}

async function run(command, args, { env = process.env, inherit = false } = {}) {
  const inv = invocation(command, args);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(inv.executable, inv.args, {
      cwd: root,
      env,
      shell: inv.shell,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (!inherit) {
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    }
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${command} ${args.slice(0, 2).join(' ')} failed (${code ?? 'signal'})${inherit ? '' : `: ${[stdout.trim(), stderr.trim()].filter(Boolean).join('\n')}`}`)));
  });
}

async function engineFor(preference) {
  const candidates = preference === 'auto' ? ['docker', 'podman'] : [preference];
  for (const command of candidates) {
    try { await run(command, ['info']); return command; }
    catch { /* Try the next installed, running engine. */ }
  }
  throw new Error('Start Docker Desktop or Podman first. UI preview needs an isolated disposable PostgreSQL 17 container.');
}

async function build(profile) {
  const { createBuildCommands } = await import('./profile-package.mjs');
  const manifest = JSON.parse(await readFile(path.join(root, 'profiles', `${profile}.json`), 'utf8'));
  for (const step of createBuildCommands(profile, manifest, { includeUi: false })) {
    console.log(`Building: ${step.command} ${step.args.join(' ')}`);
    await run(step.command, step.args, { env: { ...process.env, ...step.env, CODEXIA_PROFILE: profile }, inherit: true });
  }
}

async function verifyBuild(profile) {
  await Promise.all([
    'packages/api/dist/server.js', 'packages/core/dist/index.js',
    `profiles/${profile}/generated/browser.mjs`, `profiles/${profile}/generated/server.mjs`,
  ].map(filename => readFile(path.join(root, filename))));
}

async function waitForDatabase(connectionString) {
  const { Client } = requirePostgres('pg');
  let lastError;
  for (let n = 0; n < 60; n += 1) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await delay(500);
    }
  }
  throw new Error(`Disposable PostgreSQL did not become ready: ${lastError?.message}`);
}

async function checkPreviewReady(origin) {
  const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
  if (!health.ok || (await health.json()).status !== 'ok') throw new Error('Local preview API is not ready');
  for (const mode of ['desktop', 'mobile']) {
    const page = await fetch(`${origin}/${mode}/`, { signal: AbortSignal.timeout(1500) });
    if (!page.ok || !(page.headers.get('content-type') ?? '').includes('text/html')) throw new Error(`/${mode}/ is not ready`);
  }
}

async function seedPreviewProject(fixture) {
  const origin = fixture.apiOrigin;
  const headers = { Origin: origin, Authorization: `Bearer ${await fixture.issueOwnerAccessToken()}`, 'Content-Type': 'application/json' };
  async function create(endpoint, data) {
    const response = await fetch(new URL(endpoint, origin), {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(data), redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 201) throw new Error(`Preview ${data.kind ?? 'project'} creation returned ${response.status}`);
    return response.json();
  }
  const { project } = await create('/api/v1/persistence/projects', { title: `UI Preview ${randomUUID()}` });
  const documents = `/api/v1/persistence/projects/${project.id}/documents`;
  const { document: volume } = await create(documents, { kind: 'volume', title: 'Volume One', orderKey: 'a', markdown: '' });
  const { document: chapter } = await create(documents, { kind: 'chapter', parentId: volume.id, title: 'Chapter One', orderKey: 'a', markdown: '' });
  const { document: scene } = await create(documents, {
    kind: 'scene', parentId: chapter.id, title: 'Scene One', orderKey: 'a',
    markdown: '# Scene One\n\nThe first line of the story.\nBeacon Quay appears in this scene.\n',
  });
  await create(documents, {
    kind: 'scene', parentId: chapter.id, title: 'Scene Two', orderKey: 'b',
    markdown: '# Scene Two\n\nThe second line of the story.\nA submerged brass archive waits below Lantern Harbor.\n',
  });
  return { project, scene };
}

async function captureScreenshots(baseURL, { project, scene }, signInAuthorBrowser) {
  const { chromium } = await import('@playwright/test');
  let browser;
  try {
    try { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
    catch { browser = await chromium.launch({ headless: true }); }
  } catch {
    throw new Error('Browser capture requires Chrome or Playwright Chromium. Install with: corepack pnpm exec playwright install chromium');
  }
  const htmlByMode = {};
  try {
    await mkdir(path.join(artifactDir, 'snapshots'), { recursive: true });
    for (const [mode, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      const context = await browser.newContext({ viewport: { width, height } });
      try {
        const page = await context.newPage();
        const route = `/${mode}/projects/${project.id}/scenes/${scene.id}${mode === 'mobile' ? '?view=writing' : ''}`;
        const accessToken = await signInAuthorBrowser(page, baseURL, mode, { path: route });
        await page.getByRole('textbox', { name: '本文', exact: true }).waitFor({ timeout: 20_000 });
        await page.getByRole('heading', { name: scene.title, exact: true }).waitFor({ timeout: 20_000 });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: path.join(artifactDir, 'snapshots', `${mode}.png`), fullPage: true });
        // Freeze the authenticated DOM; no bearer cookie, API access or browser script is copied.
        const html = await page.evaluate(async () => {
          const copy = document.documentElement.cloneNode(true);
          const originalLinks = [...document.querySelectorAll('link[rel="stylesheet"]')];
          const copiedLinks = [...copy.querySelectorAll('link[rel="stylesheet"]')];
          for (let i = 0; i < copiedLinks.length; i += 1) {
            const link = originalLinks[i];
            if (!link || new URL(link.href).origin !== location.origin) continue;
            const css = await (await fetch(link.href)).text();
            const style = document.createElement('style');
            style.textContent = css;
            copiedLinks[i].replaceWith(style);
          }
          copy.querySelectorAll('script,link[rel="modulepreload"],link[rel="preload"]').forEach(element => element.remove());
          const base = document.createElement('base');
          base.href = location.origin + '/';
          copy.querySelector('head')?.prepend(base);
          return '<!doctype html>\n' + copy.outerHTML;
        });
        if (html.includes(accessToken)) throw new Error(`${mode} visual snapshot unexpectedly contains an OAuth bearer`);
        await writeFile(path.join(artifactDir, 'snapshots', `${mode}.html`), html);
        htmlByMode[mode] = html;
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  return htmlByMode;
}

async function serveSnapshots(htmlByMode, baseURL, id) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    if (url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
      return;
    }
    const mode = /^\/(desktop|mobile)\/$/u.exec(url.pathname)?.[1];
    if (mode && htmlByMode[mode]) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; script-src 'none'; connect-src 'none'; form-action 'none'; object-src 'none'" }).end(htmlByMode[mode]);
      return;
    }
    // Built, uncredentialed assets only; never proxy an API or a write method.
    if (/^\/(?:desktop|mobile)\/assets\/[a-zA-Z0-9_.-]+$/u.test(url.pathname)) {
      try {
        const asset = await fetch(new URL(url.pathname, baseURL), { signal: AbortSignal.timeout(3000) });
        if (!asset.ok) throw new Error('Asset unavailable');
        response.writeHead(200, { 'content-type': asset.headers.get('content-type') ?? 'application/octet-stream' });
        response.end(Buffer.from(await asset.arrayBuffer()));
      } catch { response.writeHead(404).end(); }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, port: server.address().port };
}

async function main() {
  const options = parsePreviewArgs(process.argv.slice(2));
  // Keep the disposable preview isolated from operator API and frontend settings.
  for (const key of Object.keys(process.env)) {
    if (/^(?:CODEXIA|SCRIPTORIUM|VITE)_/iu.test(key)) delete process.env[key];
  }
  const engine = await engineFor(options.engine);
  const container = `codexia-ui-preview-${randomUUID().slice(0, 12)}`;
  const password = randomBytes(24).toString('hex');
  const databaseName = 'codexia_web_oauth_test';
  const id = randomUUID();
  const sessionFile = path.join(artifactDir, 'session.json');
  let fixture;
  let snapshotServer;
  let containerStarted = false;
  let stopRequested = false;
  const requestStop = () => { stopRequested = true; };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  try {
    // Fail early if the expected host port is already in use, before building anything.
    const { createServer: createTcpServer } = await import('node:net');
    const probe = createTcpServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(options.port, '127.0.0.1', resolve); });
    await new Promise(resolve => probe.close(resolve));
    if (!options.skipBuild) await build(options.profile);
    await verifyBuild(options.profile);
    console.log(`Starting disposable PostgreSQL 17 with ${engine}`);
    await run(engine, [
      'run', '-d', '--rm', '--name', container, '--label', 'dev.codexia.purpose=ui-preview',
      '-e', 'POSTGRES_USER=codexia', '-e', `POSTGRES_PASSWORD=${password}`,
      '-e', `POSTGRES_DB=${databaseName}`, '-p', '127.0.0.1::5432', 'postgres:17',
    ]);
    containerStarted = true;
    const databasePort = parsePublishedPort(await run(engine, ['port', container, '5432/tcp']));
    const connectionString = `postgres://codexia:${password}@127.0.0.1:${databasePort}/${databaseName}`;
    await waitForDatabase(connectionString);
    process.env.CODEXIA_AUTH_TEST_DISPOSABLE = '1';
    const { tsImport } = await import('tsx/esm/api');
    const { startAuthorBrowserFixture, signInAuthorBrowser } = await tsImport('../tests/e2e/author-oauth-server.ts', import.meta.url);
    fixture = await startAuthorBrowserFixture({ databaseUrl: connectionString, profile: options.profile, apiPort: options.port });
    const baseURL = fixture.apiOrigin;
    await checkPreviewReady(baseURL);
    const writing = await seedPreviewProject(fixture);
    console.log(`\nCodexia preview: ${baseURL}/desktop/ and ${baseURL}/mobile/`);
    console.log('Use OAuthでサインイン with the local preview identity provider.');
    if (options.capture) {
      const htmlByMode = await captureScreenshots(baseURL, writing, signInAuthorBrowser);
      ({ server: snapshotServer, port: options.snapshotPort } = await serveSnapshots(htmlByMode, baseURL, id));
      await mkdir(artifactDir, { recursive: true });
      await writeFile(sessionFile, JSON.stringify({ id, snapshotBaseURL: `http://127.0.0.1:${options.snapshotPort}` }, null, 2));
      console.log(`Frozen, authenticated visual snapshots: http://127.0.0.1:${options.snapshotPort}/desktop/ and /mobile/`);
      console.log('Run in another terminal: corepack pnpm ui:scan');
      console.log(`Screenshots: ${path.relative(root, path.join(artifactDir, 'snapshots'))}`);
    } else {
      console.log('Capture disabled; run again without --no-capture to scan authenticated UI snapshots.');
    }
    console.log('Ctrl+C stops the test server and removes the disposable PostgreSQL container/database.');
    while (!stopRequested) await delay(250);
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
    if (snapshotServer) await new Promise(resolve => snapshotServer.close(resolve));
    await rm(sessionFile, { force: true });
    try {
      await fixture?.close();
    } finally {
      if (containerStarted) await run(engine, ['stop', '--time', '3', container]).catch(error => console.error('Remove preview container manually:', container, error.message));
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`UI preview failed: ${error?.message ?? error}`); process.exitCode = 1; });
}
