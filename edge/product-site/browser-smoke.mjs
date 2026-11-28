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
const child = spawn('edge/frontend/node_modules/.bin/wrangler',
  ['dev', '--config', 'edge/product-site/wrangler.jsonc', '--local', '--ip', '127.0.0.1', '--port', '18766'],
  { stdio: 'inherit' });
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
  assert.match(await response.text(), new RegExp('<meta name="codexia-source" content="' + sha + '">'));
  const slash = await fetch(base + '/codexia', { redirect: 'manual' });
  assert.ok([301,302,307,308].includes(slash.status), 'Canonical slash redirect');
  assert.equal(new URL(slash.headers.get('location'), base).pathname, '/codexia/');
  for (const route of ['/codexia/no-such.js', '/other-product/', '/']) {
    assert.equal((await fetch(base + route, { redirect: 'manual' })).status, 404, route);
  }
  for (const file of ['site.css','site.js','favicon.svg']) {
    const asset = await fetch(site + file);
    assert.equal(asset.status, 200, file);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), await readFile('edge/product-site/dist/codexia/' + file));
  }

  browser = await chromium.launch({ headless: true });
  const viewports = [
    ['desktop',1440,900,'no-preference'],
    ['laptop',1024,768,'no-preference'],
    ['reflow',720,900,'no-preference'],
    ['mobile',390,844,'no-preference'],
    ['small',320,720,'no-preference'],
    ['reduced-desktop',1440,900,'reduce'],
    ['reduced-mobile',390,844,'reduce'],
  ];

  for (const [name,width,height,reducedMotion] of viewports) {
    const context = await browser.newContext({ viewport: { width,height }, reducedMotion });
    const page = await context.newPage();
    const errors = [];
    const external = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => { if (!request.url().startsWith(base + '/')) external.push(request.url()); });
    const noOverflow = async label => assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      name + ': ' + label + ' horizontal overflow');

    try {
      await page.goto(site, { waitUntil:'load' });
      await page.locator('h1').waitFor();
      assert.equal(await page.locator('meta[name=codexia-source]').getAttribute('content'), sha);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.className), 'skip');
      await page.evaluate(() => document.activeElement?.blur());
      assert.match(await page.locator('h1').innerText(), /物語の全体を/);
      assert.equal(await page.locator('button[data-mode]').count(), 3);
      assert.equal(await page.locator('button[data-scene]').count(), 3);
      assert.equal(await page.locator('button[data-decision]').count(), 3);
      await noOverflow('hero');
      await page.screenshot({path:path.join(evidence,name+'-hero.png'),animations:'disabled'});
      if (['desktop','mobile','small'].includes(name)) {
        await page.screenshot({path:path.join(evidence,name+'-full-page.png'),fullPage:true,animations:'disabled'});
      }
      await page.locator('.product-frame').screenshot({path:path.join(evidence,name+'-workspace.png'),animations:'disabled'});

      await page.locator('button[data-mode=knowledge]').click();
      assert.equal(await page.locator('button[data-mode=knowledge]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.inspector-content[data-panel=knowledge]').isVisible(), true);
      assert.equal(await page.locator('.inspector-content[data-panel=write]').isVisible(), false);
      assert.match(await page.locator('.inspector-content[data-panel=knowledge]').innerText(), /左手/);
      await page.locator('.product-frame').screenshot({path:path.join(evidence,name+'-knowledge.png'),animations:'disabled'});

      await page.locator('button[data-mode=review]').click();
      assert.equal(await page.locator('button[data-mode=review]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.inspector-content[data-panel=review]').isVisible(), true);
      await page.locator('button[data-mode=write]').click();

      await page.locator('button[data-scene="4"]').click();
      assert.equal(await page.locator('#chapter-title').textContent(), '閉ざされた書架');
      assert.equal(await page.locator('button[data-scene="4"]').getAttribute('aria-pressed'), 'true');
      await page.locator('button[data-scene="3"]').click();
      assert.equal(await page.locator('#chapter-title').textContent(), '硝子窓の降灰');
      assert.equal(await page.locator('#hand').textContent(), '右手');

      await page.locator('button[data-decision="approved"]').click();
      assert.equal(await page.locator('#hand').textContent(), '左手');
      assert.equal(await page.locator('button[data-decision="approved"]').getAttribute('aria-pressed'), 'true');
      assert.match(await page.locator('#decision-status').textContent(), /提案を採用/);
      await page.locator('.review').screenshot({path:path.join(evidence,name+'-decision.png'),animations:'disabled'});
      await page.locator('button[data-decision="rejected"]').click();
      assert.equal(await page.locator('#hand').textContent(), '右手');
      assert.equal(await page.locator('button[data-decision="rejected"]').getAttribute('aria-pressed'), 'true');
      await page.locator('button[data-decision="pending"]').click();
      assert.equal(await page.locator('button[data-decision="pending"]').getAttribute('aria-pressed'), 'true');
      assert.match(await page.locator('#decision-status').textContent(), /未決定/);
      await page.reload({waitUntil:'load'});
      assert.equal(await page.locator('#hand').textContent(), '右手', 'Concept must not persist state');

      // Typography and responsive checks are read from the rendered CSS, not source-string guesses.
      const metrics = await page.evaluate(() => {
        const size = selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
        const buttons = [...document.querySelectorAll('.mode')];
        return {
          body:size('body'), lead:size('.hero-desc'), manuscript:size('.manuscript'),
          modeHeights:buttons.map(button=>button.getBoundingClientRect().height),
          scrollWidth:document.documentElement.scrollWidth,
          clientWidth:document.documentElement.clientWidth,
          source:document.querySelector('meta[name=codexia-source]').content,
        };
      });
      assert.ok(metrics.body >= 16 && metrics.lead >= 16, name + ': body legibility');
      assert.ok(metrics.manuscript >= 13, name + ': demo manuscript legibility');
      assert.ok(metrics.modeHeights.every(v=>v>=44), name + ': demo touch targets');
      await noOverflow('after actions');
      assert.deepEqual(errors, [], name + ': browser exceptions');
      assert.deepEqual(external, [], name + ': unexpected external traffic');
      results.push({name,width,height,reducedMotion,status:'pass',metrics});
    } finally {
      await context.close();
    }
  }

  const touch = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  try {
    const page = await touch.newPage();
    await page.goto(site,{waitUntil:'load'});
    await page.locator('button[data-mode=knowledge]').tap();
    assert.equal(await page.locator('.inspector-content[data-panel=knowledge]').isVisible(), true);
    await page.locator('button[data-scene="4"]').tap();
    assert.equal(await page.locator('#chapter-title').textContent(), '閉ざされた書架');
    await page.locator('button[data-scene="3"]').tap();
    await page.locator('button[data-decision="approved"]').tap();
    assert.equal(await page.locator('#hand').textContent(), '左手');
    await page.locator('.mobile-menu summary').tap();
    assert.equal(await page.locator('.mobile-menu').getAttribute('open'), '');
    await page.locator('.mobile-menu nav a[href="#workflow"]').tap();
    assert.equal(await page.locator('.mobile-menu').getAttribute('open'), null);
    results.push({name:'touch-mobile',status:'pass'});
  } finally { await touch.close(); }

  const noJs = await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});
  try {
    const page = await noJs.newPage();
    await page.goto(site);
    await page.locator('h1').waitFor();
    assert.equal(await page.locator('button[data-mode=knowledge]').isDisabled(), true);
    assert.equal(await page.locator('.manuscript').isVisible(), true);
    assert.equal(await page.locator('noscript .nojs').isVisible(), true);
    await page.screenshot({path:path.join(evidence,'no-js.png'),animations:'disabled'});
    results.push({name:'no-js',status:'pass'});
  } finally { await noJs.close(); }
} finally {
  await writeFile(path.join(evidence,'report.json'),JSON.stringify({sha,results},null,2)+'\n');
  if (browser) await browser.close();
  child.kill('SIGTERM');
}
console.log('Product site: exact source, static delivery, desktop/mobile/reduced-motion/touch and no-JS assertions passed.');
