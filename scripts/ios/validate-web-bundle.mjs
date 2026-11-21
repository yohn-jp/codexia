#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inspectHtml } from "../html-document.mjs";

export async function validateWebBundle(directory) {
  const root = path.resolve(directory);
  const html = await readFile(path.join(root, "index.html"), "utf8");
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
    await access(file);
  }
  return { references: references.length };
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
