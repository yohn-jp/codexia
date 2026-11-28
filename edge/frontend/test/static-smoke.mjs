import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { assertFrontendOAuthConfigIdentity, readFrontendOAuthConfig } from '../../../scripts/build/frontend/oauth-config.mjs';
import { inspectHtml } from '../../../scripts/shared/html-document.mjs';

const identity = JSON.parse(await readFile('app/dist/desktop/update-identity.json', 'utf8'));
assertFrontendOAuthConfigIdentity(identity, process.env);
const port = 18765;
const base = `http://127.0.0.1:${port}`;
const child = spawn(
  'edge/frontend/node_modules/.bin/wrangler',
  ['dev', '--config', 'edge/frontend/wrangler.jsonc', '--local', '--ip', '127.0.0.1', '--port', String(port)],
  { stdio: 'inherit' },
);
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(500);
  }
  assert.ok(ready, 'Wrangler static asset server did not become ready');
  const basePolicy = (await fetch(base + '/')).headers.get('content-security-policy');
  for (const [path, prefix] of [
    ['/?utm_source=smoke', '/assets/'],
    ['/desktop', '/desktop/assets/'],
    ['/desktop/projects/a/scenes/b?x=1', '/desktop/assets/'],
    ['/r/story/123e4567-e89b-12d3-a456-426614174000/reader', '/assets/'],
    ['/console', '/desktop/assets/'],
    ['/console/setup', '/desktop/assets/'],
    ['/console/setup/', '/desktop/assets/'],
    ['/console/security/', '/desktop/assets/'],
    ['/console/backups/history', '/desktop/assets/'],
  ]) {
    const response = await fetch(base + path, { redirect: 'manual' });
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const policy = response.headers.get('content-security-policy');
    assert.match(policy ?? '', /script-src 'self'/);
    assert.equal(policy, path.startsWith('/desktop') ? `${basePolicy}; img-src 'self' data:` : basePolicy, path);
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000', `${path} host-only HSTS`);
    const html = await response.text();
    const js = inspectHtml(html).scripts.find(src => /\.js(?:\?|$)/iu.test(src));
    assert.ok(js?.startsWith(prefix), `${path} script path: ${js}`);
    const script = await fetch(base + js);
    assert.equal(script.status, 200, js);
    assert.match(script.headers.get('content-type') ?? '', /javascript/);
    assert.ok((await script.text()).length > 100);
  }
  for (const path of [
    '/assets/does-not-exist.js',
    '/desktop/assets/missing.js',
    '/unknown',
    '/console/unknown',
    '/api/login',
    '/mobile',
    '/mobile/',
    '/mobile/settings/',
    '/mobile/index.html',
    '/mobile/assets/missing.js',
  ])
    assert.equal((await fetch(base + path, { redirect: 'manual' })).status, 404, path);
  // Exercise real browser module loading under the deployed static CSP.
  // The setup status fixture models pending enrollment. Other routes must
  // render the explicit API-unavailable state without a real API proxy.
  const systemChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const browser = await chromium.launch({
    headless: true,
    ...(systemChromium ? { executablePath: systemChromium, args: ['--no-sandbox'] } : {}),
  });
  // A production-configured bundle validates the browser's origin before
  // probing the API. Serve this origin entirely from the local Wrangler
  // process so the real signed-out/offline path runs without production I/O.
  const oauth = readFrontendOAuthConfig();
  const origin = oauth ? new URL(oauth.desktopRedirectUri).origin : base;
  const context = await browser.newContext({ serviceWorkers: 'block' });
  if (origin !== base) {
    await context.route(origin + '/**', async route => {
      const request = new URL(route.request().url());
      const local = new URL(base);
      local.pathname = request.pathname;
      local.search = request.search;
      const response = await route.fetch({ url: local.href, maxRedirects: 0 });
      await route.fulfill({ response });
    });
  }
  try {
    for (const [path, heading] of [
      ['/?utm_source=smoke', '執筆画面を選ぶ'],
      ['/desktop', 'PostgreSQLへ接続できません'],
      ['/console/security', '管理コンソールを利用できません'],
      ['/console/backups/history', '管理コンソールを利用できません'],
      ['/console/setup', '初回所有者登録'],
    ]) {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        if (path === '/console/setup')
          await page.route(`${origin}/api/auth/codexia/setup/status`, route => route.fulfill({ json: { state: 'setup-pending' } }));
        await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: heading, exact: true }).waitFor({ timeout: 20000 });
        if (path === '/console/setup') await page.getByLabel('初期登録キー').waitFor({ timeout: 20000 });
        if (path === '/desktop') {
          const width = await page.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const preview = new Image();
            preview.src = canvas.toDataURL('image/png');
            await preview.decode();
            return preview.naturalWidth;
          });
          assert.equal(width, 1, 'Desktop CSP must allow locally attached scratch image previews');
        }
        assert.deepEqual(errors, [], `${path} browser exceptions`);
      } finally {
        await page.close();
      }
    }
    const ownerPage = await context.newPage();
    await ownerPage.setViewportSize({ width: 320, height: 720 });
    try {
      await ownerPage.route(`${origin}/api/auth/codexia/owner-session`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: '{"authenticated":true}' }),
      );
      await ownerPage.goto(`${origin}/console/`, { waitUntil: 'domcontentloaded' });
      await ownerPage.getByRole('heading', { name: '管理コンソール', exact: true }).waitFor({ timeout: 20000 });
      const navigation = ownerPage.getByRole('navigation', { name: '管理コンソール' });
      assert.equal(await navigation.getByRole('link', { name: 'セキュリティ' }).getAttribute('href'), '/console/security');
      assert.equal(
        await ownerPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
        true,
        'console must reflow at 320 CSS px',
      );
      await ownerPage.keyboard.press('Tab');
      await ownerPage.keyboard.press('Tab');
      await ownerPage.keyboard.press('Tab');
      assert.equal(
        await ownerPage.evaluate(() => document.activeElement?.getAttribute('aria-current')),
        'page',
        'keyboard order reaches the current console navigation item',
      );
    } finally {
      await ownerPage.close();
    }
  } finally {
    await browser.close();
  }
  console.log('Static-only Wrangler serving and browser entrypoints verified');
} finally {
  child.kill('SIGTERM');
}
