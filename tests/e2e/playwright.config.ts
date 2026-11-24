import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const selectedTestFile = process.env.CODEXIA_E2E_TEST_FILE;
const coverageFile = process.env.CODEXIA_E2E_COVERAGE_FILE;
if (!process.env.CODEXIA_E2E_DATABASE_URL) {
  throw new Error("Set CODEXIA_E2E_DATABASE_URL to an isolated disposable PostgreSQL database");
}
if (selectedTestFile && !/^[a-z0-9-]+\.acceptance\.spec\.ts$/u.test(selectedTestFile)) {
  throw new Error("CODEXIA_E2E_TEST_FILE must name one acceptance spec");
}

export default defineConfig({
  testDir: ".",
  ...(process.env.CODEXIA_E2E_OUTPUT_DIR ? { outputDir: process.env.CODEXIA_E2E_OUTPUT_DIR } : {}),
  testMatch: selectedTestFile ? `**/${selectedTestFile}` : "**/*.spec.ts",
  testIgnore: "**/core64-lifecycle.host.acceptance.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 8_000 },
  reporter: coverageFile
    ? [
        ["list"],
        [resolve("scripts/ci/browser/coverage-reporter.mjs"), { outputFile: coverageFile }],
      ]
    : "list",
  use: {
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: process.env.CODEXIA_E2E_CHROMIUM
          ? { executablePath: process.env.CODEXIA_E2E_CHROMIUM }
          : undefined,
      },
    },
    {
      name: "webkit",
      testMatch: "**/ui-v1.acceptance.spec.ts",
      grepInvert: /@author-desktop\b/u,
      use: {
        browserName: "webkit",
        launchOptions: process.env.CODEXIA_E2E_WEBKIT
          ? { executablePath: process.env.CODEXIA_E2E_WEBKIT }
          : undefined,
      },
    },
  ],
});
