import assert from "node:assert/strict";
import { test } from "node:test";
import { attemptNativeLogout } from "./nativeLogout";

test("native logout blocks the workspace and reports confirmed local and server logout", async () => {
  const events: string[] = [];
  const result = await attemptNativeLogout({
    protectDraft: async () => { events.push("protected"); return true; },
    blockWorkspace: () => { events.push("blocked"); },
    signOut: async () => ({ localCredentialsCleared: true, revoked: true }),
  });

  assert.deepEqual(result, { kind: "complete" });
  assert.deepEqual(events, ["protected", "blocked"]);
});

test("native logout reports an unconfirmed server revocation after clearing device credentials", async () => {
  const result = await attemptNativeLogout({
    protectDraft: async () => true,
    blockWorkspace: () => undefined,
    signOut: async () => ({ localCredentialsCleared: true, revoked: false }),
  });

  assert.equal(result.kind, "revocation-unconfirmed");
  if (result.kind === "revocation-unconfirmed") {
    assert.match(result.message, /端末の認証情報は消去しました/u);
    assert.match(result.message, /失効を確認できませんでした/u);
    assert.match(result.message, /再サインイン/u);
  }
});

test("native logout leaves the workspace blocked when device credential clearing is unconfirmed", async () => {
  const result = await attemptNativeLogout({
    protectDraft: async () => true,
    blockWorkspace: () => undefined,
    signOut: async () => ({ localCredentialsCleared: false, revoked: true }),
  });

  assert.equal(result.kind, "local-clear-unconfirmed");
  if (result.kind === "local-clear-unconfirmed") assert.match(result.message, /再試行/u);
});

test("native logout reports bridge exceptions without unblocking the workspace", async () => {
  const events: string[] = [];
  const result = await attemptNativeLogout({
    protectDraft: async () => true,
    blockWorkspace: () => { events.push("blocked"); },
    signOut: async () => { throw new Error("Native bridge unavailable"); },
  });

  assert.equal(result.kind, "error");
  assert.deepEqual(events, ["blocked"]);
  if (result.kind === "error") {
    assert.match(result.message, /ログアウトの結果を確認できませんでした/u);
    assert.match(result.message, /Native bridge unavailable/u);
  }
});

test("native logout never invokes the bridge or blocks the workspace for an unprotected draft", async () => {
  let signOutCalls = 0;
  let blockCalls = 0;
  const result = await attemptNativeLogout({
    protectDraft: async () => false,
    blockWorkspace: () => { blockCalls += 1; },
    signOut: async () => { signOutCalls += 1; return { localCredentialsCleared: true, revoked: true }; },
  });

  assert.deepEqual(result, { kind: "draft-unprotected" });
  assert.equal(signOutCalls, 0);
  assert.equal(blockCalls, 0);
});
