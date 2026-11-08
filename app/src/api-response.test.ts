import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeResponse, readApiResponse, responseContracts as dto } from "./api-response";
test("PostgreSQL responses fail closed on wrong provider, malformed revisions and non-JSON success", async () => {
  assert.equal(dto.persistenceStatus({ available: true, provider: "postgres" }), true);
  assert.equal(dto.persistenceStatus({ available: true, provider: "git" }), false);
  assert.equal(dto.persistenceWrite({ document: {}, revision: {}, replayed: true }), false);
  assert.throws(() => decodeResponse({ authenticated: true }, dto.session));
  await assert.rejects(readApiResponse(new Response("not JSON"), dto.persistenceStatus), /invalid JSON/);
});
