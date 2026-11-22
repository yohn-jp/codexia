import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
test("static shell proxies never catch API or missing assets", () => {
  const routes = read("../static/_redirects").trim().split("\n");
  assert.ok(routes.includes("/desktop/projects/:project/scenes/:scene /desktop/index.html 200"));
  assert.ok(routes.includes("/mobile/projects/:project/scenes/:scene /mobile/index.html 200"));
  assert.ok(routes.includes("/r/story/:project/:slug /index.html 200"));
  // OAuth entry points must be reachable as direct static-asset navigations,
  // then the launcher selects the corresponding page from window.location.
  assert.ok(routes.includes("/oauth/login /index.html 200"));
  assert.ok(routes.includes("/oauth/consent /index.html 200"));
  assert.ok(routes.every(line => !line.includes("*") && !line.startsWith("/api/") && !line.includes("/assets/") && line.endsWith(" 200")));
  const headers = read("../static/_headers");
  assert.doesNotMatch(headers, /script-src[^;]*unsafe-inline/u);
});
