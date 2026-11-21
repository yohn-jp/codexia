import assert from "node:assert/strict";
import { test } from "node:test";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { continueOAuthLogin, hasSignedOAuthPrompt, oauthConsentContinuationURL, oauthLoginCallbackURL } from "./oauth-login.js";

test("OAuth login requires one opaque signed authorization request", () => {
  const prompt = new URLSearchParams({
    sig: "signed-prompt",
    exp: "1790000000",
    client_id: "codexia-web-public",
    redirect_uri: "https://codexia.example.test/desktop",
    state: "request-state",
  });
  assert.equal(hasSignedOAuthPrompt(`?${prompt}`), true);
  assert.equal(hasSignedOAuthPrompt(`?${prompt}&state=ambiguous`), false);
  prompt.delete("sig");
  assert.equal(hasSignedOAuthPrompt(`?${prompt}`), false);
  assert.equal(hasSignedOAuthPrompt("%invalid"), false);
});

test("upstream sign-in preserves the signed prompt on the fixed same-origin return route", async () => {
  let request: { provider: string; callbackURL: string } | undefined;
  const search = "?client_id=web&redirect_uri=%2Fdesktop&state=s&exp=1790000000&sig=opaque&ba_param=client_id&ba_param=redirect_uri&ba_param=state&ba_param=exp";
  await continueOAuthLogin({
    signIn: { social: async (input) => { request = input; return {}; } },
  }, search);
  assert.deepEqual(request, { provider: "workspace-oidc", callbackURL: `/oauth/login${search}` });
  assert.equal(oauthLoginCallbackURL(search), `/oauth/login${search}`);
  assert.equal(oauthConsentContinuationURL(search), `/oauth/consent${search}`);
  assert.equal(new URL(oauthLoginCallbackURL(`${search}&callbackURL=https://attacker.example`), "https://codexia.example.test").pathname, "/oauth/login");
  assert.equal(new URL(oauthConsentContinuationURL(`${search}&callbackURL=https://attacker.example`), "https://codexia.example.test").pathname, "/oauth/consent");
  assert.throws(() => oauthLoginCallbackURL("?client_id=web&state=s"), /invalid/u);
  assert.throws(() => oauthConsentContinuationURL("?client_id=web&state=s"), /invalid/u);
});

test("upstream sign-in errors are surfaced without exposing provider details", async () => {
  await assert.rejects(continueOAuthLogin({
    signIn: { social: async () => ({ error: { message: "private provider response" } }) },
  }, "?sig=s&exp=1&client_id=c&redirect_uri=%2F&state=s"), /Sign-in could not be started/u);
});

test("official Better Auth client forwards only the signed authorization query", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const signed = new URLSearchParams([
    ["client_id", "codexia-web-public"],
    ["redirect_uri", "https://codexia.example.test/desktop"],
    ["state", "request-state"],
    ["exp", "1790000000"],
    ["sig", "signed-prompt"],
    ["ba_param", "client_id"],
    ["ba_param", "redirect_uri"],
    ["ba_param", "state"],
    ["ba_param", "exp"],
  ]);
  signed.append("untrusted_extra", "must-not-be-forwarded");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { search: `?${signed}` } } });
  try {
    const plugin = oauthProviderClient().fetchPlugins[0]!;
    const context = {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({ providerId: "workspace-oidc" }),
    };
    await plugin.hooks.onRequest(context as never);
    const body = JSON.parse(context.body as string) as { oauth_query: string };
    const forwarded = new URLSearchParams(body.oauth_query);
    assert.equal(forwarded.get("sig"), "signed-prompt");
    assert.equal(forwarded.get("state"), "request-state");
    assert.equal(forwarded.has("untrusted_extra"), false);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
