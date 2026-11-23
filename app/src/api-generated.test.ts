import assert from "node:assert/strict";
import { test } from "node:test";
import { api, setOAuthAccessToken } from "./api.js";
import { getPersistenceStatusGetUrl } from "./generated/http/client.js";

test("generated persistence status uses the authenticated transport and preserves response errors", async (t) => {
  const controller = new AbortController();
  let respond = () => Response.json({ available: false, provider: null, future: "retained" });
  const fetch = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, getPersistenceStatusGetUrl());
    assert.equal(url, "/api/v1/persistence/status");
    assert.equal(init.method, "GET");
    assert.equal(init.signal, controller.signal);
    assert.equal(init.credentials, "omit");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer short-lived-token");
    return respond();
  });

  setOAuthAccessToken("short-lived-token");
  t.after(() => setOAuthAccessToken(null));
  assert.deepEqual(await api.persistenceStatus(controller.signal), {
    available: false,
    provider: null,
    future: "retained",
  });

  respond = () => Response.json({ available: false, provider: "unknown" });
  await assert.rejects(api.persistenceStatus(controller.signal), { status: 502, code: "INVALID_RESPONSE" });
  respond = () => Response.json({ error: "Persistence is unavailable", code: "PERSISTENCE_UNAVAILABLE" }, { status: 503 });
  await assert.rejects(api.persistenceStatus(controller.signal), { status: 503, code: "PERSISTENCE_UNAVAILABLE" });
  respond = () => { throw controller.signal.reason; };
  controller.abort();
  await assert.rejects(api.persistenceStatus(controller.signal), (error) => error === controller.signal.reason);
  assert.equal(fetch.mock.callCount(), 4);
});
