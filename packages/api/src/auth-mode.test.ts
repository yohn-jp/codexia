import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveBetterAuthOidcSettings } from "./auth-mode.js";

test("Better Auth OIDC provider settings may be omitted as one tuple", () => {
  assert.deepEqual(resolveBetterAuthOidcSettings({}), {});
  assert.deepEqual(resolveBetterAuthOidcSettings({
    oidcIssuer: "https://id.example.test",
    oidcClientId: "codexia",
    oidcClientSecret: "secret",
  }), {
    oidcIssuer: "https://id.example.test",
    oidcClientId: "codexia",
    oidcClientSecret: "secret",
  });
});

test("partial Better Auth OIDC provider settings fail closed", () => {
  for (const values of [
    { oidcIssuer: "https://id.example.test" },
    { oidcClientId: "codexia" },
    { oidcClientSecret: "secret" },
    { oidcIssuer: "https://id.example.test", oidcClientId: "codexia" },
    { oidcIssuer: "https://id.example.test", oidcClientSecret: "secret" },
    { oidcClientId: "codexia", oidcClientSecret: "secret" },
  ]) {
    assert.throws(() => resolveBetterAuthOidcSettings(values), /settings require .* together/u);
  }
});

test("standalone startup rejects retired credentials without connecting to PostgreSQL", () => {
  const server = new URL("./server.js", import.meta.url);
  for (const [settings, expectedError] of [
    [{ CODEXIA_AUTH_MODE: "token" }, /CODEXIA_AUTH_MODE must be better-auth/u],
    [{ CODEXIA_AUTH_TOKEN: "retired-fixture-value" }, /Standalone authentication supports only Better Auth settings/u],
    [{ CODEXIA_BROWSER_AUTH: "cloudflare-access" }, /Standalone authentication supports only Better Auth settings/u],
    [{}, /Standalone Better Auth requires AUTH_DATABASE_URL/u],
  ] as const) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { start } from "${server.href}"; await start()`], {
      env: { ...settings }, encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, expectedError);
  }
});
