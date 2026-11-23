import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "1.39.0";
const RELEASE = `https://github.com/oasdiff/oasdiff/releases/download/v${VERSION}`;
const ASSETS = {
  "linux-x64": { file: "oasdiff_1.39.0_linux_amd64.tar.gz", sha256: "71a85930728f367a2086077b7ae1411319421549d18473a3e8258b6451520433", binary: "oasdiff" },
  "linux-arm64": { file: "oasdiff_1.39.0_linux_arm64.tar.gz", sha256: "481db7d891d916f13df277b2ef8bbb95477702827710e49fe22cef69c359c780", binary: "oasdiff" },
  "darwin-x64": { file: "oasdiff_1.39.0_darwin_all.tar.gz", sha256: "fe88d9950324d3b0ebeaf8e0d3a210b64cb099a0f55fce5ee5a22b276df0eac4", binary: "oasdiff" },
  "darwin-arm64": { file: "oasdiff_1.39.0_darwin_all.tar.gz", sha256: "fe88d9950324d3b0ebeaf8e0d3a210b64cb099a0f55fce5ee5a22b276df0eac4", binary: "oasdiff" },
  "win32-x64": { file: "oasdiff_1.39.0_windows_amd64.tar.gz", sha256: "956a73df88e03efdf3fcc5f327446cc176fefe4adcea1978b0fef464a1ee8901", binary: "oasdiff.exe" },
  "win32-arm64": { file: "oasdiff_1.39.0_windows_arm64.tar.gz", sha256: "5699ac9dc74b432f78990cd369ff2bec3a79302c58e923c1ec823e47a86ddb82", binary: "oasdiff.exe" },
};

function fail(message) {
  throw new Error(message);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
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

    const archivePath = path.join(temp, asset.file);
    await writeFile(archivePath, archive, { mode: 0o600 });
    const extracted = path.join(temp, "extracted");
    await mkdir(extracted);
    run("tar", ["-xzf", archivePath, "-C", extracted]);
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
