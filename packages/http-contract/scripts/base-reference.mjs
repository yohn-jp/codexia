import { readFileSync } from "node:fs";

const SHA1_COMMIT = /^[0-9a-f]{40}$/iu;

/** Select the approved comparison base without following mutable PR branch names. */
export function selectBaseReference(environment = process.env) {
  if (environment.CODEXIA_OASDIFF_BASE_REF) return environment.CODEXIA_OASDIFF_BASE_REF;

  if (environment.GITHUB_EVENT_NAME === "pull_request") {
    if (!environment.GITHUB_EVENT_PATH) throw new Error("missing GITHUB_EVENT_PATH for pull request oasdiff base selection");
    let event;
    try {
      event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, "utf8"));
    } catch (error) {
      throw new Error(`unable to read pull request event for oasdiff base selection: ${error.message}`);
    }
    const baseSha = event?.pull_request?.base?.sha;
    if (typeof baseSha !== "string" || !SHA1_COMMIT.test(baseSha)) {
      throw new Error("invalid pull request base SHA in GitHub event payload");
    }
    return baseSha.toLowerCase();
  }

  if (environment.GITHUB_EVENT_NAME === "push") return "HEAD^";
  return "origin/main";
}
