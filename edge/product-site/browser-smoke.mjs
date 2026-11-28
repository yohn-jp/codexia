import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const sha = process.env.SOURCE_SHA;
assert.match(sha ?? '', /^[a-f0-9]{40}$/u);
const evidence = path.resolve(process.env.PRODUCT_SITE_EVIDENCE ?? 'test-results/product-site');
await mkdir(evidence, { recursive: true });
const base = 'http://127.0.0.1:18766';
const site = base + '/codexia/';
const child = spawn('edge/frontend/node_modules/.bin/wrangler', ['dev', '--config', 'edge/product-site/wrangler.jsonc', '--local', '--ip', '127.0.0.1', '--port', '18766'], { stdio: 'inherit' });
let launchError;
child.on('error', error => { launchError = error; });
const results = [];
let browser;
try {
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error('Wrangler exited before readiness: ' + child.exitCode);
    const response = await fetch(site, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response?.ok) { ready = true; break; }
    await delay(200);
  }
  assert.ok(ready, 'Wrangler did not become ready');
  const response = await fetch(site, { redirect: 'manual' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy') ?? '', /script-src 'self'/u);
  assert.match(response.headers.get('content-security-policy') ?? '', /connect-src 'none'/u);
  assert.ok((await response.text()).includes('<meta name="codexia-source" content="' + sha + '">'));
  const slash = await fetch(base + '/codexia', { redirect: 'manual' });
  assert.ok([301, 302, 307, 308].includes(slash.status), 'Canonical slash redirect');
  assert.equal(new URL(slash.headers.get('location'), base).pathname, '/codexia/');
  for (const route of ['/codexia/no-such.js', '/other-product/', '/']) {
    assert.equal((await fetch(base + route, { redirect: 'manual' })).status, 404, route);
  }
  for (const file of ['site.css', 'site.js', 'favicon.svg']) {
    const asset = await fetch(site + file);
    assert.equal(asset.status, 200, file);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), await readFile('edge/product-site/dist/codexia/' + file));
  }
  browser = await chromium.launch({ headless: true });
  for (const [name, width, height, reducedMotion] of [
    ['desktop', 1440, 900, 'no-preference'],
    ['tablet', 1024, 768, 'no-preference'],
    ['reflow', 720, 900, 'no-preference'],
    ['mobile', 390, 844, 'no-preference'],
    ['small', 320, 720, 'no-preference'],
    ['reduced', 1440, 900, 'reduce'],
    ['reduced-mobile', 390, 844, 'reduce'],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
    const page = await context.newPage();
    const errors = [];
    const external = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => { if (!request.url().startsWith(base + '/')) external.push(request.url()); });
    const noOverflow = async label => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), name + ': ' + label + ' horizontal overflow');
    async function act(n) {
      await page.locator('.chapter-nav a[href="#act-' + n + '"]').click();
      await page.waitForFunction(number => document.querySelector('.chapter-nav a[href="#act-' + number + '"]').getAttribute('aria-current') === 'step', n);
      assert.equal(await page.locator('.stage').getAttribute('data-act'), String(n));
      assert.match(await page.locator('#stage-act').textContent(), new RegExp('ACT ' + ['I', 'II', 'III', 'IV', 'V'][n - 1] + ' /'));
      await noOverflow('act ' + n);
    }
    try {
      await page.goto(site, { waitUntil: 'load' });
      await page.locator('h1').waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('.stage').getAttribute('data-act'), '1', name + ': opening must remain Act I');
      assert.equal(await page.locator('meta[name=codexia-source]').getAttribute('content'), sha);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.className), 'skip');
      await page.screenshot({ path: path.join(evidence, name + '-skip-focus.png'), animations: 'disabled' });
      // A focus-state capture is not representative of the unfocused landing page.
      await page.evaluate(() => document.activeElement?.blur());
      await noOverflow('hero');
      // Site-specific visual acceptance: primary Japanese content remains readable
      // and all five chapter targets remain operable at narrow viewports.
      const legibility = await page.evaluate(() => {
        const size = selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
        const navWidths = [...document.querySelectorAll('.chapter-nav a')].map(el => el.getBoundingClientRect().width);
        return { leadFont: size('.lead'), manuscriptFont: size('.manuscript'), navWidths,
          semanticChapterWords: [...document.querySelectorAll('.chapter-word')].map(el => el.textContent) };
      });
      assert.ok(legibility.leadFont >= 16, name + ': lead copy must be >=16 CSS px');
      assert.ok(legibility.manuscriptFont >= 10.5, name + ': illustrated manuscript must remain legible');
      assert.ok(legibility.navWidths.every(w => w >= 44), name + ': chapter target width >=44 CSS px');
      assert.deepEqual(legibility.semanticChapterWords, ['執筆','構造','根拠','採否','所有']);
      assert.equal(await page.locator('.reference-line a').count(), 4);
      await page.screenshot({ path: path.join(evidence, name + '-hero.png'), animations: 'disabled' });
      await page.locator('#light-toggle').click();
      assert.equal(await page.locator('html').getAttribute('data-room'), 'daylight');
      await page.screenshot({ path: path.join(evidence, name + '-daylight.png'), animations: 'disabled' });
      await page.locator('#light-toggle').click();
      await act(2);
      await page.screenshot({ path: path.join(evidence, name + '-outline.png'), animations: 'disabled' });
      await act(3);
      await page.screenshot({ path: path.join(evidence, name + '-atlas-intro.png'), animations: 'disabled' });
      await page.locator('button[data-atlas=scar]').click();
      assert.equal(await page.locator('.stage').getAttribute('data-atlas-selection'), 'scar');
      assert.equal(await page.locator('#atlas-title').textContent(), '古傷の左右');
      assert.match(await page.locator('#atlas-quote').textContent(), /左手/u);
      await page.screenshot({ path: path.join(evidence, name + '-atlas.png'), animations: 'disabled' });
      await act(4);
      await page.screenshot({ path: path.join(evidence, name + '-decision-intro.png'), animations: 'disabled' });
      await page.locator('button[data-decision=approved]').click();
      assert.equal(await page.locator('#stage-hand').textContent(), '左手');
      assert.match(await page.locator('#edition-result').textContent(), /改稿版（左手）/u);
      assert.equal(await page.locator('button[data-decision=approved]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('button[data-decision=rejected]').getAttribute('aria-pressed'), 'false');
      await page.locator('button[data-decision=rejected]').click();
      assert.equal(await page.locator('#stage-hand').textContent(), '右手');
      assert.match(await page.locator('#edition-result').textContent(), /原文保持（右手）/u);
      assert.equal(await page.locator('button[data-decision=rejected]').getAttribute('aria-pressed'), 'true');
      await page.locator('button[data-decision=pending]').click();
      assert.match(await page.locator('#edition-result').textContent(), /採否未決定/u);
      assert.equal(await page.locator('button[data-decision=pending]').getAttribute('aria-pressed'), 'true');
      await page.locator('button[data-decision=approved]').click();
      await page.screenshot({ path: path.join(evidence, name + '-decision.png'), animations: 'disabled' });
      await act(5);
      assert.equal(await page.locator('#book-edition').textContent(), '改稿版');
      if (reducedMotion === 'reduce') {
        assert.equal(await page.locator('.stage').evaluate(el => el.style.getPropertyValue('--binding')), '1.000');
      }
      if (reducedMotion !== 'reduce') {
        await page.locator('#rotate-right').click();
        assert.equal(await page.locator('.stage').evaluate(el => el.style.getPropertyValue('--rotation')), '12deg');
        await page.locator('#rotate-reset').click();
        assert.equal(await page.locator('.stage').evaluate(el => el.style.getPropertyValue('--rotation')), '0deg');
      }
      await page.screenshot({ path: path.join(evidence, name + '-book.png'), animations: 'disabled' });
      await act(1);
      // A reverse jump must preserve the explicit author decision.
      assert.equal(await page.locator('#stage-hand').textContent(), '左手');
      if (reducedMotion === 'reduce') {
        assert.equal(await page.locator('.stage').getAttribute('data-act'), '1');
        assert.equal(await page.locator('.stage').evaluate(el => getComputedStyle(el).position), 'sticky');
      }
      const frame = await page.evaluate(async () => {
        const stage = document.querySelector('.stage');
        const samples = [];
        let previous = performance.now();
        const max = document.documentElement.scrollHeight - innerHeight;
        for (let i = 0; i <= 30; i++) {
          scrollTo(0, max * i / 30);
          await new Promise(requestAnimationFrame);
          const now = performance.now();
          samples.push(now - previous);
          previous = now;
        }
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        let mutations = 0;
        const observer = new MutationObserver(records => { mutations += records.length; });
        observer.observe(stage, { attributes: true });
        for (let i = 0; i < 12; i++) await new Promise(requestAnimationFrame);
        observer.disconnect();
        samples.sort((a,b) => a-b);
        return { samples: samples.length, medianMs: samples[Math.floor(samples.length/2)], p95Ms: samples[Math.floor(samples.length*.95)], idleStageMutations: mutations };
      });
      assert.equal(frame.idleStageMutations, 0, name + ': idle stage must not mutate continuously');
      assert.deepEqual(errors, [], name + ': browser exceptions');
      assert.deepEqual(external, [], name + ': external runtime requests');
      results.push({ name, width, height, reducedMotion, status: 'pass', legibility, frame });
    } finally {
      await context.close();
    }
  }
  // Pointer and touch are not interchangeable: exercise the public mobile
  // controls with real Chromium touch events, not only narrow mouse clicks.
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await touch.newPage();
    await page.goto(site, { waitUntil: 'load' });
    await page.locator('.chapter-nav a[href="#act-3"]').tap();
    await page.locator('button[data-atlas=scar]').tap();
    assert.equal(await page.locator('.stage').getAttribute('data-atlas-selection'), 'scar');
    await page.locator('.chapter-nav a[href="#act-4"]').tap();
    await page.locator('button[data-decision=approved]').tap();
    assert.equal(await page.locator('#stage-hand').textContent(), '左手');
    assert.equal(await page.locator('button[data-decision=approved]').getAttribute('aria-pressed'), 'true');
    await page.locator('.chapter-nav a[href="#act-5"]').tap();
    assert.equal(await page.locator('#book-edition').textContent(), '改稿版');
    await page.locator('#rotate-right').tap();
    assert.equal(await page.locator('.stage').evaluate(el => el.style.getPropertyValue('--rotation')), '12deg');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    results.push({ name: 'touch-mobile', status: 'pass' });
  } finally { await touch.close(); }
  const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  try {
    const page = await noJs.newPage();
    await page.goto(site);
    await page.locator('h1').waitFor();
    assert.equal(await page.locator('.primary').getAttribute('href'), 'https://github.com/yohn-jp/codexia');
    assert.ok(await page.locator('button[data-decision=approved]').isDisabled());
    assert.ok(await page.locator('noscript .demo-note').isVisible());
    await page.screenshot({ path: path.join(evidence, 'no-js.png'), animations: 'disabled' });
    results.push({ name: 'no-js', status: 'pass' });
  } finally { await noJs.close(); }
} finally {
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ sha, results }, null, 2) + '\n');
  if (browser) await browser.close();
  child.kill('SIGTERM');
}
console.log('Static HTTP, Chromium desktop/mobile/reduced-motion and no-JS checks passed; performance samples recorded.');
