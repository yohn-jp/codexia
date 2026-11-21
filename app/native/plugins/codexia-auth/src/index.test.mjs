import test from "node:test";
import assert from "node:assert/strict";
import { createNativeAuth } from "./index.mjs";
import { nativeOAuthConfig } from "./native-config.mjs";

const config = nativeOAuthConfig({
  VITE_CODEXIA_API_ORIGIN: "https://api.example.test",
  VITE_CODEXIA_OAUTH_IOS_CLIENT_ID: "ios-public",
});

test("native token bridge refuses unconfigured, insecure, and non-API request URLs", async () => {
  const auth = createNativeAuth(config);
  for (const url of [
    "https://attacker.example.test/api/session",
    "http://api.example.test/api/session",
    "https://api.example.test/private",
    "https://user:pass@api.example.test/api/session",
  ]) {
    await assert.rejects(auth.accessTokenFor(url), /Refusing to send/);
  }
});

test("native public-client configuration cannot replace the registered callback", () => {
  assert.throws(() => createNativeAuth({ ...config, redirectUri: "https://attacker.example.test/callback" }), /configuration is invalid/);
});

test("native API transport carries only the validated bearer request over its injected bridge", async () => {
  const calls = [];
  const auth = createNativeAuth(config, {
    apiRequest: async (options) => {
      calls.push(options);
      return { status: 200, headers: { "content-type": "application/json" }, body: '{"authenticated":true}' };
    },
  });
  const response = await auth.fetchRequest("https://api.example.test/api/session", {
    method: "GET",
    credentials: "omit",
    headers: { Authorization: "Bearer sample-access-token" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/api/session");
  assert.equal(calls[0].headers.authorization, "Bearer sample-access-token");
});

test("native API transport rejects ambient credentials, cookie headers, SSE, and unconfigured URLs", async () => {
  let requests = 0;
  const auth = createNativeAuth(config, {
    apiRequest: async () => {
      requests += 1;
      return { status: 204, headers: {}, body: "" };
    },
  });
  await assert.rejects(auth.fetchRequest("https://api.example.test/api/session", { credentials: "include" }), /omit ambient/);
  await assert.rejects(auth.fetchRequest("https://api.example.test/api/session", { headers: { Cookie: "session=secret" } }), /cannot send cookies/);
  await assert.rejects(auth.fetchRequest("https://api.example.test/api/jobs/events", { headers: { Accept: "text/event-stream" } }), (error) => error.code === "NATIVE_STREAM_UNAVAILABLE");
  await assert.rejects(auth.fetchRequest("https://attacker.example.test/api/session"), /unconfigured origin/);
  assert.equal(requests, 0);
});
