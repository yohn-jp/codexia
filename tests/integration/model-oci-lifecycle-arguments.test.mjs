import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isRealDirectory, validateImageReference, validateModelCachePath, validateOciEngine } from "./model-oci-lifecycle-arguments.mjs";

test("OCI lifecycle command and mount inputs preserve their supported forms", () => {
  assert.equal(validateOciEngine(undefined), "podman");
  assert.equal(validateOciEngine("podman"), "podman");
  assert.equal(validateOciEngine("/home/runner/bin/podman"), "/home/runner/bin/podman");
  assert.equal(validateModelCachePath("/tmp/model-cache", "/unused"), "/tmp/model-cache");
  assert.equal(validateModelCachePath("./relative/model-cache", "/unused"), resolve("./relative/model-cache"));
  assert.equal(validateImageReference("localhost/codexia:test", "unused"), "localhost/codexia:test");
});

test("OCI lifecycle rejects unsupported executable and mount/image syntax", () => {
  assert.throws(() => validateOciEngine("docker"), /installed Podman executable/u);
  assert.throws(() => validateOciEngine("podman --help"), /installed Podman executable/u);
  assert.throws(() => validateModelCachePath("/tmp/models:/other", "/unused"), /mount delimiters/u);
  assert.throws(() => validateImageReference("--help", "unused"), /image reference/u);
});

test("model cache preflight accepts directories and rejects symlinked directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexia-oci-cache-check-"));
  try {
    const directory = join(root, "real-cache");
    const link = join(root, "linked-cache");
    await mkdir(directory);
    await symlink(directory, link, "dir");
    assert.equal(await isRealDirectory(directory), true);
    assert.equal(await isRealDirectory(link), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
