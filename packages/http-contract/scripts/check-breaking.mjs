import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { resolveOasdiffBinary } from "./oasdiff.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const packageContractPath = "packages/http-contract/openapi/codexia.openapi.yaml";
const candidatePath = path.join(packageRoot, "openapi", "codexia.openapi.yaml");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "codexia-oasdiff-base-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

function git(args, options = {}) {
  return run("git", args, options);
}

function baseReference() {
  if (process.env.CODEXIA_OASDIFF_BASE_REF) return process.env.CODEXIA_OASDIFF_BASE_REF;
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  if (process.env.GITHUB_EVENT_NAME === "push" || process.env.GITHUB_EVENT_NAME === "workflow_dispatch") return "HEAD^";
  return "origin/main";
}

function isValidCommit(reference) {
  return git(["rev-parse", "--verify", `${reference}^{commit}`]).status === 0;
}

function fetchReference(reference) {
  if (!reference.startsWith("origin/")) return reference;
  const branch = reference.slice("origin/".length);
  const result = git(["fetch", "--no-tags", "--depth=1", "origin", branch]);
  if (result.status !== 0) throw new Error(`unable to fetch oasdiff base ${reference}: ${result.stderr || result.stdout}`);
  return "FETCH_HEAD";
}

function candidateEpoch(spec) {
  const epoch = spec["x-codexia-api-epoch"];
  assert.ok(Number.isSafeInteger(epoch) && epoch > 0, "OpenAPI is missing a positive x-codexia-api-epoch");
  const update = JSON.parse(readFileSync(path.join(repositoryRoot, "deploy", "update-compatibility.json"), "utf8"));
  const frontend = JSON.parse(readFileSync(path.join(repositoryRoot, "deploy", "frontend-compatibility.json"), "utf8"));
  assert.equal(epoch, update.apiEpoch, "OpenAPI apiEpoch differs from the backend update compatibility contract");
  assert.equal(epoch, frontend.apiEpoch, "OpenAPI apiEpoch differs from the frontend compatibility contract");
  return epoch;
}

try {
  const candidate = parse(readFileSync(candidatePath, "utf8"));
  candidateEpoch(candidate);

  let reference = baseReference();
  if (!isValidCommit(reference)) reference = fetchReference(reference);
  const baseFile = path.join(tempRoot, "base.openapi.yaml");
  const baseResult = git(["show", `${reference}:${packageContractPath}`]);
  if (baseResult.status !== 0) {
    const pathExistsInBase = git(["cat-file", "-e", `${reference}:${packageContractPath}`]).status === 0;
    if (!pathExistsInBase) {
      console.log(`No approved OpenAPI artifact exists at ${reference}; this first contract establishes the generated baseline.`);
      process.exitCode = 0;
    } else {
      throw new Error(`unable to read oasdiff base ${reference}:${packageContractPath}: ${baseResult.stderr}`);
    }
  } else {
    writeFileSync(baseFile, baseResult.stdout);
    const base = parse(readFileSync(baseFile, "utf8"));
    const baseApiEpoch = candidateEpoch(base);
    assert.equal(candidateEpoch(candidate), baseApiEpoch,
      "OpenAPI apiEpoch changed; handle the coordinated cutover separately before updating the approved comparison base");

    const binary = await resolveOasdiffBinary();
    const comparison = run(binary, ["breaking", baseFile, candidatePath, "--allow-external-refs=false", "--fail-on", "ERR"]);
    process.stdout.write(comparison.stdout ?? "");
    process.stderr.write(comparison.stderr ?? "");
    if (comparison.status !== 0) {
      throw new Error(`oasdiff detected a breaking OpenAPI change against ${reference}`);
    }
    console.log(`oasdiff found no breaking changes at API epoch ${baseApiEpoch}.`);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
