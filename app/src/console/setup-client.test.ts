import assert from "node:assert/strict";
import test from "node:test";
import { authorizeOwnerSetup, completeOwnerSetup, getOwnerSetupStatus, setOwnerSetupProfile, SetupError } from "./setup-client.js";

test("owner setup adapters preserve same-origin transaction headers and no-store requests", async () => {
  const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ input, init });
    const path = String(input);
    if (path.endsWith("/status")) return Response.json({ state: "owner-enrolled", clientsReady: true });
    if (path.endsWith("/authorize")) return Response.json({ transaction: "signed-setup-transaction" });
    if (path.endsWith("/profile")) return Response.json({ transaction: "profiled-setup-transaction" });
    return Response.json({ state: "owner-enrolled", clientsReady: true, sessionConfirmed: true });
  };

  assert.deepEqual(await getOwnerSetupStatus(fetcher), { state: "owner-enrolled", clientsReady: true });
  assert.equal(await authorizeOwnerSetup("a".repeat(43), fetcher), "signed-setup-transaction");
  assert.equal(await setOwnerSetupProfile({ name: "Owner", email: "owner@example.test" }, "signed-setup-transaction", fetcher), "profiled-setup-transaction");
  const completed = await completeOwnerSetup("profiled-setup-transaction", fetcher) as Record<string, unknown>;
  assert.equal(completed.sessionConfirmed, true);
  assert.deepEqual(requests.map(({ input }) => String(input)), [
    "/api/auth/codexia/setup/status",
    "/api/auth/codexia/setup/authorize",
    "/api/auth/codexia/setup/profile",
    "/api/auth/codexia/setup/complete",
  ]);
  for (const { init } of requests) {
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("accept"), "application/json");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
  }
  assert.equal(requests[1]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), { key: "a".repeat(43) });
  assert.equal(new Headers(requests[2]?.init?.headers).get("x-codexia-setup-transaction"), "signed-setup-transaction");
  assert.equal(new Headers(requests[3]?.init?.headers).get("x-codexia-setup-transaction"), "profiled-setup-transaction");
});

test("owner setup adapter preserves rate-limit status for the setup flow", async () => {
  await assert.rejects(
    authorizeOwnerSetup("a".repeat(43), async () => Response.json({ code: "SETUP_RATE_LIMIT" }, { status: 429 })),
    (error: unknown) => error instanceof SetupError && error.status === 429,
  );
});
