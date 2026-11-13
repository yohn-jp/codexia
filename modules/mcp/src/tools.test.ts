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
  const contextSchema = z.object(tools.get("story.context.package")!.schema);
  assert.equal(contextSchema.safeParse({ scene_id: "scene-1", scope: "reader", budget: 127 }).success, false);
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
  assert.equal(schema.safeParse({ scene_id: "scene-1", alternatives: [{ label: "A", events: [{ kind: "location", subject: "char-1", object: "loc-1", confidence: "invalid" }] }, alternatives[1]] }).success, false);
  assert.equal(schema.safeParse({ scene_id: "scene-1", alternatives: [{ label: "A", events: [{ kind: "location", subject: "char-1", object: "loc-1", payload: { text: "x".repeat(1_048_576) } }] }, alternatives[1]] }).success, false);
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

test("native Knowledge and Evidence tools expose typed names and delegate exact camelCase Action inputs", async () => {
  const ids = [
    "core.knowledge.nodes.list", "core.knowledge.node.get", "core.knowledge.aliases.list", "core.knowledge.relations.list",
    "core.evidence.anchor.get", "core.evidence.document.list", "core.evidence.node.list", "core.evidence.assertion.get", "core.evidence.assertion.list",
    "core.knowledge.propose", "core.changesets.list", "core.changeset.get", "core.knowledge.merge.preview", "core.knowledge.merge.propose",
  ];
  const { tools, calls } = setup(ids.map(id => descriptor(id, "core", id.endsWith(".propose") ? "propose" : "read")), (id, input) => ({ ok: true, snapshot, data: { id, input } }));
  const names = ids.map(id => id.replace(/^core\./u, ""));
  for (const name of names) assert(tools.has(name), `missing MCP tool ${name}`);

  await tools.get("knowledge.node.get")!.handler({ project_id: "project-one", node_id: "22222222-2222-4222-8222-222222222222", project_version: 7, related_limit: 12 }, { signal: new AbortController().signal });
  await tools.get("evidence.document.list")!.handler({ document_id: "33333333-3333-4333-8333-333333333333", revision_id: "44444444-4444-4444-8444-444444444444", limit: 8 }, { signal: new AbortController().signal });
  await tools.get("changeset.get")!.handler({ change_set_id: "55555555-5555-4555-8555-555555555555" }, { signal: new AbortController().signal });
  assert.deepEqual(calls, [
    { id: "core.knowledge.node.get", input: { nodeId: "22222222-2222-4222-8222-222222222222", projectVersion: 7, relatedLimit: 12 } },
    { id: "core.evidence.document.list", input: { documentId: "33333333-3333-4333-8333-333333333333", revisionId: "44444444-4444-4444-8444-444444444444", limit: 8 } },
    { id: "core.changeset.get", input: { changeSetId: "55555555-5555-4555-8555-555555555555" } },
  ]);
});

test("native MCP schemas bound UUID reads and accept only the seven ordinary native ChangeSet operations", async () => {
  const { tools, calls } = setup([descriptor("core.knowledge.propose", "core", "propose")], () => ({ ok: true, snapshot, data: {} }));
  const node = "22222222-2222-4222-8222-222222222222";
  const readSchema = z.object(tools.get("knowledge.node.get")!.schema);
  assert.equal(readSchema.safeParse({ node_id: "not-a-uuid" }).success, false);
  assert.equal(readSchema.safeParse({ node_id: node, related_limit: 1001 }).success, false);
  const proposalSchema = z.object(tools.get("knowledge.propose")!.schema);
  const ordinary = { type: "knowledge.node.save", command: { projectId: "66666666-6666-4666-8666-666666666666", id: node, type: "person", name: "Uma", attributes: {}, status: "proposed", expectedVersion: null } };
  assert.equal(proposalSchema.safeParse({ project_version: 7, idempotency_key: "once", operations: [ordinary] }).success, true);
  assert.equal(proposalSchema.safeParse({ project_version: 7, idempotency_key: "once", operations: [{ type: "knowledge.merge", command: {} }] }).success, false);
  assert.equal(proposalSchema.safeParse({ project_version: 7, idempotency_key: "once", operations: [ordinary, { ...ordinary, type: "unknown" }] }).success, false);
  assert.equal(proposalSchema.safeParse({ project_version: 7, idempotency_key: "once", operations: Array.from({ length: 51 }, () => ordinary) }).success, false);
  const oversized = { ...ordinary, command: { ...ordinary.command, attributes: { note: "x".repeat(65_000) } } };
  assert.equal(proposalSchema.safeParse({ project_version: 7, idempotency_key: "once", operations: [oversized] }).success, false);
  const anchor = { type: "evidence.anchor.save", command: { projectId: "66666666-6666-4666-8666-666666666666", id: node, documentId: node, revisionId: node, fromUtf16: 8, toUtf16: 4, quoteSha256: "a".repeat(64), status: "proposed", expectedVersion: null } };
  assert.equal(proposalSchema.safeParse({ project_version: 7, idempotency_key: "once", operations: [anchor] }).success, false);
  const accepted = await tools.get("knowledge.propose")!.handler({ project_version: 7, idempotency_key: "once", operations: [ordinary] }, { signal: new AbortController().signal });
  assert.deepEqual(calls, [{ id: "core.knowledge.propose", input: { projectVersion: 7, idempotencyKey: "once", operations: [ordinary] } }]);
  assert.equal((accepted as { isError?: boolean }).isError, undefined);
});

test("native merge tools require an observed digest and delegate read and proposal Actions only", async () => {
  const { tools, calls } = setup([
    descriptor("core.knowledge.merge.preview", "core", "read"), descriptor("core.knowledge.merge.propose", "core", "propose"),
  ], (id) => ({ ok: true, snapshot, data: { id } }));
  const source = "22222222-2222-4222-8222-222222222222";
  const target = "33333333-3333-4333-8333-333333333333";
  await tools.get("knowledge.merge.preview")!.handler({ source_id: source, target_id: target, project_version: 7 }, { signal: new AbortController().signal });
  const proposalSchema = z.object(tools.get("knowledge.merge.propose")!.schema);
  assert.equal(proposalSchema.safeParse({ source_id: source, target_id: target, project_version: 7, idempotency_key: "merge", preview_digest: "bad" }).success, false);
  const digest = "a".repeat(64);
  await tools.get("knowledge.merge.propose")!.handler({ source_id: source, target_id: target, project_version: 7, idempotency_key: "merge", preview_digest: digest }, { signal: new AbortController().signal });
  assert.deepEqual(calls, [
    { id: "core.knowledge.merge.preview", input: { sourceId: source, targetId: target, projectVersion: 7 } },
    { id: "core.knowledge.merge.propose", input: { sourceId: source, targetId: target, projectVersion: 7, idempotencyKey: "merge", previewDigest: digest } },
  ]);
});
