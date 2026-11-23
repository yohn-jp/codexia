import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { selectBaseReference } from "../scripts/base-reference.mjs";
import { resolveOasdiffBinary } from "../scripts/oasdiff.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("oasdiff uses the immutable approved SHA from a pull request event", (t) => {
  const eventDirectory = mkdtempSync(path.join(os.tmpdir(), "codexia-oasdiff-event-"));
  t.after(() => rmSync(eventDirectory, { recursive: true, force: true }));
  const eventPath = path.join(eventDirectory, "event.json");
  const approvedSha = "9809fccf60fabd04aeb9dbc232defc8c3f079413";
  writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: approvedSha } } }));

  assert.equal(selectBaseReference({
    CODEXIA_OASDIFF_BASE_REF: undefined,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_BASE_REF: "mutable-branch-name",
  }), approvedSha);
});

test("oasdiff manual runs use approved main instead of the previous feature commit", () => {
  assert.equal(selectBaseReference({
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF_NAME: "codex/654-g1-contract",
  }), "origin/main");
});

test("oasdiff fails closed when a pull request event has no valid base SHA", (t) => {
  const eventDirectory = mkdtempSync(path.join(os.tmpdir(), "codexia-oasdiff-event-invalid-"));
  t.after(() => rmSync(eventDirectory, { recursive: true, force: true }));
  const eventPath = path.join(eventDirectory, "event.json");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: "main" } } }));

  assert.throws(() => selectBaseReference({
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
  }), /invalid pull request base SHA/u);
});

test("oasdiff allows an explicit local base override", () => {
  assert.equal(selectBaseReference({
    CODEXIA_OASDIFF_BASE_REF: "7e".repeat(20),
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF_NAME: "codex/654-g1-contract",
  }), "7e".repeat(20));
});

test("pinned oasdiff flags a deliberately breaking response schema", async () => {
  const binary = await resolveOasdiffBinary();
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /1\.39\.0/u);

  const result = spawnSync(binary, [
    "breaking",
    path.join(packageRoot, "test", "fixtures", "oasdiff-base.openapi.yaml"),
    path.join(packageRoot, "test", "fixtures", "oasdiff-breaking.openapi.yaml"),
    "--allow-external-refs=false",
    "--fail-on",
    "ERR",
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /breaking/u);
});
