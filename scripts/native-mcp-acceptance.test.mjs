import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("native MCP acceptance exercises real PostgreSQL over both transports", { timeout: 240_000 }, () => {
  assert.ok(process.env.CODEXIA_TEST_DATABASE_URL, "Native MCP acceptance requires the disposable PostgreSQL test database");
  execFileSync("pnpm", ["--filter", "@codexia/api...", "--filter", "@codexia/module-mcp...", "build"], { cwd: root, stdio: "inherit" });
  execFileSync(process.execPath, [
    "--test", "--test-name-pattern=^native Knowledge MCP tools preserve PostgreSQL scope",
    "tests/integration/mcp-acceptance.test.mjs",
  ], { cwd: root, stdio: "inherit", env: { ...process.env, CODEXIA_MCP_ACCEPTANCE_MODULES: "mcp" } });
});
