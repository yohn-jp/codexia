import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateWebBundle } from "./validate-web-bundle.mjs";

async function fixture(html, bundle = "void 0;") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexia-ios-web-"));
  await mkdir(path.join(directory, "assets"));
  await writeFile(path.join(directory, "assets", "app.js"), bundle);
  await writeFile(path.join(directory, "index.html"), html);
  return directory;
}

const nativeEnvironment = {
  VITE_CODEXIA_API_ORIGIN: "https://api.example.test",
  VITE_CODEXIA_PUBLIC_READER_ORIGIN: "https://reader.example.test",
  VITE_CODEXIA_OAUTH_IOS_CLIENT_ID: "codexia-ios-test-public",
  VITE_CODEXIA_API_AUDIENCE: "https://api.example.test/api",
};

test("the distribution validator CLI reports a self-contained relative asset bundle", async () => {
  const directory = await fixture('<!doctype html><script type="module" src="./assets/app.js"></script>');
  try {
    const script = fileURLToPath(new URL("./validate-web-bundle.mjs", import.meta.url));
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [script, directory]);
    assert.deepEqual(JSON.parse(stdout), { references: 1 });
    assert.equal(stderr, "");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects an absolute bundle path outside the Mobile web-mode exception", async () => {
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

test("native bundle validation requires its bridge and embedded public iOS configuration", async () => {
  const directory = await fixture(
    '<!doctype html><script type="module" src="./assets/app.js"></script>',
    ["mobile-shell", "CodexiaAuth", "https://api.example.test/", "https://reader.example.test/", "codexia-ios-test-public", "https://api.example.test/api"].join(" "),
  );
  try {
    await validateWebBundle(directory, { mode: "native", env: nativeEnvironment });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native bundle validation allows missing reader configuration but refuses to ship a configured origin without embedding it", async () => {
  const directory = await fixture(
    '<!doctype html><script type="module" src="./assets/app.js"></script>',
    ["mobile-shell", "CodexiaAuth", "https://api.example.test/", "codexia-ios-test-public", "https://api.example.test/api"].join(" "),
  );
  try {
    const { VITE_CODEXIA_PUBLIC_READER_ORIGIN: _readerOrigin, ...withoutReader } = nativeEnvironment;
    await validateWebBundle(directory, { mode: "native", env: withoutReader });
    await assert.rejects(validateWebBundle(directory, { mode: "native", env: nativeEnvironment }), /public reader origin/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native bundle validation rejects a browser Mobile entry even when public config is present", async () => {
  const directory = await fixture(
    '<!doctype html><script type="module" src="./assets/app.js"></script>',
    ["mobile-shell", "https://api.example.test/", "codexia-ios-test-public", "https://api.example.test/api"].join(" "),
  );
  try {
    await assert.rejects(validateWebBundle(directory, { mode: "native", env: nativeEnvironment }), /native API bridge/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native bundle validation rejects missing public distribution configuration", async () => {
  const directory = await fixture(
    '<!doctype html><script type="module" src="./assets/app.js"></script>',
    "mobile-shell CodexiaAuth https://api.example.test/ codexia-ios-test-public https://api.example.test/api",
  );
  try {
    await assert.rejects(
      validateWebBundle(directory, { mode: "native", env: { VITE_CODEXIA_API_ORIGIN: nativeEnvironment.VITE_CODEXIA_API_ORIGIN } }),
      /iOS public client ID is not configured/u,
    );
    await assert.rejects(
      validateWebBundle(directory, { mode: "native", env: { VITE_CODEXIA_OAUTH_IOS_CLIENT_ID: nativeEnvironment.VITE_CODEXIA_OAUTH_IOS_CLIENT_ID } }),
      /API origin is not configured/u,
    );
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("browser Mobile bundle validation rejects the native API bridge", async () => {
  const directory = await fixture(
    '<!doctype html><script type="module" src="./assets/app.js"></script>',
    "mobile-shell CodexiaAuth browser bundle",
  );
  try {
    await assert.rejects(validateWebBundle(directory, { mode: "web" }), /unexpected native API bridge/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("browser Mobile validation resolves assets under its /mobile/ Vite base path", async () => {
  const directory = await fixture('<!doctype html><script type="module" src="/mobile/assets/app.js"></script>', "mobile-shell browser bundle");
  try {
    await validateWebBundle(directory, { mode: "web" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native bundle validation rejects public settings omitted from the compiled JavaScript", async () => {
  const directory = await fixture(
    '<!doctype html><script type="module" src="./assets/app.js"></script>',
    "mobile-shell CodexiaAuth https://api.example.test/ codexia-ios-test-public",
  );
  try {
    await assert.rejects(
      validateWebBundle(directory, { mode: "native", env: nativeEnvironment }),
      /missing configured API audience/u,
    );
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Mobile entry config changes run Core and Full artifact validation in pull request CI", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/ios-unsigned-ipa.yml", import.meta.url), "utf8");
  assert.match(workflow, /^      - app\/vite\.config\.ts$/mu);
  assert.match(workflow, /^      - app\/vite\.native\.config\.ts$/mu);
  assert.match(workflow, /^      - app\/src\/entries\/mobile\.tsx$/mu);
  assert.match(workflow, /fromJSON\('\["core","full"\]'\)/u);
  assert.match(workflow, /validate-web-bundle\.mjs app\/dist\/mobile web/u);
  assert.match(workflow, /validate-web-bundle\.mjs app\/dist\/ios-web native/u);
});
