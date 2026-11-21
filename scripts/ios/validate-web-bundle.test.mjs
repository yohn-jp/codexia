import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

test("rejects remote production server configuration in the document", async () => {
  const directory = await fixture('<!doctype html><script src="./assets/app.js"></script><meta content="https://example.test">');
  try { await assert.rejects(validateWebBundle(directory), /remote server URL/u); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
