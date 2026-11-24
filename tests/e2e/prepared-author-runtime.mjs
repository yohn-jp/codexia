import { setOAuthAccessToken } from "../../app/src/api.ts";

// This module is an input only to the disposable fixture's Vite config.
// The binding is one-shot and document-bound; the token is never in a file,
// query string, storageState, browser storage or production entry.
export async function prepareAuthorRuntime() {
  const claim = window.__codexiaClaimPreparedAuthor;
  if (typeof claim !== "function") throw new Error("No prepared author token handoff");
  const token = await claim();
  if (typeof token !== "string" || !token) throw new Error("Prepared author token missing");
  setOAuthAccessToken(token);
}
