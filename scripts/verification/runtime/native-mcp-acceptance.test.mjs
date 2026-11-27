import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("native MCP acceptance exercises real PostgreSQL over both transports", { timeout: 240_000 }, () => {
  assert.ok(process.env.CODEXIA_TEST_DATABASE_URL, "Native MCP acceptance requires the disposable PostgreSQL test database");
  execFileSync("pnpm", ["--filter", "@codexia/api...", "--filter", "@codexia/module-mcp...", "--filter", "@codexia/module-story...", "--filter", "@codexia/module-nlp...", "build"], { cwd: root, stdio: "inherit" });
  // Node disables nested test discovery when this parent runner context is inherited.
  const env = { ...process.env, CODEXIA_MCP_ACCEPTANCE_MODULES: "story,nlp,mcp" };
  delete env.NODE_TEST_CONTEXT;
  const expectedCases = [
    "direct-root Story scenes keep PostgreSQL positions and context through Actions and MCP",
    "[TEST-MCPV-004-001]",
    "[TEST-MCPV-006-001]",
  ].map(prefix => RegExp.escape(prefix));
  const output = execFileSync(process.execPath, [
    "--test", "--test-reporter=tap", `--test-name-pattern=^(?:${expectedCases.join("|")})(?:\\s|$)`,
    "tests/integration/mcp-acceptance.test.mjs",
  ], { cwd: root, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", env });
  console.log(output);
  for (const prefix of expectedCases) {
    assert.match(output, new RegExp(`^ok \\d+ - ${prefix}[^\\r\\n]*$`, "m"));
  }
  assert.match(output, /^# pass 3$/m);
  assert.match(output, /^# fail 0$/m);
  assert.match(output, /^# skipped 0$/m);
});
