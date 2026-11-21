import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateWebBundle } from "./validate-web-bundle.mjs";

async function fixture(html) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexia-ios-web-"));
  await mkdir(path.join(directory, "assets"));
  await writeFile(path.join(directory, "assets", "app.js"), "void 0;");
  await writeFile(path.join(directory, "index.html"), html);
  return directory;
}

test("accepts a self-contained relative asset bundle", async () => {
  const directory = await fixture('<!doctype html><script type="module" src="./assets/app.js"></script>');
  try { assert.deepEqual(await validateWebBundle(directory), { references: 1 }); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects absolute or remote assets", async () => {
  const directory = await fixture('<!doctype html><script src="/mobile/assets/app.js"></script>');
  try { await assert.rejects(validateWebBundle(directory), /relative path/u); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects an asset that escapes the bundle", async () => {
  const directory = await fixture('<!doctype html><script src="../outside.js"></script>');
  try { await assert.rejects(validateWebBundle(directory), /escapes web bundle/u); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects a directory referenced as an asset", async () => {
  const directory = await fixture('<!doctype html><script src="./assets"></script>');
  try { await assert.rejects(validateWebBundle(directory), /not a file/u); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects a linked asset outside the bundle", async () => {
  const directory = await fixture('<!doctype html><script src="./assets/external.js"></script>');
  const outside = await mkdtemp(path.join(os.tmpdir(), "codexia-ios-outside-"));
  try {
    await writeFile(path.join(outside, "external.js"), "void 0;");
    await symlink(path.join(outside, "external.js"), path.join(directory, "assets", "external.js"));
    await assert.rejects(validateWebBundle(directory), /contains a symbolic link/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects an intermediate symlink that resolves outside the bundle", async () => {
  const directory = await fixture('<!doctype html><script src="./assets/external/app.js"></script>');
  const outside = await mkdtemp(path.join(os.tmpdir(), "codexia-ios-outside-dir-"));
  try {
    await mkdir(path.join(outside, "external"));
    await writeFile(path.join(outside, "external", "app.js"), "void 0;");
    await symlink(path.join(outside, "external"), path.join(directory, "assets", "external"));
    await assert.rejects(validateWebBundle(directory), /contains a symbolic link/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects an internal relative symbolic link because assets must be regular files", async () => {
  const directory = await fixture('<!doctype html><script src="./assets/alias.js"></script>');
  try {
    await symlink("./app.js", path.join(directory, "assets", "alias.js"));
    await assert.rejects(validateWebBundle(directory), /contains a symbolic link/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects index.html when it is a symbolic link", async () => {
  const directory = await fixture('<!doctype html><script src="./assets/app.js"></script>');
  try {
    await writeFile(path.join(directory, "index-copy.html"), '<!doctype html><script src="./assets/app.js"></script>');
    await rm(path.join(directory, "index.html"));
    await symlink("./index-copy.html", path.join(directory, "index.html"));
    await assert.rejects(validateWebBundle(directory), /index.html must be a regular file/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects remote production server configuration in the document", async () => {
  const directory = await fixture('<!doctype html><script src="./assets/app.js"></script><meta content="https://example.test">');
  try { await assert.rejects(validateWebBundle(directory), /remote server URL/u); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
