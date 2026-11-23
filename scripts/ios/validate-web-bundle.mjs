#!/usr/bin/env node

import { lstat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { nativeApiOrigin, nativeOAuthConfig, nativeReaderOrigin } from "../../app/native/plugins/codexia-auth/src/native-config.mjs";
import { inspectHtml } from "../shared/html-document.mjs";
import { readRegularFile } from "../shared/read-regular-file.mjs";

export async function validateWebBundle(directory, { mode, env = process.env } = {}) {
  if (mode !== undefined && mode !== "native" && mode !== "web") throw new Error("Mobile bundle mode must be native or web");
  const root = path.resolve(directory);
  const indexFile = path.join(root, "index.html");
  const html = await readRegularFile(indexFile, { message: "Mobile bundle index.html must be a regular file" });
  if (!/<!doctype html>/iu.test(html)) throw new Error("Mobile web bundle is missing its HTML document type");
  if (/https?:\/\//iu.test(html) || /server\.url/iu.test(html)) throw new Error("Mobile web bundle must not load a remote server URL");
  const references = inspectHtml(html).references;
  if (references.length === 0) throw new Error("Mobile web bundle contains no linked assets");
  for (const reference of references) {
    const localReference = localBundleReference(reference, mode);
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/iu.test(localReference)) {
      throw new Error(`Mobile asset must use a relative path: ${reference}`);
    }
    const file = path.resolve(root, localReference.split(/[?#]/u, 1)[0]);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error(`Mobile asset path escapes web bundle: ${reference}`);
    const relative = path.relative(root, file);
    let cursor = root;
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.length === 0) throw new Error(`Mobile asset is not a file: ${reference}`);
    for (const [index, part] of parts.entries()) {
      cursor = path.join(cursor, part);
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) throw new Error(`Mobile asset path contains a symbolic link: ${reference}`);
      const final = index === parts.length - 1;
      if (final ? !entry.isFile() : !entry.isDirectory()) {
        throw new Error(final ? `Mobile asset is not a file: ${reference}` : `Mobile asset path is not a directory: ${reference}`);
      }
    }
  }

  if (mode !== undefined) {
    const scripts = await Promise.all(references
      .filter((reference) => /\.m?js(?:[?#]|$)/iu.test(reference))
      .map((reference) => readRegularFile(path.resolve(root, localBundleReference(reference, mode).split(/[?#]/u, 1)[0]), { message: "Mobile JavaScript bundle must be a regular file" })));
    if (scripts.length === 0) throw new Error("Mobile web bundle contains no JavaScript entry");
    const bundle = scripts.join("\n");
    if (!bundle.includes("mobile-shell")) throw new Error("Mobile bundle is missing the Mobile shell entry");

    const hasNativeBridge = bundle.includes("CodexiaAuth");
    if (mode === "native") {
      if (!hasNativeBridge) throw new Error("Native mobile entry is missing the CodexiaAuth native API bridge");
      const apiOrigin = nativeApiOrigin(env);
      if (!apiOrigin) throw new Error("Native API origin is not configured for distribution");
      const readerOrigin = nativeReaderOrigin(env);
      const oauth = nativeOAuthConfig(env);
      if (!oauth) throw new Error("Native iOS public client ID is not configured for distribution");
      for (const [label, expected] of [
        ["API origin", apiOrigin],
        ["iOS public client ID", oauth.clientId],
        ["API audience", oauth.apiAudience],
      ]) {
        if (!bundle.includes(expected)) throw new Error(`Native web bundle is missing configured ${label}`);
      }
      const configuredReaderOrigin = env.VITE_CODEXIA_PUBLIC_READER_ORIGIN?.trim();
      if (readerOrigin && configuredReaderOrigin && !bundle.includes(configuredReaderOrigin) && !bundle.includes(readerOrigin)) {
        throw new Error("Native web bundle is missing configured public reader origin");
      }
    } else if (hasNativeBridge) {
      throw new Error("Mobile Web bundle contains an unexpected native API bridge");
    }
  }

  return { references: references.length };
}

function localBundleReference(reference, mode) {
  return mode === "web" && reference.startsWith("/mobile/")
    ? reference.slice("/mobile/".length)
    : reference;
}

async function main() {
  const directory = process.argv[2];
  const mode = process.argv[3];
  if (!directory || (mode !== undefined && mode !== "native" && mode !== "web")) {
    throw new Error("Usage: node validate-web-bundle.mjs <web-directory> [native|web]");
  }
  console.log(JSON.stringify(await validateWebBundle(directory, mode ? { mode } : undefined)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
