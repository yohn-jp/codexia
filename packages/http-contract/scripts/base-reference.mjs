import { readFileSync } from "node:fs";

const SHA1_COMMIT = /^[0-9a-f]{40}$/iu;

function readEvent(eventName, eventPath) {
  if (!eventPath) throw new Error(`missing GITHUB_EVENT_PATH for ${eventName} oasdiff base selection`);
  let event;
  try {
    event = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch (error) {
    throw new Error(`unable to read ${eventName} event for oasdiff base selection: ${error.message}`);
  }
  return event;
}

/** Select the approved comparison base without following mutable PR branch names. */
export function selectBaseReference(environment = process.env) {
  if (environment.CODEXIA_OASDIFF_BASE_REF) return environment.CODEXIA_OASDIFF_BASE_REF;

  if (environment.GITHUB_EVENT_NAME === "pull_request") {
    const baseSha = readEvent("pull request", environment.GITHUB_EVENT_PATH)?.pull_request?.base?.sha;
    if (typeof baseSha !== "string" || !SHA1_COMMIT.test(baseSha)) {
      throw new Error("invalid pull request base SHA in GitHub event payload");
    }
    return baseSha.toLowerCase();
  }

  if (environment.GITHUB_EVENT_NAME === "push") {
    const beforeSha = readEvent("push", environment.GITHUB_EVENT_PATH)?.before;
    if (typeof beforeSha !== "string" || !SHA1_COMMIT.test(beforeSha) || /^0+$/u.test(beforeSha)) {
      throw new Error("invalid push before SHA in GitHub event payload");
    }
    return beforeSha.toLowerCase();
  }

  return "origin/main";
}

/** Resolve the exact event SHA, fetching it from origin when a shallow checkout lacks it. */
export function resolveBaseCommit(reference, runGit) {
  const local = runGit(["rev-parse", "--verify", `${reference}^{commit}`]);
  if (local.status === 0) return local.stdout.trim();

  const fetchTarget = reference.startsWith("origin/") ? reference.slice("origin/".length) : reference;
  if (!reference.startsWith("origin/") && !SHA1_COMMIT.test(reference)) {
    throw new Error(`unable to resolve oasdiff base commit ${reference}: ${local.stderr || local.stdout}`);
  }

  const fetched = runGit(["fetch", "--no-tags", "--depth=1", "origin", fetchTarget]);
  if (fetched.status !== 0) {
    throw new Error(`unable to fetch oasdiff base ${reference}: ${fetched.stderr || fetched.stdout}`);
  }
  const resolved = runGit(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
  const baseSha = resolved.stdout.trim();
  if (resolved.status !== 0 || !SHA1_COMMIT.test(baseSha) || (SHA1_COMMIT.test(reference) && baseSha !== reference)) {
    throw new Error(`unable to resolve exact oasdiff base SHA ${reference}: ${resolved.stderr || resolved.stdout}`);
  }
  return baseSha;
}
