import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializeAuthorBrowserAssets, TEMPLATE_CLIENT_ID, TEMPLATE_ORIGIN } from "./oauth-asset-template";

test("OAuth asset templates stay immutable and each server gets its own public configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "codexia-oauth-template-test-"));
  const previousCi = process.env.CI;
  const previousSha = process.env.CODEXIA_EXPECTED_SHA;
  process.env.CI = "true";
  process.env.CODEXIA_EXPECTED_SHA = "e2e-template-test-sha";
  try {
    const template = join(root, "template");
    mkdirSync(join(template, "desktop", "assets"), { recursive: true });
    writeFileSync(join(template, ".codexia-oauth-asset-template.json"), JSON.stringify({
      schema: "codexia-e2e-oauth-assets/v1", profile: "core", sourceSha: "e2e-template-test-sha",
    }));
    const compiled = 'const origin="' + TEMPLATE_ORIGIN + '";const client="' + TEMPLATE_CLIENT_ID + '";';
    writeFileSync(join(template, "desktop/assets/app.js"), compiled);
    const one = join(root, "one");
    const two = join(root, "two");
    materializeAuthorBrowserAssets(template, one, "core", {
      apiOrigin: "http://127.0.0.1:40001",
      issuer: "http://127.0.0.1:40001/api/auth",
      audience: "http://127.0.0.1:40001/api",
      webClientId: "fixture-client-one",
    });
    materializeAuthorBrowserAssets(template, two, "core", {
      apiOrigin: "http://127.0.0.1:40002",
      issuer: "http://127.0.0.1:40002/api/auth",
      audience: "http://127.0.0.1:40002/api",
      webClientId: "fixture-client-two",
    });
    const first = readFileSync(join(one, "desktop/assets/app.js"), "utf8");
    const second = readFileSync(join(two, "desktop/assets/app.js"), "utf8");
    assert.match(first, /127\.0\.0\.1:40001/u);
    assert.match(first, /fixture-client-one/u);
    assert.doesNotMatch(first, /fixture-client-two/u);
    assert.match(second, /127\.0\.0\.1:40002/u);
    assert.match(second, /fixture-client-two/u);
    assert.equal(readFileSync(join(template, "desktop/assets/app.js"), "utf8"), compiled);
    assert.throws(() => materializeAuthorBrowserAssets(template, join(root, "wrong-profile"), "full", {
      apiOrigin: "http://127.0.0.1:40003",
      issuer: "http://127.0.0.1:40003/api/auth",
      audience: "http://127.0.0.1:40003/api",
      webClientId: "fixture-client-three",
    }), /does not match/u);
    process.env.CODEXIA_EXPECTED_SHA = "other-source-sha";
    assert.throws(() => materializeAuthorBrowserAssets(template, join(root, "wrong-source"), "core", {
      apiOrigin: "http://127.0.0.1:40003",
      issuer: "http://127.0.0.1:40003/api/auth",
      audience: "http://127.0.0.1:40003/api",
      webClientId: "fixture-client-three",
    }), /does not match/u);
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousSha === undefined) delete process.env.CODEXIA_EXPECTED_SHA;
    else process.env.CODEXIA_EXPECTED_SHA = previousSha;
    rmSync(root, { recursive: true, force: true });
  }
});
