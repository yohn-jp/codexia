import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/u);
const dist = new URL('./dist/', import.meta.url);
const config = JSON.parse(await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));
assert.equal(config.name, 'codexia-product-site');
assert.equal(config.workers_dev, false);
assert.equal(config.preview_urls, false);
assert.equal(config.main, undefined);
assert.equal(config.route, undefined);
assert.equal(config.routes, undefined);
assert.equal(config.assets.directory, './dist');
assert.equal(config.assets.html_handling, 'force-trailing-slash');
assert.equal(config.assets.not_found_handling, 'none');
assert.deepEqual((await readdir(dist)).sort(), ['_headers', 'codexia']);
assert.deepEqual((await readdir(new URL('codexia/', dist))).sort(), ['favicon.svg', 'index.html', 'site.css', 'site.js']);
const html = await readFile(new URL('codexia/index.html', dist), 'utf8');
assert.ok(html.includes('<meta name="codexia-source" content="' + sha + '">'));
assert.ok(html.includes('href="https://products.yohn.jp/codexia/"'));
for (const id of ['experience','workflow','principles','platform']) {
  assert.ok(html.includes('id="' + id + '"'), 'Required product explanation: ' + id);
}
assert.equal((html.match(/data-mode="(?:write|knowledge|review)"/gu) ?? []).length, 3);
assert.equal((html.match(/data-decision="(?:approved|rejected|pending)"/gu) ?? []).length, 3);
assert.equal((html.match(/<script\b/gu) ?? []).length, 1);
assert.ok(html.includes('<script type="module" src="./site.js"></script>'));
assert.ok(html.includes('href="./site.css"'));
assert.ok(html.includes('href="./favicon.svg"'));
assert.ok(!html.includes('__SOURCE_SHA__'));
assert.ok(!/<(?:script|link)\b[^>]*(?:src|href)="https?:\/\//gu.test(html.replace(/<link rel="canonical"[^>]*>/u, '')));
const headers = await readFile(new URL('_headers', dist), 'utf8');
assert.ok(headers.includes("script-src 'self'"));
assert.ok(headers.includes("connect-src 'none'"));
console.log('Static product site route boundary, identity, and asset manifest verified.');
