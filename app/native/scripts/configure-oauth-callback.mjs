import { readFile, writeFile } from "node:fs/promises";
import { CALLBACK_SCHEME } from "../plugins/codexia-auth/src/constants.mjs";

export function configureCallbackScheme(info) {
  const types = Array.isArray(info.CFBundleURLTypes) ? [...info.CFBundleURLTypes] : [];
  const alreadyPresent = types.some((entry) => Array.isArray(entry.CFBundleURLSchemes) && entry.CFBundleURLSchemes.includes(CALLBACK_SCHEME));
  if (!alreadyPresent) {
    types.push({
      CFBundleTypeRole: "Editor",
      CFBundleURLName: "jp.yohn.codexia.oauth",
      CFBundleURLSchemes: [CALLBACK_SCHEME],
    });
  }
  return { ...info, CFBundleURLTypes: types };
}

const plistPath = process.argv[2];
if (plistPath) {
  const { default: plist } = await import("plist");
  const info = plist.parse(await readFile(plistPath, "utf8"));
  await writeFile(plistPath, plist.build(configureCallbackScheme(info)), "utf8");
} else if (process.argv[1]?.endsWith("configure-oauth-callback.mjs")) {
  throw new Error("Usage: node scripts/configure-oauth-callback.mjs <Info.plist>");
}
