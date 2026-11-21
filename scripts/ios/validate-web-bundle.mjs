#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inspectHtml } from "../html-document.mjs";

export async function validateWebBundle(directory) {
  const root = path.resolve(directory);
  const indexFile = path.join(root, "index.html");
  const html = await readRegularFile(indexFile, "Native index.html must be a regular file");
  if (!/<!doctype html>/iu.test(html)) throw new Error("Native web bundle is missing its HTML document type");
  if (/https?:\/\//iu.test(html) || /server\.url/iu.test(html)) throw new Error("Native web bundle must not load a remote server URL");
  const references = inspectHtml(html).references;
  if (references.length === 0) throw new Error("Native web bundle contains no linked assets");
  for (const reference of references) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/iu.test(reference)) {
      throw new Error(`Native asset must use a relative path: ${reference}`);
    }
    const file = path.resolve(root, reference.split(/[?#]/u, 1)[0]);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error(`Native asset path escapes web bundle: ${reference}`);
    const relative = path.relative(root, file);
    let cursor = root;
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.length === 0) throw new Error(`Native asset is not a file: ${reference}`);
    for (const [index, part] of parts.entries()) {
      cursor = path.join(cursor, part);
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) throw new Error(`Native asset path contains a symbolic link: ${reference}`);
      const final = index === parts.length - 1;
      if (final ? !entry.isFile() : !entry.isDirectory()) {
        throw new Error(final ? `Native asset is not a file: ${reference}` : `Native asset path is not a directory: ${reference}`);
      }
    }
  }
  return { references: references.length };
}

async function readRegularFile(file, message) {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) throw new Error(message);
    return await handle.readFile("utf8");
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "EMLINK") throw new Error(message);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function main() {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: node validate-web-bundle.mjs <web-directory>");
  console.log(JSON.stringify(await validateWebBundle(directory)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
