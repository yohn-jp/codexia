import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "1.41.0";
const RELEASE = `https://github.com/oasdiff/oasdiff/releases/download/v${VERSION}`;
const ASSETS = {
  "linux-x64": { file: "oasdiff_1.41.0_linux_amd64.tar.gz", sha256: "96365453163118e6503eb71742643d9ee67f91aedbaadd1a1ce9c6213e3b71c7", binary: "oasdiff" },
  "linux-arm64": { file: "oasdiff_1.41.0_linux_arm64.tar.gz", sha256: "8d4b8ddd467440885675db918e229ab8db330111c6428eb864e7eb766a7f4071", binary: "oasdiff" },
  "darwin-x64": { file: "oasdiff_1.41.0_darwin_all.tar.gz", sha256: "0452671a98a290ab7c5e49b274fdc77b34c5cdb595b4305cfdb64ae011f7f1ee", binary: "oasdiff" },
  "darwin-arm64": { file: "oasdiff_1.41.0_darwin_all.tar.gz", sha256: "0452671a98a290ab7c5e49b274fdc77b34c5cdb595b4305cfdb64ae011f7f1ee", binary: "oasdiff" },
  "win32-x64": { file: "oasdiff_1.41.0_windows_amd64.tar.gz", sha256: "dcacaa482ba2e5a783c7e5c7682a96e1d0d65180a897fc66f13e66dc814a7a83", binary: "oasdiff.exe" },
  "win32-arm64": { file: "oasdiff_1.41.0_windows_arm64.tar.gz", sha256: "3f09d256bf3344b0afafef1e7955c235326f6980055d11867702d97f24559a1b", binary: "oasdiff.exe" },
};

function fail(message) {
  throw new Error(message);
}

function run(command, args, input) {
  const result = spawnSync(command, args, input === undefined
    ? { stdio: "inherit" }
    : { input, stdio: ["pipe", "inherit", "inherit"] });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} exited with status ${result.status ?? "unknown"}`);
}

export async function resolveOasdiffBinary() {
  if (process.env.CODEXIA_OASDIFF_BIN) {
    const override = path.resolve(process.env.CODEXIA_OASDIFF_BIN);
    await stat(override);
    return override;
  }

  const asset = ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) fail(`oasdiff ${VERSION} has no pinned asset for ${process.platform}/${process.arch}`);
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cacheRoot = path.join(packageRoot, ".cache", "oasdiff", VERSION, `${process.platform}-${process.arch}`);
  const binary = path.join(cacheRoot, asset.binary);
  try {
    await stat(binary);
    return binary;
  } catch {
    // Install the pinned official asset below.
  }

  await mkdir(path.dirname(cacheRoot), { recursive: true });
  const temp = await mkdtemp(path.join(path.dirname(cacheRoot), ".install-"));
  try {
    const response = await fetch(`${RELEASE}/${asset.file}`);
    if (!response.ok) fail(`unable to download oasdiff ${VERSION}: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== asset.sha256) fail(`oasdiff ${VERSION} digest mismatch for ${asset.file}`);

    const extracted = path.join(temp, "extracted");
    await mkdir(extracted);
    // Integrity-bound archive bytes are streamed to tar; no downloaded archive is persisted.
    run("tar", ["-xzf", "-", "-C", extracted], archive);
    const extractedBinary = path.join(extracted, asset.binary);
    await stat(extractedBinary);
    await chmod(extractedBinary, 0o755);
    await mkdir(cacheRoot, { recursive: true });
    const stagedBinary = path.join(cacheRoot, `.oasdiff-${process.pid}`);
    await copyFile(extractedBinary, stagedBinary);
    await chmod(stagedBinary, 0o755);
    await rename(stagedBinary, binary).catch(async (error) => {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      await rm(stagedBinary, { force: true });
    });
    return binary;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await resolveOasdiffBinary());
}
