import assert from "node:assert/strict";
import test from "node:test";
import { validateImageReference, validateModelCachePath, validateOciEngine } from "./model-oci-lifecycle-arguments.mjs";

test("OCI lifecycle command and mount inputs preserve their supported forms", () => {
  assert.equal(validateOciEngine(undefined), "podman");
  assert.equal(validateOciEngine("podman"), "podman");
  assert.equal(validateOciEngine("/home/runner/bin/podman"), "/home/runner/bin/podman");
  assert.equal(validateModelCachePath("/tmp/model-cache", "/unused"), "/tmp/model-cache");
  assert.equal(validateImageReference("localhost/codexia:test", "unused"), "localhost/codexia:test");
});

test("OCI lifecycle rejects unsupported executable and mount/image syntax", () => {
  assert.throws(() => validateOciEngine("docker"), /Podman executable/u);
  assert.throws(() => validateOciEngine("podman --help"), /Podman executable/u);
  assert.throws(() => validateModelCachePath("relative/models", "/unused"), /absolute path/u);
  assert.throws(() => validateModelCachePath("/tmp/models:/other", "/unused"), /mount delimiters/u);
  assert.throws(() => validateImageReference("--help", "unused"), /image reference/u);
});
