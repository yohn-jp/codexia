// Visual and interaction acceptance for the generated Atlas and shared Pages assets.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? '');
  const browserPackage = process.argv[3];
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  assert.ok(browserPackage && executablePath, 'Playwright-core location and Chrome path required');
  const require = createRequire(import.meta.url);
  const { chromium } = require(resolve(browserPackage));
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
  };
  const atlasManifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const relatedPaths = [...new Set(atlasManifest.diagrams.flatMap(diagram => diagram.implementationPaths ?? []))];
  const directories = [
    ['/architecture/', root],
    ['/pages-ui/', resolve(root, '../pages-ui')],
    ['/requirements/html/', resolve(root, '../requirements/html')],
  ];
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/graph/source.json') {
        const mode = process.env.ATLAS_GRAPH_MODE ?? 'match';
        if (mode === 'unavailable') {
          res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"unavailable"}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          sourceSha: mode === 'mismatch' ? '0'.repeat(40) : atlasManifest.sourceSha,
          generator: 'graphifyy',
          mode: 'code-only',
          stats: {},
          coverage: {},
          relations: [],
          files: relatedPaths.map(path => ({ path })),
        }));
        return;
      }
      const matched = directories.find(([prefix]) => pathname.startsWith(prefix));
      if (!matched) {
        res.writeHead(404).end();
        return;
      }
      const [prefix, directory] = matched;
      const path = resolve(directory, decodeURIComponent(pathname.slice(prefix.length)) || 'index.html');
      if (!path.startsWith(directory + sep)) {
        res.writeHead(404).end();
        return;
      }
      const bytes = await readFile(path);
      res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  let browser;
  try {
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    let expectedManifestFailure = false;
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 400 &&
          (path.startsWith('/pages-ui/') || path.startsWith('/architecture/')) &&
          !(expectedManifestFailure && path === '/architecture/manifest.json')) {
        errors.push(response.status() + ' ' + path);
      }
    });
    const base = 'http://127.0.0.1:' + server.address().port + '/architecture';
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base + '/#entry-does-not-exist', { waitUntil: 'networkidle' });
    const native = page.locator('likec4-view[view-id="architecture"]');
    await native.locator('.react-flow__node').first().waitFor({ timeout: 20000 });
    assert.ok(await native.locator('.react-flow__node').count() >= 20,
      'Native system context should render its model nodes');
    const operateButton = page.getByRole('button', { name: 'LikeC4の操作画面を開く' });
    assert.ok(await operateButton.isVisible(), 'Native views need a visible interactive entry');
    await operateButton.focus();
    await page.keyboard.press('Enter');
    const nativeDialog = native.locator('dialog[open]');
    await nativeDialog.waitFor({ timeout: 10000 });
    const nativeZoomControls = nativeDialog.locator('.react-flow__controls button');
    await nativeZoomControls.first().waitFor({ timeout: 10000 });
    assert.ok(await nativeZoomControls.count() >= 3,
      'Keyboard-opened LikeC4 view should expose zoom and fit controls');
    const graphMode = nativeDialog.getByText('Graph', { exact: true });
    assert.ok(await graphMode.count() > 0, 'LikeC4 browser should expose the related graph view');
    await page.keyboard.press('Escape');
    await nativeDialog.waitFor({ state: 'hidden', timeout: 5000 });
    assert.ok(atlasManifest.diagrams.length > 0, 'Atlas manifest must contain diagrams');
    assert.equal(await page.locator('#diagram-total').textContent(), atlasManifest.diagrams.length + '件');
    assert.ok(atlasManifest.diagrams.some(item => item.id === 'screen-23'));
    assert.ok(atlasManifest.diagrams.some(item => item.id === 'admin-5'));
    assert.ok(atlasManifest.diagrams.some(item => item.id === 'first-3'));
    assert.ok(await page.locator('.cx-pages-header').isVisible(), 'Shared Pages navigation must be present');

    await page.locator('#diagram-category').selectOption('admin');
    assert.equal(await page.locator('#diagram-list .group:visible').count(), 1, 'Category selector filters to one group');
    await page.locator('#diagram-category').selectOption('all');

    await page.goto(base + '/?diagram=screen-23', { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#svg-image').getAttribute('src'), 'svg/screen-23.svg',
      'A generated specification link must open its Mermaid diagram');
    await page.locator('#svg-image:not([hidden])').waitFor();
    const longDiagram = await page.locator('#canvas').evaluate(el => ({
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
    }));
    assert.ok(longDiagram.scrollHeight > longDiagram.clientHeight, 'Long diagrams must remain vertically scrollable');
    await page.locator('#fit-diagram').click();
    const fitBounds = await page.locator('#canvas').evaluate(el => ({
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
    }));
    assert.ok(fitBounds.scrollWidth <= fitBounds.clientWidth + 2, 'Fit-all should fit the diagram width');
    assert.ok(fitBounds.scrollHeight <= fitBounds.clientHeight + 2, 'Fit-all should fit the diagram height');
    await page.locator('#zoom-reset').click();
    assert.equal(await page.locator('#zoom-value').textContent(), '100%', 'Fit-width should restore 100%');
    await page.locator('#zoom-in').click();
    assert.equal(await page.locator('#zoom-value').textContent(), '125%', 'Zoom-in should report the actual scale');
    await page.locator('#canvas').evaluate(el => {
      el.scrollLeft = el.scrollWidth;
      el.scrollTop = el.scrollHeight;
    });
    // A late zoom-position restoration must not undo a subsequent user scroll.
    await page.evaluate(() => new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const scrollAfterZoom = await page.locator('#canvas').evaluate(el => ({
      left: el.scrollLeft,
      top: el.scrollTop,
      maxLeft: el.scrollWidth - el.clientWidth,
      maxTop: el.scrollHeight - el.clientHeight,
    }));
    assert.ok(scrollAfterZoom.maxLeft > 0 && scrollAfterZoom.left > 0,
      'Zoomed diagrams must scroll horizontally: ' + JSON.stringify(scrollAfterZoom));
    assert.ok(scrollAfterZoom.maxTop > 0 && scrollAfterZoom.top > 0,
      'Zoomed diagrams must scroll vertically: ' + JSON.stringify(scrollAfterZoom));

    await page.locator('#diagram-category').selectOption('screen');
    await page.locator('#diagram-query').fill('AUTH-01');
    assert.ok(await page.locator('#diagram-list button:visible').count() > 0, 'Screen ID search should find diagrams');
    await page.locator('#diagram-list button:visible').first().focus();
    await page.keyboard.press('Enter');
    await page.locator('#svg-image:not([hidden])').waitFor();
    assert.match(new URL(page.url()).hash, /^#screen-\d+$/u);
    assert.match(await page.locator('#diagram-title').textContent(), /AUTH-01/u);
    assert.equal(await page.locator('#diagram-list button[aria-current="true"]').count(), 1);
    assert.match(await page.locator('#source-link').getAttribute('href'),
      new RegExp(atlasManifest.sourceSha + '/docs/architecture/diagrams/screen-\\d+\\.mmd#L1$', 'u'));
    const design = new URL(await page.locator('#design-link').getAttribute('href'), page.url());
    assert.match(design.pathname, /\/requirements\/html\/docs\/design\/SCREEN-STATE-ATLAS\.sdoc\.html$/u);
    assert.match(design.hash, /^#ATLAS-DIAGRAM-screen-\d+$/u);
    const designResponse = await page.request.get(design.href);
    assert.equal(designResponse.status(), 200, 'The StrictDoc detail link must resolve in assembled Pages');
    assert.match(await designResponse.text(), new RegExp('id="' + design.hash.slice(1) + '"', 'u'));
    assert.ok(await page.locator('#screen-contract a[href*="screen-catalog.json"]').count() > 0,
      'Screen IDs should link to their source contract record');
    await page.locator('#evidence-details > summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#evidence-details').evaluate(el => el.open), true,
      'Evidence disclosure must open from the keyboard');
    await page.locator('#graph-state[data-state="match"]').waitFor();
    assert.match(await page.locator('#graph-state').textContent(), /同じSHA/u);
    assert.ok(await page.locator('#implementation-evidence a').count() > 0,
      'Same-SHA source links should be available in the evidence disclosure');

    await page.locator('#diagram-query').fill('ENTRY-01');
    await page.locator('#diagram-category').selectOption('screen');
    await page.locator('#diagram-list button:visible').first().click();
    await page.locator('#implementation-evidence a').first().waitFor();
    assert.equal(await page.locator('#implementation-evidence a').first().getAttribute('href'),
      '../graph/?file=' + encodeURIComponent('app/src/launcher.tsx'));
    assert.match(await page.locator('#graph-state').textContent(), /同じSHA/u);

    await page.route('**/graph/source.json', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sourceSha: '0'.repeat(40),
        generator: 'graphifyy',
        mode: 'code-only',
        stats: {},
        coverage: {},
        relations: [],
        files: relatedPaths.map(path => ({ path })),
      }),
    }));
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#evidence-details > summary').click();
    await page.locator('#graph-state[data-state=\"mismatch\"]').waitFor();
    assert.match(await page.locator('#graph-state').textContent(), /異なるSHA|別のSHA/u);
    assert.equal(await page.locator('#implementation-evidence a').count(), 0,
      'Mismatched Graph SHA must not produce source links');
    await page.unroute('**/graph/source.json');

    await page.route('**/graph/source.json', route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{\"error\":\"unavailable\"}',
    }));
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#evidence-details > summary').click();
    await page.locator('#graph-state[data-state=\"unavailable\"]').waitFor();
    assert.match(await page.locator('#implementation-evidence').textContent(), /利用できない/u);
    await page.unroute('**/graph/source.json');

    const previousSelection = new URL(page.url()).hash;
    await page.locator('#diagram-query').fill('no-result-xyzz');
    await page.locator('#empty-results').waitFor();
    assert.equal(new URL(page.url()).hash, previousSelection, 'Empty search should preserve the selected deep link');
    assert.ok(await page.locator('#diagram-title').isVisible(), 'Empty search should keep the selected diagram in view');
    await page.locator('#clear-empty-search').click();
    assert.equal(await page.locator('#diagram-query').inputValue(), '');

    await page.route('**/svg/screen-23.svg', route => route.abort('failed'));
    await page.goto(base + '/#screen-23', { waitUntil: 'networkidle' });
    await page.locator('#loading-message').filter({ hasText: '読み込めませんでした' }).waitFor();
    assert.ok(await page.locator('#retry-diagram').isVisible(), 'Missing SVG should offer a retry');
    await page.unroute('**/svg/screen-23.svg');
    await page.locator('#retry-diagram').click();
    await page.locator('#svg-image:not([hidden])').waitFor();

    expectedManifestFailure = true;
    await page.route('**/manifest.json', route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{\"error\":\"unavailable\"}',
    }));
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.locator('#retry-load').waitFor();
    assert.match(await page.locator('#loading-message').textContent(), /再試行/u);
    await page.unroute('**/manifest.json');
    expectedManifestFailure = false;
    await page.locator('#retry-load').click();
    await page.locator('likec4-view[view-id="architecture"] .react-flow__node').first().waitFor();

    for (const [width, height] of [[768, 1024], [390, 844], [320, 800]]) {
      await page.setViewportSize({ width, height });
      await page.goto(base + '/#screen-23', { waitUntil: 'networkidle' });
      await page.locator('#svg-image:not([hidden])').waitFor();
      const viewport = await page.evaluate(() => ({
        pageWidth: document.documentElement.scrollWidth,
        catalogOpen: document.querySelector('#catalog-results').open,
        buttonHeights: [...document.querySelectorAll('#zoom-out, #zoom-in, #zoom-reset, #fit-diagram, #svg-link')]
          .map(element => element.getBoundingClientRect().height),
      }));
      assert.ok(viewport.pageWidth <= width, width + 'px viewport must not overflow horizontally');
      assert.ok(viewport.buttonHeights.every(height => height >= 44), width + 'px viewer controls must be touch-sized');
      assert.equal(viewport.catalogOpen, false, width + 'px catalog should start collapsed for diagram viewing');
      await page.locator('#catalog-summary').click();
      await page.locator('#diagram-query').fill('AUTH-01');
      await page.locator('#diagram-category').selectOption('screen');
      const searchTargetHeights = await page.evaluate(() => [
        document.querySelector('#diagram-query').getBoundingClientRect().height,
        document.querySelector('#diagram-category').getBoundingClientRect().height,
      ]);
      assert.ok(searchTargetHeights.every(height => height >= 44), width + 'px search controls must be touch-sized');
      assert.equal(await page.locator('#catalog-results').evaluate(el => el.open), true,
        width + 'px search should reveal matching diagrams');
      await page.locator('#diagram-list button:visible').first().click();
      await page.locator('#svg-image:not([hidden])').waitFor();
      await page.waitForFunction(() => document.querySelector('#diagram-title').getBoundingClientRect().top < 220);
      const selectedView = await page.evaluate(() => ({
        top: document.querySelector('#diagram-title').getBoundingClientRect().top,
        activeId: document.activeElement.id,
        catalogOpen: document.querySelector('#catalog-results').open,
      }));
      assert.ok(selectedView.top >= 0 && selectedView.top < 220, width + 'px diagram selection should scroll the viewer into view');
      assert.equal(selectedView.activeId, 'diagram-title', width + 'px selection should announce the chosen diagram');
      assert.equal(selectedView.catalogOpen, false, width + 'px selection should close the catalog');
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      await page.locator('#catalog-summary').click();
      await page.locator('#diagram-query').fill('');
      await page.locator('#diagram-category').selectOption('all');
      const enlargedCatalog = await page.evaluate(() => {
        const visible = [...document.querySelectorAll('#diagram-list .group button')]
          .filter(element => element.getBoundingClientRect().width > 0);
        return {
          pageWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          furthestRight: Math.max(0, ...visible.map(element => element.getBoundingClientRect().right)),
          inputHeight: document.querySelector('#diagram-query').getBoundingClientRect().height,
          overflowElements: [...document.querySelectorAll('body *')]
            .map(element => ({ element, rect: element.getBoundingClientRect() }))
            .filter(({ rect }) => rect.width > 0 && rect.right > window.innerWidth + 1)
            .slice(-8)
            .map(({ element, rect }) => ({
              tag: element.tagName,
              id: element.id,
              className: typeof element.className === 'string' ? element.className : '',
              right: Math.round(rect.right),
              width: Math.round(rect.width),
              text: element.textContent.trim().slice(0, 24),
            })),
        };
      });
      assert.ok(enlargedCatalog.pageWidth <= width && enlargedCatalog.furthestRight <= width + 1,
        width + 'px catalog must reflow without horizontal overflow at 200% text size (page ' +
        enlargedCatalog.pageWidth + 'px, content right ' + enlargedCatalog.furthestRight + 'px, overflow ' +
        JSON.stringify(enlargedCatalog.overflowElements) + ')');
      assert.ok(enlargedCatalog.inputHeight >= 44, width + 'px search remains touch-sized at 200% text size');
      await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).scrollBehavior), 'auto');
    const focusStyle = await page.locator('#zoom-in').evaluate(el => {
      el.focus();
      return { width: getComputedStyle(el).outlineWidth, offset: getComputedStyle(el).outlineOffset };
    });
    assert.equal(focusStyle.width, '3px');
    assert.equal(focusStyle.offset, '2px');
    const groupContrast = await page.locator('#diagram-group').evaluate(element => {
      const parse = value => (value.match(/[\d.]+/gu) ?? []).slice(0, 3).map(Number);
      const luminance = color => color.map(channel => {
        const value = channel / 255;
        return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
      }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
      let background = getComputedStyle(element).backgroundColor;
      let ancestor = element.parentElement;
      while (background === 'rgba(0, 0, 0, 0)' && ancestor) {
        background = getComputedStyle(ancestor).backgroundColor;
        ancestor = ancestor.parentElement;
      }
      const foregroundLuminance = luminance(parse(getComputedStyle(element).color));
      const backgroundLuminance = luminance(parse(background));
      return (Math.max(foregroundLuminance, backgroundLuminance) + .05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + .05);
    });
    assert.ok(groupContrast >= 4.5, 'Diagram group text should meet 4.5:1 contrast');
    assert.equal(await page.locator('.footer a').evaluate(el => getComputedStyle(el).textDecorationLine), 'underline');
    assert.deepEqual(errors, [], 'Browser reported unexpected errors');
    console.log(JSON.stringify({
      outcome: 'PASS',
      diagrams: atlasManifest.diagrams.length,
      viewportWidths: [1440, 768, 390, 320],
      categorySearch: true,
      keyboardSelection: true,
      evidenceContracts: true,
      sameShaGraphLinks: true,
      mismatchAndUnavailableStates: true,
      emptyAndRetryStates: true,
      zoomFitAndTwoAxisScroll: true,
      touchTargets: true,
      reducedMotionAndFocus: true,
      groupLabelContrast: Math.round(groupContrast * 100) / 100,
    }));
  } finally {
    await browser?.close();
    await new Promise(ok => server.close(ok));
  }
}
