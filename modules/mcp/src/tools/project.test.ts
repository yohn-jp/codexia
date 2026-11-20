import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerProjectTools } from "./project.js";

test("list_projects returns and accepts its continuation cursor", async () => {
  const registered = new Map<string, (args: unknown, extra: { signal: AbortSignal }) => Promise<unknown>>();
  const server = {
    tool(name: string, _description: string, _schema: unknown, handler: (args: unknown, extra: { signal: AbortSignal }) => Promise<unknown>) {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  const cursor = "eyJ1cGRhdGVkQXQiOiJ0aW1lc3RhbXAiLCJpZCI6InByb2plY3QifQ";
  const requests: Array<{ limit: number; cursor?: string }> = [];
  registerProjectTools(server, {
    async listProjectPage(limit, after) {
      requests.push({ limit, ...(after ? { cursor: after } : {}) });
      return requests.length === 1
        ? { projects: [{ id: "project-one", title: "One" }], nextCursor: cursor }
        : { projects: [{ id: "project-two", title: "Two" }], nextCursor: null };
    },
    async listActions() { return []; },
    async invoke() { throw new Error("unused"); },
    async propose() { throw new Error("unused"); },
  });

  const listProjects = registered.get("list_projects");
  assert.ok(listProjects);
  const first = await listProjects({ limit: 1 }, { signal: new AbortController().signal }) as { structuredContent: { data: { projects: unknown[]; next_cursor: string } } };
  assert.deepEqual(first.structuredContent.data.projects, [{ id: "project-one", title: "One" }]);
  assert.equal(first.structuredContent.data.next_cursor, cursor);
  const second = await listProjects({ limit: 1, cursor }, { signal: new AbortController().signal }) as { structuredContent: { data: { projects: unknown[]; next_cursor: null } } };
  assert.deepEqual(second.structuredContent.data.projects, [{ id: "project-two", title: "Two" }]);
  assert.equal(second.structuredContent.data.next_cursor, null);
  assert.deepEqual(requests, [{ limit: 1 }, { limit: 1, cursor }]);
});
