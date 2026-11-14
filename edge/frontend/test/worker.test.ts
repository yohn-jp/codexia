import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
test("production frontend contains no executable Worker", () => {
  const config = JSON.parse(read("../wrangler.jsonc"));
  assert.equal(config.main, undefined);
  assert.deepEqual(config.assets, {directory:"../../app/dist",html_handling:"none",not_found_handling:"none"});
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
});
test("static shell proxies never catch API or missing assets", () => {
  const routes = read("../static/_redirects").trim().split("\n");
  assert.ok(routes.includes("/ /index.html 200"));
  assert.ok(routes.includes("/desktop/projects/:project/scenes/:scene /desktop/index.html 200"));
  assert.ok(routes.includes("/mobile/projects/:project/scenes/:scene /mobile/index.html 200"));
  assert.ok(routes.includes("/r/story/:project/:slug /index.html 200"));
  assert.ok(routes.every(line => !line.includes("*") && !line.startsWith("/api/") && !line.includes("/assets/") && line.endsWith(" 200")));
  const headers = read("../static/_headers");
  assert.match(headers, /script-src 'self';/u);
  assert.doesNotMatch(headers, /script-src[^;]*unsafe-inline/u);
  assert.match(headers, /X-Robots-Tag: noindex, nofollow/u);
});
