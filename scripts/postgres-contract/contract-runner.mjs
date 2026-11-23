import { createHash } from "node:crypto";
import path from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");

export function parseTapOutput(output) {
  if (typeof output !== "string") throw new TypeError("pgTAP output must be text");
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const plans = lines.filter((line) => /^1\.\.\d+$/u.test(line));
  const results = lines.filter((line) => /^(?:ok|not ok) \d+ - /u.test(line));
  if (plans.length !== 1) throw new Error(`Expected exactly one pgTAP plan, observed ${plans.length}`);
  const planned = Number(plans[0].slice(3));
  if (!Number.isSafeInteger(planned) || planned < 1) throw new Error("pgTAP plan must contain at least one assertion");
  if (results.length !== planned) throw new Error(`pgTAP planned ${planned} assertions but executed ${results.length}`);
  const failed = [];
  for (const [index, line] of results.entries()) {
    const match = /^(ok|not ok) (\d+) - (.*)$/u.exec(line);
    const resultNumber = Number(match?.[2]);
    if (resultNumber !== index + 1) throw new Error(`pgTAP assertion numbering is not contiguous at ${line}`);
    if (match?.[1] === "not ok" || /#\s*SKIP\b/iu.test(line)) failed.push(line);
  }
  if (failed.length) throw new Error(`pgTAP reported ${failed.length} failed assertion${failed.length === 1 ? "" : "s"}: ${failed.join(" | ")}`);
  return { planned, executed: results.length, failed };
}

export function buildSourceIdentity({ sourceSha, files }) {
  if (!/^[a-f0-9]{40}$/u.test(sourceSha ?? "")) throw new Error("Source identity requires a full Git commit SHA");
  if (!Array.isArray(files) || files.length === 0) throw new Error("Source identity requires input files");
  const seen = new Set();
  const entries = files.map(({ path: filePath, contents }) => {
    if (typeof filePath !== "string" || path.isAbsolute(filePath) ||
        filePath.split(/[\\/]/u).some((part) => part === ".." || part === "")) {
      throw new Error("Source identity input paths must be safe repository-relative paths");
    }
    if (seen.has(filePath)) throw new Error(`Duplicate source identity path: ${filePath}`);
    seen.add(filePath);
    if (typeof contents !== "string" && !Buffer.isBuffer(contents)) throw new TypeError(`Source identity input is not text: ${filePath}`);
    return { path: filePath, sha256: digest(contents) };
  }).sort((left, right) => left.path.localeCompare(right.path, "en"));
  return { sourceSha, files: entries, filesSha256: digest(JSON.stringify(entries)) };
}

export function assertCatalogMatches(expected, actual) {
  const difference = firstDifference(expected, actual, "$catalog");
  if (difference) throw new Error(`pg_catalog differs from reviewed physical contract at ${difference}`);
}

function firstDifference(expected, actual, location) {
  if (Object.is(expected, actual)) return undefined;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return location;
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(expected[index], actual[index], `${location}[${index}]`);
      if (difference) return difference;
    }
    return undefined;
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) return location;
    for (const key of expectedKeys) {
      const difference = firstDifference(expected[key], actual[key], `${location}.${key}`);
      if (difference) return difference;
    }
    return undefined;
  }
  return location;
}
