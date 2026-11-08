#!/usr/bin/env node
/** Local verification only. Does not invoke CI, publish images, or deploy. */
import { spawn } from "node:child_process";

const commands = [
  ["pnpm", ["install", "--frozen-lockfile"]],
  ["pnpm", ["typecheck"]],
  ["pnpm", ["typecheck:tests"]],
  ["pnpm", ["typecheck:safety"]],
  ["pnpm", ["test"]],
  ["pnpm", ["build"], { CODEXIA_PROFILE: "core" }],
  ["pnpm", ["audit:core"], { CODEXIA_PROFILE: "core" }],
  ["pnpm", ["exec", "playwright", "test", "--config", "tests/e2e/playwright.config.ts"], { CODEXIA_PROFILE: "core" }],
  ["bash", ["scripts/verify-oci.sh"], { CODEXIA_PROFILE: "core", CODEXIA_OCI_IMAGE: process.env.CODEXIA_OCI_CORE_IMAGE ?? "codexia:verification-core" }],
  ["pnpm", ["build"], { CODEXIA_PROFILE: "full" }],
  ["pnpm", ["exec", "playwright", "test", "--config", "tests/e2e/playwright.config.ts"], { CODEXIA_PROFILE: "full" }],
  ["node", ["--test", "tests/integration/mcp-acceptance.test.mjs"], { CODEXIA_MCP_ACCEPTANCE_MODULES: "story,nlp,diagnostics,semantic,speaker,assistant,publishing,mcp" }],
  ["node", ["--test", "modules/diagnostics/tests/production.acceptance.mjs"]],
  ["node", ["--test", "tests/integration/migration-acceptance.test.mjs"]],
  ["bash", ["scripts/verify-oci.sh"], { CODEXIA_PROFILE: "full", CODEXIA_OCI_IMAGE: process.env.CODEXIA_OCI_FULL_IMAGE ?? "codexia:verification-full" }],
];
for (const [command, args, overrides = {}] of commands) {
  const profile = overrides.CODEXIA_PROFILE;
  console.info(`\nRunning ${command} ${args.join(" ")}${profile ? ` (profile=${profile})` : ""}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, ...overrides } });
    child.on("error", reject);
    child.on("exit", (status, signal) => resolve(status ?? (signal ? 1 : 0)));
  });
  if (code !== 0) {
    console.error(`Verification stopped: ${command} ${args.join(" ")} exited ${code}`);
    process.exitCode = code;
    break;
  }
}
