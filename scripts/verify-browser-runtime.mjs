#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { chromium, webkit } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { browserRuntimeRequirements } from "./ci-browser-image-digests.mjs";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);

// Derive browser requirements from the canonical CI task inventory.
// The WebKit group also contains Chromium UI/auth tasks.
const browserGroup = process.env.CODEXIA_CI_BROWSER_GROUP;
const { projects, imageDigest: expectedImageDigest } = browserRuntimeRequirements(`browser-${browserGroup}`);
assert.equal(process.platform, "linux", "Browser verification requires the Linux Noble container");
assert.equal(process.arch, "x64", "The pinned Playwright image digest is the Linux amd64 image");
assert.equal(process.versions.node, "24.22.3", "The browser runner must use pinned Node 24.22.3");
assert.equal(
  process.env.CODEXIA_PLAYWRIGHT_IMAGE_DIGEST,
  expectedImageDigest,
  "The browser job must declare the image digest matching its canonical browser group",
);

const operatingSystem = await readFile("/etc/os-release", "utf8");
assert.match(operatingSystem, /^VERSION_CODENAME="?noble"?$/mu, "The browser runner must use Ubuntu Noble");

const { stdout: pnpmVersionOutput } = await execFileAsync("pnpm", ["--version"], { encoding: "utf8" });
const pnpmVersion = pnpmVersionOutput.trim();
assert.equal(pnpmVersion, "12.21.0", "The browser runner must use pnpm 12.21.0");

const playwrightPackage = JSON.parse(await readFile(resolve(root, "node_modules/@playwright/test/package.json"), "utf8"));
assert.equal(playwrightPackage.version, "1.65.1", "The installed Playwright package must match the pinned browser image");

async function verifyBrowser(name, browserType) {
  const browser = await browserType.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><title>Codexia browser runtime</title><main>browser-ready</main>");
    const content = await page.locator("main").textContent();
    assert.equal(content, "browser-ready", `${name} must render and read a real page`);
    return browser.version();
  } finally {
    await browser.close();
  }
}

const browsers = { chromium: await verifyBrowser("Chromium", chromium) };
if (projects.has("webkit")) browsers.webkit = await verifyBrowser("WebKit", webkit);
process.stdout.write(`PLAYWRIGHT_RUNTIME PASS ${JSON.stringify({
  os: "ubuntu-noble",
  imageDigest: expectedImageDigest,
  group: browserGroup,
  node: process.version,
  pnpm: pnpmVersion,
  playwright: playwrightPackage.version,
  browsers,
})}\n`);
