import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ActionDescriptor, ActionResult, SnapshotId } from "@codexia/contracts";
import { z } from "zod";
import type { McpActionClient } from "./api-client.js";
import { registerMcpTools } from "./tools.js";

const snapshot: SnapshotId = { projectId: "project-one", projectVersion: 7 };
type RegisteredTool = {
  schema: Record<string, z.ZodTypeAny>;
  handler(args: Record<string, unknown>, extra: { signal: AbortSignal }): Promise<unknown>;
};

function setup(actions: ActionDescriptor[], respond: (id: string, input: unknown) => ActionResult) {
  const tools = new Map<string, RegisteredTool>();
  const server = { tool(name: string, _description: string, schema: Record<string, z.ZodTypeAny>, handler: RegisteredTool["handler"]) {
    assert(!tools.has(name), `duplicate tool registration: ${name}`);
    tools.set(name, { schema, handler });
  } } as unknown as McpServer;
  const calls: Array<{ id: string; input: unknown }> = [];
  const client: McpActionClient = {
    projectId: "project-one",
    async listActions() { return actions; },
    async invoke(id, input) { calls.push({ id, input }); return respond(id, input); },
    async propose() { throw new Error("unexpected proposal transport"); },
  };
  registerMcpTools(server, client);
  return { tools, calls };
}

const descriptor = (id: string, module: ActionDescriptor["module"], effect: ActionDescriptor["effect"] = "compute"): ActionDescriptor => ({ id, module, effect });

test("search_lexical works without Semantic and delegates bounded non-semantic search", async () => {
  const { tools, calls } = setup([descriptor("search.query", "search")], () => ({
    ok: true, snapshot, data: { results: [], semanticResults: [], warnings: [] },
  }));
  assert(tools.has("search"));
  assert(tools.has("search_lexical"));
  const result = await tools.get("search_lexical")!.handler({ query: "river", mode: "prefix", limit: 4 }, { signal: new AbortController().signal });
  assert.deepEqual(calls, [{ id: "search.query", input: { query: "river", limit: 4, mode: "prefix", includeSemantic: false } }]);
  assert.deepEqual((result as { structuredContent: { data: unknown } }).structuredContent.data, { results: [], semanticResults: [], warnings: [] });
});

test("search_lexical requests semantic enrichment only when opted in and preserves Search unavailability", async () => {
  const enabled = setup([descriptor("search.query", "search")], () => ({
    ok: true, snapshot, data: { results: [{ path: "story/a.md" }], semanticResults: [], warnings: ["semantic_unavailable:MODULE_UNAVAILABLE"] },
  }));
  const result = await enabled.tools.get("search_lexical")!.handler({ query: "river", include_semantic: true }, { signal: new AbortController().signal });
  assert.deepEqual(enabled.calls[0], { id: "search.query", input: { query: "river", includeSemantic: true } });
  assert.deepEqual((result as { structuredContent: { data: { warnings: string[] } } }).structuredContent.data.warnings, ["semantic_unavailable:MODULE_UNAVAILABLE"]);

  const disabled = setup([], () => { throw new Error("unavailable Search must not be invoked"); });
  const failure = await disabled.tools.get("search_lexical")!.handler({ query: "river" }, { signal: new AbortController().signal });
  assert.equal((failure as { isError: boolean }).isError, true);
  assert.equal((failure as { structuredContent: { error: { code: string } } }).structuredContent.error.code, "MODULE_UNAVAILABLE");
  assert.deepEqual(disabled.calls, []);
});

test("legacy search retains semantic action ID and Story Context preserves producer output", async () => {
  const payload = { parts: [{ kind: "excerpt", value: "text" }], omitted: 3, budgetUnit: "characters", producerExtension: { revision: 2 } };
  const { tools, calls } = setup([
    descriptor("search.query", "search"), descriptor("semantic.search", "semantic"),
    descriptor("story.context.package", "story", "read"),
  ], (id) => ({ ok: true, snapshot, data: id === "story.context.package" ? payload : { results: [] } }));
  await tools.get("search")!.handler({ query: "river", limit: 3 }, { signal: new AbortController().signal });
  const context = await tools.get("story.context.package")!.handler({ scene_id: "scene-1", scope: "reader" }, { signal: new AbortController().signal });
  assert.equal(calls[0]!.id, "semantic.search");
  assert.deepEqual(calls[1], { id: "story.context.package", input: { sceneId: "scene-1", scope: "reader" } });
  assert.deepEqual((context as { structuredContent: { data: unknown } }).structuredContent.data, payload);
});

test("Scenario adapters map source fingerprints and keep saves and adoption as proposal actions", async () => {
  const { tools, calls } = setup([
    descriptor("story.scenario.compare", "story", "read"), descriptor("story.scenario.save", "story", "propose"),
    descriptor("story.scenario.adopt", "story", "propose"),
  ], (id) => ({ ok: true, snapshot, data: { id } }));
  const fingerprint = "a".repeat(64);
  const alternatives = [
    { label: "A", events: [{ kind: "location", subject: "char-1", object: "loc-1" }] },
    { label: "B", events: [] },
  ];
  const schema = z.object(tools.get("story.scenario.compare")!.schema);
  assert.equal(schema.safeParse({ scene_id: "scene-1", alternatives: [alternatives[0], alternatives[1], alternatives[0]] }).success, false);
  const saveSchema = z.object(tools.get("story.scenario.save")!.schema);
  assert.equal(saveSchema.safeParse({ scene_id: "scene-1", label: "Fork", source_fingerprint: "stale", alternatives }).success, false);
  assert.equal(calls.length, 0, "invalid input schema must be rejected before the action handler runs");
  await tools.get("story.scenario.save")!.handler({ scene_id: "scene-1", label: "Fork", source_fingerprint: fingerprint, alternatives, operation_id: "op-1" }, { signal: new AbortController().signal });
  await tools.get("story.scenario.adopt")!.handler({ id: "scenario-1", alternative_index: 1, source_fingerprint: fingerprint }, { signal: new AbortController().signal });
  assert.deepEqual(calls, [
    { id: "story.scenario.save", input: { sceneId: "scene-1", label: "Fork", sourceFingerprint: fingerprint, alternatives, operation_id: "op-1" } },
    { id: "story.scenario.adopt", input: { id: "scenario-1", alternativeIndex: 1, sourceFingerprint: fingerprint } },
  ]);
});
