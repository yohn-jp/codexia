import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { ownerSetupWranglerConfig, stageOwnerSetupAssets } from '../../../scripts/build/frontend/owner-setup-assets.mjs';

const directory = await mkdtemp(join(tmpdir(), 'codexia-owner-setup-browser-'));
const assets = join(directory, 'assets');
const config = join(directory, 'wrangler.json');
const port = 18767;
const origin = `http://127.0.0.1:${port}`;
let worker;
try {
  await stageOwnerSetupAssets('app/dist', assets);
  await writeFile(config, JSON.stringify(ownerSetupWranglerConfig(assets)));
  worker = spawn(
    'edge/frontend/node_modules/.bin/wrangler',
    ['dev', '--config', config, '--local', '--ip', '127.0.0.1', '--port', String(port)],
    { stdio: 'inherit' },
  );
  let ready = false;
  for (let attempt = 0; attempt < 60 && worker.exitCode === null; attempt++) {
    try {
      ready = (await fetch(origin + '/console/setup', { redirect: 'manual' })).ok;
    } catch {
      /* starting */
    }
    if (ready) break;
    await delay(500);
  }
  assert.ok(ready, 'Isolated setup asset server did not become ready');
  for (const path of [
    '/',
    '/desktop',
    '/console',
    '/console/security',
    '/oauth/login',
    '/api/projects',
    '/mcp',
    '/api/auth/oauth2/token',
    '/console/setup/assets/unknown.js',
  ]) {
    assert.equal((await fetch(origin + path, { redirect: 'manual' })).status, 404, path);
  }
  const entry = await fetch(origin + '/console/setup/');
  assert.equal(entry.status, 200);
  assert.equal(entry.headers.get('cache-control'), 'no-store');
  assert.match(entry.headers.get('content-security-policy'), /script-src 'self'; style-src 'self'/u);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath, args: ['--no-sandbox'] } : {}) });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // The existing Passkey acceptance fixture owns the real API and database.
    // Only model this edge fixture's same-origin tunnel relay for UI startup.
    await page.route(origin + '/api/auth/codexia/setup/status', route => route.fulfill({ json: { state: 'setup-pending' } }));
    await page.goto(origin + '/console/setup', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '初回所有者登録', exact: true }).waitFor();
    await page.getByLabel('初期登録キー').waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
} finally {
  if (worker?.exitCode === null && worker.kill('SIGTERM')) await once(worker, 'exit');
  await rm(directory, { recursive: true, force: true });
}
