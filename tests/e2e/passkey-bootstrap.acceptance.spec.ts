import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import { hasRestoredBrowserProfile } from "./browser-server-profile";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("Passkey-first Better Auth acceptance uses real WebAuthn and PostgreSQL", async () => {
  test.setTimeout(240_000);
  test.skip(process.env.CODEXIA_PASSKEY_ACCEPTANCE !== "1",
    "Executed only by the dedicated core Chromium + disposable PostgreSQL shard.");
  const databaseUrl = process.env.CODEXIA_E2E_DATABASE_URL;
  assert.ok(databaseUrl, "the browser shard must provide its disposable PostgreSQL database");
  const [command, ...args] = hasRestoredBrowserProfile(process.env.CODEXIA_PROFILE ?? "core")
    ? [process.execPath, "packages/api/scripts/run-passkey-acceptance.mjs"] as const
    : ["pnpm", "--filter", "@codexia/api", "run", "test:passkey-acceptance"] as const;
  const result = spawnSync(command, args, {
    cwd: root,
    env: {
      ...process.env,
      CODEXIA_AUTH_TEST_DATABASE_URL: databaseUrl,
      CODEXIA_AUTH_TEST_DISPOSABLE: "1",
      CODEXIA_PASSKEY_ACCEPTANCE: "1",
      CODEXIA_PASSKEY_SETUP_UI_DIST: fileURLToPath(new URL("../../app/dist/desktop/", import.meta.url)),
    },
    encoding: "utf8",
    timeout: 210_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `Passkey acceptance terminated by ${result.signal ?? "unknown signal"}`);
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});
