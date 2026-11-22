import assert from "node:assert/strict";
import test from "node:test";
import { resolvePasskeyBootstrapRpId } from "./bootstrap-auth.js";

test("Passkey bootstrap uses the production auth hostname as RP ID only from a strict setup subdomain", () => {
  assert.equal(
    resolvePasskeyBootstrapRpId("https://api.codexia.example.test", "https://bootstrap.api.codexia.example.test:8443"),
    "api.codexia.example.test",
  );
  assert.throws(
    () => resolvePasskeyBootstrapRpId("https://api.codexia.example.test", "https://bootstrap.example.test:8443"),
    /strict subdomain/u,
  );
  assert.throws(
    () => resolvePasskeyBootstrapRpId("https://api.codexia.example.test", "https://api.codexia.example.test:8443"),
    /strict subdomain/u,
  );
});

test("Passkey bootstrap permits only an explicit test loopback origin override", () => {
  assert.throws(
    () => resolvePasskeyBootstrapRpId("http://127.0.0.1:3000", "http://127.0.0.1:8443", true),
    /HTTPS origins/u,
  );
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    assert.equal(
      resolvePasskeyBootstrapRpId("http://127.0.0.1:3000", "http://127.0.0.1:8443", true),
      "127.0.0.1",
    );
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});
