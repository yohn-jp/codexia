#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function required(value, name) {
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || !value || values.has(key.slice(2))) {
      throw new Error("Arguments must be unique --name value pairs");
    }
    values.set(key.slice(2), value);
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const app = path.resolve(required(args.get("app"), "app"));
  const out = path.resolve(required(args.get("out"), "out"));
  for (const name of args.keys()) {
    if (!["app", "out", "source-sha", "profile"].includes(name)) throw new Error(`Unexpected argument: --${name}`);
  }
  const sourceSha = required(args.get("source-sha"), "source-sha");
  const profile = required(args.get("profile"), "profile");
  if (!["core", "full"].includes(profile)) throw new Error("Profile must be core or full");
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error("Invalid source SHA");
  const head = run("git", ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(head) || sourceSha !== head) throw new Error("Artifact source SHA must match the checked-out HEAD");

  const infoPlist = path.join(app, "Info.plist");
  const bundleId = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", infoPlist]);
  if (bundleId !== "jp.yohn.codexia") throw new Error(`Unexpected bundle identifier: ${bundleId}`);
  const minimumOSVersion = run("/usr/libexec/PlistBuddy", ["-c", "Print :MinimumOSVersion", infoPlist]);
  if (minimumOSVersion !== "27.0") throw new Error(`Expected minimum iOS 27.0, got ${minimumOSVersion}`);
  if (await exists(path.join(app, "embedded.mobileprovision"))) throw new Error("Unsigned artifact must not contain a provisioning profile");
  if (await exists(path.join(app, "_CodeSignature"))) throw new Error("Unsigned artifact must not contain an app code signature");
  const executable = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", infoPlist]);
  const architectures = run("/usr/bin/lipo", ["-archs", path.join(app, executable)]).split(/\s+/u).sort();
  if (!architectures.includes("arm64")) throw new Error(`IPA does not include arm64: ${architectures.join(", ")}`);

  await rm(out, { recursive: true, force: true });
  const payload = path.join(out, "Payload");
  await mkdir(payload, { recursive: true });
  const appName = path.basename(app);
  const packagedApp = path.join(payload, appName);
  await copyDirectory(app, packagedApp);
  const ipa = path.join(out, "Codexia-unsigned.ipa");
  run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", payload, ipa]);
  const entries = run("/usr/bin/unzip", ["-Z1", ipa]).split(/\r?\n/u);
  if (!entries.includes(`Payload/${appName}/Info.plist`) || !entries.includes(`Payload/${appName}/${executable}`)) {
    throw new Error("IPA is missing the app metadata or executable");
  }
  if (entries.some((entry) => entry.endsWith("embedded.mobileprovision"))) throw new Error("IPA archive contains a provisioning profile");

  const xcode = run("/usr/bin/xcodebuild", ["-version"]).replace(/\n/gu, " ");
  if (!/^Xcode 27\./u.test(xcode)) throw new Error(`Expected Xcode 27 toolchain: ${xcode}`);
  const nativeLock = JSON.parse(await readFile(new URL("../../app/native/package-lock.json", import.meta.url), "utf8"));
  const rootPackage = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const capacitorIos = nativeLock.packages["node_modules/@capacitor/ios"].version;
  const capacitorCli = nativeLock.packages["node_modules/@capacitor/cli"].version;
  const digest = createHash("sha256").update(await readFile(ipa)).digest("hex");
  const identity = {
    format: "codexia-unsigned-ios-ipa/v1",
    sourceSha,
    bundleId,
    minimumOSVersion,
    appName,
    profile,
    architectures,
    xcode,
    node: process.version,
    pnpm: rootPackage.packageManager,
    capacitorIos,
    capacitorCli,
    signing: "unsigned",
    provisioningProfile: false,
    ipaSha256: digest,
    ipaBytes: (await readFile(ipa)).byteLength,
  };
  await writeFile(path.join(out, "build-identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
  console.log(JSON.stringify(identity));
}

async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function copyDirectory(source, target) {
  await cp(source, target, { recursive: true, dereference: false, verbatimSymlinks: true });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
