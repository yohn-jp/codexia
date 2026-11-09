import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ChangeOperation } from "@codexia/contracts";
import { api, ApiError } from "./api.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const invalid = (error: unknown) => error instanceof ApiError && error.code === "INVALID_RESPONSE";

test("audit browser API rejects malformed, empty and incorrectly shaped successful session responses", async () => {
  for (const response of [new Response("not json"), Response.json(null), Response.json({}), new Response(null, { status: 204 }), Response.json({ authenticated: true, authorScope: 5 })]) {
    globalThis.fetch = async () => response;
    await assert.rejects(api.session(), invalid);
  }
  globalThis.fetch = async () => Response.json({ authenticated: true, authorScope: "owner", permissions: ["read", "write"], futureField: true });
  assert.equal((await api.session()).authorScope, "owner");
});

test("audit browser API rejects a partial runtime-version DTO rather than configuring refresh from it", async () => {
  globalThis.fetch = async () => Response.json({ hosted: true });
  await assert.rejects(api.version(), invalid);
});

test("audit browser API validates PostgreSQL apply receipts before recovery accepts them", async () => {
  const operation: ChangeOperation = { id: "op-1", generation: 0, effect: "manuscript", message: "save", projectId: "project-1", baseProjectVersion: 1, reads: [], writes: [{ path: "documents/a.md", revision: null, content: "text" }] };
  for (const receipt of [{ operationId: "op-1", generation: "0", projectVersion: 2, revisions: [] }, { operationId: "op-1", generation: 0, projectVersion: 0, revisions: [] }, { operationId: "op-1", generation: 0, localCommit: "b".repeat(40), revisions: [] }]) {
    globalThis.fetch = async () => Response.json(receipt);
    await assert.rejects(api.apply("project-1", operation), invalid);
  }
  globalThis.fetch = async () => Response.json({ operationId: "op-1", generation: 0, projectVersion: 2, revisions: [] });
  assert.equal((await api.apply("project-1", operation)).projectVersion, 2);
});

test("audit browser API preserves service errors and permits 204 only for no-content endpoints", async () => {
  globalThis.fetch = async () => new Response("temporarily unavailable", { status: 503 });
  await assert.rejects(api.session(), (error: unknown) => error instanceof ApiError && error.status === 503);
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await api.deletePersistenceDocument("project-1", "document-1", 1), undefined);
  await assert.rejects(api.persistenceProjects(), invalid);
});

test("audit browser API rejects successful actions missing their required opaque payload", async () => {
  const snapshot = { projectId: "project-1", projectVersion: 1 };
  globalThis.fetch = async () => Response.json({ ok: true, snapshot });
  await assert.rejects(api.action("project-1", "core.document.resolve", {}), invalid);
  globalThis.fetch = async () => Response.json({ ok: true, snapshot, data: null });
  const result = await api.action("project-1", "core.document.resolve", {});
  assert.equal(result.ok && result.data, null);
});

test("audit browser API rejects jobs missing their required opaque result", async () => {
  const job = { id: "job-1", type: "fixture", status: "done", progress: 1, error: null, createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:00Z", finishedAt: null };
  globalThis.fetch = async () => Response.json([job]);
  await assert.rejects(api.jobs(), invalid);
  globalThis.fetch = async () => Response.json([{ ...job, result: null }]);
  assert.equal((await api.jobs())[0]?.result, null);
});
