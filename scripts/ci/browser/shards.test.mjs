import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildBrowserTestArguments, resolveBrowserShard, resolveBrowserTestCli, summarizeBrowserCoverage } from "./shards.mjs";

test("unknown profiles and shards are rejected before a runner starts", () => {
  assert.throws(() => resolveBrowserShard("preview", "core"), /Unknown browser profile/u);
  assert.throws(() => resolveBrowserShard("core", "empty"), /Unknown browser shard/u);
  assert.throws(() => resolveBrowserShard("core", "webkit"), /Unknown browser shard/u);
});

test("Playwright discovers only the selected spec and browser project", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "codexia-browser-discovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, CODEXIA_E2E_STATE_DIR: directory, CODEXIA_E2E_TEST_FILE: "",
    CODEXIA_E2E_EXTERNAL_DATABASE: "", CODEXIA_E2E_DATABASE_URL: "postgres://127.0.0.1/unused" };
  delete env.CODEXIA_E2E_BASE_URL;
  delete env.CODEXIA_BASE_URL;
  const cases = [
    { profile: "core", id: "job-inbox", file: "job-inbox.acceptance.spec.ts", project: "chromium" },
    { profile: "full", id: "ui-v1", file: "ui-v1.acceptance.spec.ts", project: "chromium" },
  ];
  for (const { profile, id, file, project } of cases) {
    const shard = resolveBrowserShard(profile, id);
    const result = spawnSync(process.execPath, [resolveBrowserTestCli(), ...buildBrowserTestArguments(shard), "--list", "--reporter=json"], {
      cwd: new URL("../../../", import.meta.url), encoding: "utf8", env,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const { suites } = JSON.parse(result.stdout);
    assert.deepEqual(suites.map(suite => suite.file), [file]);
    const discovered = suites.flatMap(suite => suite.specs).flatMap(spec => spec.tests);
    assert.ok(discovered.length > 0, `${file} must enumerate Playwright cases`);
    assert.deepEqual(new Set(discovered.map(item => item.projectName)), new Set([project]));
  }
});

test("Chromium discovery retains Desktop and shared UI cases", () => {
  const env = { ...process.env, CODEXIA_E2E_TEST_FILE: "ui-v1.acceptance.spec.ts",
    CODEXIA_E2E_DATABASE_URL: "postgres://127.0.0.1/unused" };
  const discover = (id, selection = []) => {
    const result = spawnSync(process.execPath, [resolveBrowserTestCli(), ...buildBrowserTestArguments(resolveBrowserShard("full", id)), ...selection, "--list", "--reporter=json"], {
      cwd: new URL("../../../", import.meta.url), encoding: "utf8", env,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const { suites } = JSON.parse(result.stdout);
    const collect = (suite) => [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(collect)];
    return suites.flatMap(collect).map(spec => ({ title: spec.title, line: spec.line }));
  };
  const chromium = discover("ui-v1");
  const desktop = discover("ui-v1", ["--grep", "@author-desktop"]);
  assert.ok(desktop.length > 0, "The reviewed Desktop cases must remain in Chromium");
  const identity = spec => JSON.stringify([spec.line, spec.title]);
  const desktopIds = new Set(desktop.map(identity));
  assert.ok(desktopIds.size < chromium.length, "Desktop selection must not absorb the entire UI suite");
  assert.ok(desktop.every(spec => chromium.some(all => identity(all) === identity(spec))));
  assert.ok(desktop.some(spec => spec.title.includes("keyboard select-all replacement")), "Desktop input proof must remain in Chromium");
  assert.ok(chromium.some(spec => spec.title.includes("Desktop reader")), "Desktop paged reading proof must remain");
  assert.ok(chromium.some(spec => spec.title.includes("rejects retired Mobile routes")), "Retired route rejection proof must remain");
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
