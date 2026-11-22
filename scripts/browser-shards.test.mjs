import test from "node:test";
import assert from "node:assert/strict";
import { buildBrowserTestArguments, resolveBrowserShard, summarizeBrowserCoverage } from "./browser-shards.mjs";

test("unknown profiles and shards are rejected before a runner starts", () => {
  assert.throws(() => resolveBrowserShard("preview", "core"), /Unknown browser profile/u);
  assert.throws(() => resolveBrowserShard("core", "empty"), /Unknown browser shard/u);
});

test("Playwright invokes the actual Chromium and WebKit shard with its own spec", () => {
  const cases = [
    { profile: "core", id: "job-inbox", file: "job-inbox.acceptance.spec.ts", project: "chromium" },
    { profile: "full", id: "webkit", file: "ui-v1.acceptance.spec.ts", project: "webkit" },
  ];
  for (const { profile, id, file, project } of cases) {
    const shard = resolveBrowserShard(profile, id);
    assert.deepEqual(buildBrowserTestArguments(shard), [
      "exec", "playwright", "test", "--config", "tests/e2e/playwright.config.ts",
      `tests/e2e/${file}`, `--project=${project}`,
    ]);
  }
});

test("browser coverage counts discovered, executed, skipped and failed cases", () => {
  assert.deepEqual(summarizeBrowserCoverage({
    expected: 6,
    outcomes: ["expected", "expected", "skipped", "unexpected", "flaky", "notRun"],
  }), {
    expected: 6,
    executed: 4,
    passed: 2,
    skipped: 1,
    failed: 3,
    notRun: 1,
  });
});

test("coverage rejects an empty shard and incomplete reporter output", () => {
  assert.throws(() => summarizeBrowserCoverage({ expected: 0, outcomes: [] }), /empty browser shard/u);
  assert.throws(() => summarizeBrowserCoverage({ expected: 2, outcomes: ["expected"] }), /did not report every discovered test/u);
});

test("coverage rejects statuses it does not understand", () => {
  assert.throws(() => summarizeBrowserCoverage({ expected: 1, outcomes: ["interrupted"] }), /Unknown Playwright outcome/u);
});
