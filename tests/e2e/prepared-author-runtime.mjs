import { setOAuthAccessToken } from "../../app/src/api.ts";

// This module is included only by the disposable fixture Vite configuration.
// Normal author navigation/reauthentication has no pending claim; the actual
// product entry then runs without a prepared token. No credential is persisted.
export async function prepareAuthorRuntime() {
  const claim = window.__codexiaClaimPreparedAuthor;
  if (typeof claim !== "function") return;
  const token = await claim();
  if (token === null) return;
  if (typeof token !== "string" || !token) throw new Error("Prepared author token missing");
  setOAuthAccessToken(token);
}
