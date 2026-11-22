import assert from "node:assert/strict";
import test from "node:test";
import type { ChangeOperation, ProjectObservation, SnapshotId } from "@codexia/contracts";
import { ApiClient } from "./api-client.js";

const snapshot: SnapshotId = {
  projectId: "repo-one",
  projectVersion: 12,
};

test("stdio API client uses bearer actions and host-sourced proposals only", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const observation: ProjectObservation = {
    snapshot,
    observedAt: "2026-10-17T00:00:00.000Z",
    state: "fresh",
  };
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/projects")) {
      return Response.json([{ id: "project-one", title: "One" }]);
    }
    if (url.endsWith("/actions")) {
      return Response.json({ actions: [{ id: "core.status", module: "core", effect: "read" }] });
    }
    if (url.endsWith("/observation")) return Response.json(observation);
    if (url.endsWith("/proposals")) {
      return Response.json({ id: "proposal-1", snapshot, operations: [], source: "mcp" });
    }
    if (url.endsWith("/actions/core.status")) {
      return Response.json({ ok: true, snapshot, data: { status: "ready" } });
    }
    return Response.json({ error: "missing" }, { status: 404 });
  };
  const client = new ApiClient({
    baseUrl: "https://codexia.test/",
    token: "test-token",
    projectId: "project-one",
    fetch: fetcher,
  });

  assert.deepEqual(await client.listActions(), [{ id: "core.status", module: "core", effect: "read" }]);
  assert.deepEqual(await client.listProjects(), [
    { id: "project-one", title: "One" },
  ]);
  assert.deepEqual(await client.forProject("project-two").listActions(), [
    { id: "core.status", module: "core", effect: "read" },
  ]);
  assert.deepEqual(await client.invoke("core.status", {}), { ok: true, snapshot, data: { status: "ready" } });
  const operation = { id: "op-one" } as ChangeOperation;
  const proposal = await client.propose([operation], undefined, "source-change-set-1");

  assert.equal(proposal.source, "mcp");
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/api/projects/project-one/actions",
    "/api/projects",
    "/api/projects/project-two/actions",
    "/api/projects/project-one/actions/core.status",
    "/api/projects/project-one/observation",
    "/api/projects/project-one/proposals",
  ]);
  for (const call of calls) {
    assert.equal(new Headers(call.init.headers).get("authorization"), "Bearer test-token");
  }
  const body = JSON.parse(String(calls.at(-1)?.init.body)) as Record<string, unknown>;
  assert.deepEqual(body, { id: "source-change-set-1", snapshot, operations: [operation] });
  assert.equal("source" in body, false);
});

test("stdio action client can read Story context without Assistant actions", async () => {
  const calls: string[] = [];
  const payload = { sceneId: "scene-one", scope: "reader", parts: [{ kind: "reader-disclosure" }] };
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/actions")) return Response.json({ actions: [{ id: "story.context.package", module: "story", effect: "read" }] });
    const actionId = path.split("/actions/")[1];
    calls.push(actionId ?? "");
    return Response.json({ ok: true, snapshot, data: payload });
  };
  const client = new ApiClient({ baseUrl: "https://codexia.test", token: "test-token", projectId: "project-one", fetch: fetcher });

  const actions = await client.listActions();
  assert.deepEqual(actions.map((action) => action.id), ["story.context.package"]);
  const result = await client.invoke("story.context.package", { sceneId: "scene-one", scope: "reader" });
  assert.deepEqual(result, { ok: true, snapshot, data: payload });
  assert.deepEqual(calls, ["story.context.package"]);
});

test("stdio API client can bind a requested owner project", async () => {
  const client = new ApiClient({ baseUrl: "http://127.0.0.1:3000", token: "token", projectId: "project-one" });
  assert.equal(client.forProject("project-two").projectId, "project-two");
});

test("stdio API client follows bounded project pages and accepts the legacy array response", async () => {
  const calls: string[] = [];
  const cursor = Buffer.from(JSON.stringify({ updatedAt: "2026-11-20T00:00:00.000Z", id: "00000000-0000-4000-8000-000000000001" })).toString("base64url");
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const query = new URL(url).searchParams;
    if (query.get("cursor") === cursor) return Response.json({ projects: [{ id: "project-two", title: "Two" }], nextCursor: null });
    return Response.json({ projects: [{ id: "project-one", title: "One" }], nextCursor: cursor });
  };
  const client = new ApiClient({ baseUrl: "https://codexia.test", token: "test-token", fetch: fetcher });
  const first = await client.listProjectPage(1);
  assert.deepEqual(first.projects, [{ id: "project-one", title: "One" }]);
  assert.equal(first.nextCursor, cursor);
  const second = await client.listProjectPage(1, first.nextCursor ?? undefined);
  assert.deepEqual(second, { projects: [{ id: "project-two", title: "Two" }], nextCursor: null });
  assert.equal(new URL(calls[0]!).searchParams.get("page"), "1");
  assert.equal(new URL(calls[0]!).searchParams.get("limit"), "1");
  assert.equal(new URL(calls[1]!).searchParams.get("cursor"), cursor);

  const legacy = new ApiClient({ baseUrl: "https://codexia.test", token: "test-token", fetch: async () => Response.json([{ id: "project-one", title: "One" }]) });
  assert.deepEqual(await legacy.listProjectPage(), { projects: [{ id: "project-one", title: "One" }], nextCursor: null });
});

test("stdio API client forwards MCP cancellation to each fetch", async () => {
  const observed: Array<AbortSignal | null | undefined> = [];
  const fetcher: typeof fetch = async (_input, init = {}) => {
    observed.push(init.signal);
    return Response.json({ actions: [] });
  };
  const client = new ApiClient({
    baseUrl: "https://codexia.test",
    token: "test-token",
    projectId: "project-one",
    fetch: fetcher,
  });
  const controller = new AbortController();
  await client.listActions(controller.signal);
  await client.invoke("core.status", {}, controller.signal);
  assert.deepEqual(observed, [controller.signal, controller.signal]);
});
