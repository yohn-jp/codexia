import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildBrowserTestArguments, resolveBrowserShard, summarizeBrowserCoverage } from "./shards.mjs";

test("unknown profiles and shards are rejected before a runner starts", () => {
  assert.throws(() => resolveBrowserShard("preview", "core"), /Unknown browser profile/u);
  assert.throws(() => resolveBrowserShard("core", "empty"), /Unknown browser shard/u);
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
    { profile: "full", id: "webkit", file: "ui-v1.acceptance.spec.ts", project: "webkit" },
  ];
  for (const { profile, id, file, project } of cases) {
    const shard = resolveBrowserShard(profile, id);
    const result = spawnSync("pnpm", [...buildBrowserTestArguments(shard), "--list", "--reporter=json"], {
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
