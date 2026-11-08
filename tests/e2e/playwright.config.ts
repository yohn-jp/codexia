import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
const baseURL = `http://127.0.0.1:${process.env.CODEXIA_E2E_PORT ?? "4173"}`;
process.env.CODEXIA_E2E_AUTH_TOKEN ??= "codexia-e2e-token-for-local-testing-only";
if (!process.env.CODEXIA_E2E_DATABASE_URL) throw new Error("A disposable CODEXIA_E2E_DATABASE_URL is required");
export default defineConfig({
  testDir: ".", testMatch: "persistence-database.acceptance.spec.ts", workers: 1, fullyParallel: false,
  timeout: 90_000, expect: { timeout: 8_000 },
  use: { baseURL, headless: true, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { browserName: "chromium", ...(process.env.CODEXIA_E2E_CHROMIUM ? { launchOptions: { executablePath: process.env.CODEXIA_E2E_CHROMIUM } } : {}) } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: { command: "node --import tsx tests/e2e/test-server.ts", cwd: resolve("."), url: `${baseURL}/health/ready`, reuseExistingServer: false, timeout: 120_000 },
});
