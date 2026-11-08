import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, dispatch, type Env } from "../src/index.ts";

const request = (path: string, method = "GET") => new Request(`https://codexia.example.invalid${path}`, { method });

test("only known Codexia UI shells and supported assets are served", () => {
  assert.deepEqual(classify(request("/")), { kind: "index", assetPath: "/index.html", reader: false });
  assert.deepEqual(classify(request("/desktop/projects/work/scenes/scene-1")), {
    kind: "index", assetPath: "/desktop/index.html", reader: false,
  });
  assert.deepEqual(classify(request("/mobile/settings/")), {
    kind: "index", assetPath: "/mobile/index.html", reader: false,
  });
  assert.deepEqual(classify(request("/r/story/123/reader")), {
    kind: "index", assetPath: "/index.html", reader: true,
  });
  assert.deepEqual(classify(request("/desktop/assets/main-a1b2c3d4.js")), { kind: "asset" });
  assert.deepEqual(classify(request("/assets/missing.js")), { kind: "asset" });
});

test("API, mutation, unknown and unsafe paths fail closed at the Worker", () => {
  for (const item of [
    request("/api/login"), request("/api/projects"), request("/unknown"),
    request("/assets/%2e%2e/api.js"), request("/desktop/projects/a%2f..%2fapi"),
    request("/", "POST"), new Request("http://codexia.example.invalid/"),
  ]) {
    assert.deepEqual(classify(item), { kind: "not-found" });
  }
});

test("HTML gets a per-response style nonce and the API security policy", async () => {
  const fetched: string[] = [];
  const env: Env = { ASSETS: { fetch: async (assetRequest) => {
    fetched.push(new URL(assetRequest.url).pathname);
    return new Response('<meta name="codexia-style-nonce" content="__CODEXIA_STYLE_NONCE__">', {
      headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"build"' },
    });
  } } };

  const response = await dispatch(request("/desktop/projects/work"), env);
  const html = await response.text();
  const nonce = html.match(/content="([A-Za-z0-9+/=]+)"/u)?.[1];
  assert.ok(nonce);
  assert.deepEqual(fetched, ["/desktop/index.html"]);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("etag"), null);
  assert.ok((response.headers.get("content-security-policy") ?? "").includes(`\'nonce-${nonce}\'`));
  assert.ok((response.headers.get("content-security-policy") ?? "").includes("style-src-attr 'unsafe-inline'"));
});

test("API requests never reach the static asset binding", async () => {
  let fetchCount = 0;
  const response = await dispatch(request("/api/login", "POST"), {
    ASSETS: { fetch: async () => { fetchCount += 1; return new Response("unexpected"); } },
  });
  assert.equal(response.status, 404);
  assert.equal(fetchCount, 0);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("missing asset requests stay 404 instead of returning the app shell", async () => {
  const response = await dispatch(request("/assets/missing.js"), {
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
  });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "missing");
});
