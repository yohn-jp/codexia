import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import transition from "../../../scripts/deployment/cutover/migrations/mcp-v2-api-2-to-3.mjs";
import { assertBreakingComparison, assertCandidateManifestEpoch, assertEpochTransitionEvidence } from "./breaking-policy.mjs";
import { expectedBackendMigrationFingerprint } from "../../../scripts/release/backend/image-inspection.mjs";
import { resolveBaseCommit, selectBaseReference } from "./base-reference.mjs";
import { resolveOasdiffBinary } from "./oasdiff.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
process.chdir(repositoryRoot);
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

function readBaseFile(baseSha, filename) {
  const result = git(["show", `${baseSha}:${filename}`]);
  if (result.status !== 0) throw new Error(`unable to read approved base ${baseSha}:${filename}: ${result.stderr}`);
  return result.stdout;
}

function readCandidateAuthEvidence() {
  return [
    readFileSync(path.join(repositoryRoot, "packages/api/src/auth-schema.ts"), "utf8"),
    readFileSync(path.join(repositoryRoot, "deploy/quadlet/codexia-api.container"), "utf8"),
  ];
}

try {
  const candidate = parse(readFileSync(candidatePath, "utf8"));
  const candidateUpdate = JSON.parse(readFileSync(path.join(repositoryRoot, "deploy", "update-compatibility.json"), "utf8"));
  const candidateFrontend = JSON.parse(readFileSync(path.join(repositoryRoot, "deploy", "frontend-compatibility.json"), "utf8"));
  assertCandidateManifestEpoch(candidate, candidateUpdate, candidateFrontend);
  const reference = selectBaseReference();
  const baseSha = resolveBaseCommit(reference, git);
  const baseFile = path.join(tempRoot, "base.openapi.yaml");
  const baseExists = git(["cat-file", "-e", `${baseSha}:${packageContractPath}`]).status === 0;
  if (!baseExists) {
    console.log(`No approved OpenAPI artifact exists at ${baseSha}; this first contract establishes the generated baseline.`);
  } else {
    const baseText = readBaseFile(baseSha, packageContractPath);
    writeFileSync(baseFile, baseText);
    const base = parse(baseText);
    const baseUpdate = JSON.parse(readBaseFile(baseSha, "deploy/update-compatibility.json"));
    const baseFrontend = JSON.parse(readBaseFile(baseSha, "deploy/frontend-compatibility.json"));
    const epochChanged = candidate["x-codexia-api-epoch"] !== base["x-codexia-api-epoch"];
    let epoch = { changed: false, baseEpoch: base["x-codexia-api-epoch"], candidateEpoch: candidate["x-codexia-api-epoch"] };
    if (epochChanged) {
      const baseAuth = [
        readBaseFile(baseSha, "packages/api/src/auth-schema.ts"),
        readBaseFile(baseSha, "deploy/quadlet/codexia-api.container"),
      ];
      const candidateAuth = readCandidateAuthEvidence();
      epoch = assertEpochTransitionEvidence({
        baseSpec: base,
        candidateSpec: candidate,
        baseUpdate,
        baseFrontend,
        candidateUpdate,
        candidateFrontend,
        transition,
        baseAuth,
        candidateAuth,
        baseMigrationFingerprint: await expectedBackendMigrationFingerprint(baseSha, { cwd: repositoryRoot }),
        candidateMigrationFingerprint: await expectedBackendMigrationFingerprint(undefined, { cwd: repositoryRoot }),
      });
    } else {
      // Preserve ordinary same-epoch compatibility behavior; this check only binds the epochs to their own manifests.
      assertEpochTransitionEvidence({
        baseSpec: base, candidateSpec: candidate, baseUpdate, baseFrontend,
        candidateUpdate, candidateFrontend, transition,
      });
    }

    const binary = await resolveOasdiffBinary();
    const comparison = run(binary, [
      "breaking", baseFile, candidatePath, "--format", "json", "--allow-external-refs=false", "--fail-on", "ERR",
    ]);
    process.stdout.write(comparison.stdout ?? "");
    process.stderr.write(comparison.stderr ?? "");
    assertBreakingComparison({ stdout: comparison.stdout ?? "", status: comparison.status, epochChanged: epoch.changed });
    console.log(epoch.changed
      ? `oasdiff accepted the four documented MCP response removals for API epoch 2→3; approved comparison base ${baseSha}.`
      : `oasdiff found no breaking changes at API epoch ${epoch.candidateEpoch}, comparing approved ${packageContractPath} from ${baseSha}.`);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
